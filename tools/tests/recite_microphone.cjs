const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),fixture={window:{}};vm.runInNewContext(fs.readFileSync(require('node:path').resolve(__dirname,'../../data/recite/page-3.js'),'utf8'),fixture);
const page=fixture.window.RECITE_PAGE;
const alphabet=Array.from(new Set(page.words.flatMap(w=>w.phones).join('').replace(/\s/gu,'')));
const tokens=Array.from({length:251},(_,i)=>(i===250?'<blk>':alphabet[i]||'t'+i)+' '+i).join('\n');
(async()=>{
 const b=await chromium.launch({...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {}),headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 // Test-only model/worker substitutions. No Quran ASR is exercised or claimed.
 await p.route('**/data/recite/page-3.js',r=>r.fulfill({contentType:'text/javascript',body:'window.RECITE_PAGE='+JSON.stringify({...page,modelBytes:16,tokensBytes:Buffer.byteLength(tokens)})+';'}));
 await p.addInitScript(()=>{
  crypto.subtle.digest=async algorithm=>Uint8Array.from((algorithm==='SHA-1'?'5b0ed53f48819bac097568c596c668aa14d21f50':'31755836528da336a6192121cd7bc82cb41752dddb65566fd000b89c8686da6b').match(/../g),h=>parseInt(h,16)).buffer;
  window.Worker=class {constructor(){window.fakeWorker=this;this.audio=0;this.dead=false;}postMessage(data){if(data.type==='init')setTimeout(()=>{if(!this.dead)this.onmessage({data:{type:'ready'}})},40);if(data.type==='audio'){this.audio++;window.audioPacketLength=data.samples.length;}}terminate(){this.dead=true;}emit(data){this.onmessage({data});}};
  navigator.mediaDevices.getUserMedia=()=>new Promise((resolve,reject)=>{window.micResolve=resolve;window.micReject=reject;window.micPending=true;});
  window.resolveMic=()=>{const c=new AudioContext(),o=c.createOscillator(),d=c.createMediaStreamDestination();o.connect(d);o.start();window.mockMic=d.stream;window.mockAudio=c;window.micResolve(d.stream);window.micPending=false;};
 });
 await p.goto((process.env.RECITE_URL || 'http://localhost:8765/')+'#recite');
 await p.evaluate(async({tokens,hash})=>{
  const db=await new Promise((r,j)=>{const q=indexedDB.open('hifz-recitation',1);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
  await new Promise((r,j)=>{const tx=db.transaction('models','readwrite');tx.objectStore('models').put({model:new Blob([new Uint8Array(16)]),tokens},hash);tx.oncomplete=r;tx.onerror=j;});db.close();
 },{tokens,hash:page.modelSha256});await p.reload();
 await p.locator('#reciteStart').click();await p.waitForFunction(()=>window.micPending);
 await p.locator('#recitePause').click();await p.evaluate(()=>resolveMic());
 await p.waitForFunction(()=>window.mockMic.getTracks().every(t=>t.readyState==='ended'));
 assert.equal(await p.locator('#reciteState').textContent(),'Paused');assert.equal(await p.locator('#reciteCount').textContent(),'0 of 127 words');
 await p.evaluate(()=>mockAudio.close());console.log('Late microphone grant after cancel stops all tracks.');
 await p.locator('#reciteStart').click();await p.waitForFunction(()=>window.micPending);
 await p.evaluate(()=>{micPending=false;micReject(new DOMException('denied','NotAllowedError'));});
 await p.waitForFunction(()=>document.getElementById('reciteState').textContent==='Could not start');
 console.log('Permission denial leaves no live capture.');
 await p.locator('#reciteStart').click();await p.waitForFunction(()=>window.micPending);await p.evaluate(()=>resolveMic());
 await p.waitForFunction(()=>document.getElementById('reciteState').textContent==='Listening');await p.waitForFunction(()=>window.audioPacketLength===7680);
 await p.evaluate(()=>fakeWorker.emit({type:'emissions',emissions:[{text:RECITE_PAGE.words[0].phones[0],confidence:.95}],boundary:true}));
 assert.equal(await p.locator('#reciteCount').textContent(),'1 of 127 words');
 await p.evaluate(()=>fakeWorker.emit({type:'emissions',emissions:[{text:'غَيرِلمَغضُۥب',confidence:.95}],boundary:true}));
 assert.equal(await p.locator('#reciteState').textContent(),'Try that word again');
 assert.equal(await p.evaluate(()=>mockMic.getTracks().every(t=>t.readyState==='ended')),true);
 assert.equal(await p.locator('#reciteCount').textContent(),'1 of 127 words');await p.evaluate(()=>mockAudio.close());
 console.log('Real worklet produces 16 kHz packets; simulated mismatch stops capture and holds position.');
 await p.locator('#reciteRestart').click();await p.locator('#reciteStart').click();await p.waitForFunction(()=>window.micPending);
 await p.locator('#hifzTab').click();await p.evaluate(()=>resolveMic());await p.waitForFunction(()=>window.mockMic.getTracks().every(t=>t.readyState==='ended'));
 await p.evaluate(()=>mockAudio.close());assert.deepEqual(errors,[]);console.log('Leaving Recite cancels pending microphone access.');
 await p.locator('#reciteTab').click();await p.locator('#reciteRestart').click();await p.locator('#reciteStart').click();await p.waitForFunction(()=>window.micPending);await p.evaluate(()=>resolveMic());
 await p.waitForFunction(()=>document.getElementById('reciteState').textContent==='Listening');
 await p.evaluate(()=>fakeWorker.emit({type:'emissions',emissions:[{text:RECITE_PAGE.words.map(w=>w.phones[0]).join(''),confidence:.99}],boundary:true}));
 assert.equal(await p.locator('#reciteState').textContent(),'Page complete');assert.equal(await p.locator('#recitePause').isVisible(),false);
 assert.equal(await p.evaluate(()=>mockMic.getTracks().every(t=>t.readyState==='ended')),true);await p.evaluate(()=>mockAudio.close());
 console.log('Live-mode completion releases capture and stops listening indicators.');await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
