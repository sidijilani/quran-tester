'use strict';
importScripts('assets/vendor/onnxruntime-1.30.0/ort.wasm.min.js','recite-core.js','recite-tracker.js','recite-fbank.js');
let session, feeds, fbank, decoder, tracker, frames=[], queue=[], busy=false, boundarySent=false;
let trackerGeneration=0, trackerOffset=0, reanchor=null;
let recentEmissions=[];
let tokenTable;
function contract() {
  const shapes={};
  // Zipformer2's six stacks have 2/2/3/4/3/2 layers. Each layer has six caches.
  const stacks=[[2,256,192,128,48,15],[2,128,256,128,48,15],
    [3,64,384,128,48,7],[4,32,512,256,96,7],
    [3,64,384,128,48,7],[2,128,256,128,48,15]];
  let i=0;
  for(const [layers,context,dim,key,value,conv] of stacks) for(let j=0;j<layers;j++,i++) {
    shapes['cached_key_'+i]=[context,1,key];
    shapes['cached_nonlin_attn_'+i]=[1,1,context,dim*3/4];
    shapes['cached_val1_'+i]=[context,1,value]; shapes['cached_val2_'+i]=[context,1,value];
    shapes['cached_conv1_'+i]=[1,dim,conv]; shapes['cached_conv2_'+i]=[1,dim,conv];
  }
  shapes.embed_states=[1,128,3,19];
  return shapes;
}
function reset(table) {
  fbank=new ReciteFbank(); decoder=new ReciteCore.CTC(table); feeds={}; frames=[]; queue=[];
  boundarySent=false;recentEmissions=[];
  for(const [name,shape] of Object.entries(contract())) feeds[name]=new ort.Tensor('float32',new Float32Array(shape.reduce((a,b)=>a*b,1)),shape);
  feeds.processed_lens=new ort.Tensor('int64',new BigInt64Array([0n]),[1]);
}
async function drain() {
  if(busy || !session) return;
  busy=true;
  try {
    while(queue.length) {
      if(reanchor && tracker) {
        if(reanchor.resetAudio) {
          const pending=queue;
          for(const tensor of Object.values(feeds))tensor.dispose();
          reset(tokenTable);queue=pending;
        }
        if(reanchor.words) {
          tracker=reanchor.preserve?tracker.shiftWindow(reanchor.words,reanchor.offset-trackerOffset):new ReciteTracker(reanchor.words,reanchor.index);
          trackerOffset=reanchor.offset;
        } else tracker.restart(reanchor.index);
        trackerGeneration=reanchor.generation;
        reanchor=null;boundarySent=false;
      }
      const packet=queue.shift();
      if(packet.generation!==undefined && packet.generation!==trackerGeneration)continue;
      const samples=packet.samples;
      const packetStart=performance.now();let inferenceMs=0;
      frames.push(...fbank.push(samples));
      const emissions=[];
      while(frames.length>=61) {
        const input=new Float32Array(61*80);
        frames.slice(0,61).forEach((f,i)=>input.set(f,i*80));
        const start=performance.now();
        const x=new ort.Tensor('float32',input,[1,61,80]);
        const output=await session.run({...feeds,x}); x.dispose();
        if(!output.log_probs || output.log_probs.dims.at(-1)!==251) throw Error('Unexpected model logits.');
        const data=output.log_probs.data;
        for(let i=0;i<data.length;i+=251) {
          const e=decoder.frame(data.subarray(i,i+251)); if(e) emissions.push(e);
        }
        for(const name of Object.keys(feeds)) {
          feeds[name].dispose(); feeds[name]=output['new_'+name];
        }
        output.log_probs.dispose();
        frames.splice(0,48);
        inferenceMs+=performance.now()-start;
      }
      // Prompter settles after 25 decoded CTC frames (about one second).
      // A fixed microphone-volume cutoff can misclassify a quiet reader as a pause.
      const settled=!decoder.pending && decoder.frameIndex-decoder.lastNonblankFrame>=ReciteCore.MATCHING.settleFrames;
      if(!settled) boundarySent=false;
      const boundary=settled && !boundarySent;
      if(boundary) boundarySent=true;
      if(emissions.length) {
        recentEmissions.push(...emissions);
        // A short window of finalized model output, before any Quran matching.
        recentEmissions=recentEmissions.filter(e=>e.frame>=decoder.frameIndex-200).slice(-80);
        postMessage({type:'heard',generation:trackerGeneration,recent:recentEmissions.map(e=>e.text).join(''),
          latest:emissions.map(e=>e.text).join('')});
      }
      if(emissions.length || boundary) {
        if(tracker) postMessage({type:'tracking',generation:trackerGeneration,offset:trackerOffset,boundary,...tracker.feed(emissions,boundary)});
        else postMessage({type:'emissions',emissions,boundary}); // Raw decoder diagnostics.
      }
      postMessage({type:'timing',ms:inferenceMs,pipelineMs:performance.now()-packetStart,
        queuedMs:queue.reduce((sum,packet)=>sum+packet.samples.length/16,0)});
    }
  } catch(e) { postMessage({type:'error',message:e.message}); queue=[]; }
  finally { busy=false; }
}
self.onmessage=async ({data})=>{
  try {
    if(data.type==='init') {
      ort.env.wasm.wasmPaths=new URL('assets/vendor/onnxruntime-1.30.0/',self.location.href).href;
      ort.env.wasm.numThreads=1;
      session=await ort.InferenceSession.create(data.model,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
      const names=['x','processed_lens',...Object.keys(contract())];
      if(session.inputNames.length!==99 || names.some(n=>!session.inputNames.includes(n)) ||
          session.outputNames.length!==99 || !session.outputNames.includes('log_probs') ||
          names.filter(n=>n!=='x').some(n=>!session.outputNames.includes('new_'+n))) throw Error('Model does not have the expected v3.1 streaming interface.');
      tokenTable=data.tokens;reset(data.tokens);
      tracker=data.words ? new ReciteTracker(data.words,data.startIndex || 0) : null;
      trackerGeneration=data.generation || 0;trackerOffset=data.offset || 0;reanchor=null;
      postMessage({type:'ready'});
    } else if(data.type==='audio') {
      if(queue.length>=6) throw Error('Recognition cannot keep up on this device. Pause and retry on a faster device.');
      queue.push(data); drain();
    } else if(data.type==='passage' && tracker) {
      reanchor={words:data.words,offset:data.offset,index:data.startIndex,generation:data.generation,preserve:!!data.preserve,resetAudio:!!data.resetAudio};
    } else if(data.type==='retry' && tracker) {
      // Re-anchor only the text alignment. Preserve microphone, fbank, CTC runs
      // and all 97 streaming model caches through a correction.
      // Apply at the next packet boundary, after any in-flight inference finishes.
      reanchor={index:data.index,generation:data.generation,resetAudio:!!data.resetAudio};
    }
  } catch(e) { postMessage({type:'error',message:e.message}); }
};
