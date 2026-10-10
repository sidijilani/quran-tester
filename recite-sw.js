/* Shell activation waits for an idle view. Quran pages cache on demand;
   Direct Quran.com audio/metadata caches are managed by ReciteGuide in the
   browser, with independent seven-day expiries. Model weights use IDB. */
const VERSION='hifz-recite-v12-client-only';
const FILES=['./','index.html','styles.css','app.js','recite.js','recite-data.js','recite-core.js','recite-tracker.js','recite-worker.js','recite-fbank.js','recite-audio.js','recite-guide.js','recite-commands.js',
  'data/recite/catalog.js','data/recite/page-3.js','data/recite/page-4.js','data/quran-data.js','data/line-bands.js','data/ayah-layout-manifest.js',
  'data/hifz-chunks-manifest.js','data/mutashabihat-manifest.js','data/waqf/manifest.js','assets/app-icon.png','assets/pages/3.jpg','assets/pages/4.jpg','assets/vendor/vosk-browser-0.0.8/vosk.js',
  'assets/vendor/onnxruntime-1.30.0/ort.wasm.min.js','assets/vendor/onnxruntime-1.30.0/ort-wasm-simd-threaded.mjs','assets/vendor/onnxruntime-1.30.0/ort-wasm-simd-threaded.wasm'];
self.addEventListener('install',event=>event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(FILES))));
self.addEventListener('message',event=>{if(event.data?.type==='activate-when-idle')self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>(k.startsWith('hifz-recite-') && k!==VERSION) || k==='hifz-sudais-pilot-v1').map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;
  const relative=url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if(/^data\/recite\/pages\/\d+\.json$/.test(relative) || /^assets\/pages\/\d+\.jpg$/.test(relative)) {
    event.respondWith((async()=>{
      const cache=await caches.open('hifz-quran-pages-v1');
      const cached=await cache.match(event.request);if(cached)return cached;
      const response=await fetch(event.request);if(response.ok)await cache.put(event.request,response.clone());return response;
    })());return;
  }
  if(relative==='assets/models/commands/vosk-model-small-en-us-0.15.tar.gz') {
    event.respondWith(caches.open('hifz-commands-v1').then(async cache=>(await cache.match(event.request)) || fetch(event.request)));return;
  }
  if(!FILES.some(file=>new URL(file,self.registration.scope).pathname===url.pathname))return;
  event.respondWith(fetch(event.request).catch(()=>caches.open(VERSION).then(cache=>cache.match(url.pathname))));
});
