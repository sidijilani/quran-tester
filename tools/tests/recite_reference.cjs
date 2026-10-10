/* Actual-model integration check. Prefetch reference clips with
   python3 tools/tests/fetch_recite_reference.py; run the localhost server.
   Temporary recordings/results are excluded from Git. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{const b=await chromium.launch({...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {}),headless:true}),p=await b.newPage();await p.goto((process.env.RECITE_URL || 'http://localhost:8765/')+'#recite');
const result=await p.evaluate(async()=>{
 const model=await(await fetch('assets/models/recite/zipformer_p_arabic_v3.1.int8.onnx')).arrayBuffer(),tokens=ReciteCore.parseTokens(await(await fetch('assets/models/recite/tokens-prompter.txt')).text());
 const audio=await Promise.all(Array.from({length:11},async(_,i)=>new OfflineAudioContext(1,1,16000).decodeAudioData(await(await fetch('tmp/recite/reference-page3/002'+String(i+6).padStart(3,'0')+'.mp3')).arrayBuffer())));
 const pcm=new Float32Array(audio.reduce((sum,a)=>sum+a.length+16000,0));let offset=0;for(const a of audio){pcm.set(a.getChannelData(0),offset);offset+=a.length+16000;}
 const matcher=new ReciteCore.Matcher(RECITE_PAGE.words),emissions=[],times=[],events=[];
 return new Promise(resolve=>{const w=new Worker('recite-worker.js');w.onmessage=async({data})=>{
  if(data.type==='ready'){
   for(let i=0;i<pcm.length+32000;i+=1600){const chunk=new Float32Array(1600);chunk.set(pcm.subarray(i,Math.min(i+1600,pcm.length)));w.postMessage({type:'audio',samples:chunk},[chunk.buffer]);await new Promise(r=>setTimeout(r,30));}
   await new Promise(r=>setTimeout(r,1200));w.terminate();resolve({seconds:pcm.length/16000,decoded:emissions.map(e=>e.text).join(''),minConfidence:Math.min(...emissions.map(e=>e.confidence)),meanConfidence:emissions.reduce((s,e)=>s+e.confidence,0)/emissions.length,confirmed:matcher.index,events,buffer:matcher.buffer,times,emissions});
  }else if(data.type==='emissions'){emissions.push(...data.emissions);events.push(...matcher.feed(data.emissions,data.boundary));}
  else if(data.type==='timing')times.push(data.ms);
  else if(data.type==='error'){w.terminate();resolve(data);}
 };w.onerror=e=>resolve({error:e.message});w.postMessage({type:'init',model,tokens},[model]);});
});require('fs').writeFileSync('tmp/recite/full-page3-recitation-result.json',JSON.stringify(result,null,2));await b.close();const assert=require('node:assert/strict');assert.equal(result.confirmed,127,JSON.stringify(result.events?.slice(-3)||result));assert.equal(result.events.filter(e=>e.type==='mismatch').length,0);console.log('Actual page-3 reference: 127/127 confirmed, no mismatches.');})();
