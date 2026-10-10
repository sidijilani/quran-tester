(function() {
  'use strict';
  const data=new ReciteData(window.RECITE_CATALOG),words=data.words,ayahs=data.ayahs;
  const practice=new ReciteCore.Practice({words});
  let page=data.pages.get(3),sessionStart=data.byRef.get('2:6').start,sessionEnd=data.byRef.get('2:24').end;
  let origin= data.byRef.get('2:6'),range={mode:'pages',startPage:3,endPage:10,startRef:'2:6',endRef:'2:29'};
  let reference=null,preparing=false,preparation=0,rolling=false,initialized=false;
  practice.index=sessionStart;
  const $=id=>document.getElementById('recite'+id);
  const ui=Object.fromEntries(['Mask','State','Message','Count','ReviewCount','Progress','StatusDot','ModeBadge','Start','Demo','Retry','Pause','DemoControls','DemoNext','DemoMistake','Hint','Restart','Reveal','Review','ReviewList','Setup','ModelStatus','ModelFile','TokensFile','Import','DeleteModel',
    'HeardOutput','HeardStatus','TrackerWord','TrackerRef','LastWord','LastVerdict','ComparedHeard','ComparedExpected','MatchMetrics','LiveTiming',
    'VisualMode','AudioMode','AudioSettings','AudioCard','Range','PageRange','AyahRange','StartPage','EndPage','StartSurah','EndSurah','StartAyah','EndAyah','SessionRange','Attempts','CueWords','VoiceCommands','AudioTools','PlayCue','PlayHelp','NewTest','CacheAudio','Interrupt','EndSession','PlaybackStatus','AttemptStatus','AudioAyah','CommandsStatus','WakeStatus','OfflineStatus'].map(id=>[id,$(id)]));
  const ns='http://www.w3.org/2000/svg';
  let mode='idle', visible=false, revealed=false, epoch=0, stream=null, context=null, capture=null, worker=null, modelInstalled=false, cancelReady=null;
  let cueSound=null, lastCueAt=0, alignmentGeneration=0;
  let lastDiagnosis=null;
  let practiceMode='visual',audioPackets=[],packetSamples=0,wakeLock=null,heldTracking=[],shellRegistration=null;
  let guideTarget=0,helpPlaying=false,commandMutedUntil=0,saveTimer=null;
  let settings={attempts:3,cueWords:3,commands:true};
  try {
    const saved=JSON.parse(localStorage.getItem('hifz-recite-settings'));
    if(saved){settings={attempts:Math.max(1,Math.min(5,+saved.attempts || 3)),cueWords:Math.max(1,Math.min(5,+saved.cueWords || 3)),commands:saved.commands!==false};practiceMode=saved.mode==='audio'?'audio':'visual';}
  } catch(_) {}
  const policy=new ReciteRetryPolicy(settings.attempts);
  const guide=new ReciteGuide(data.catalog,guideStatus,bargeIn);
  const commands=new ReciteCommands(voiceCommand,message=>{ui.CommandsStatus.textContent=message;});
  ui.Attempts.value=settings.attempts;ui.CueWords.value=settings.cueWords;ui.VoiceCommands.checked=settings.commands;
  function currentAyah(index=practice.index) {return data.ayah(Math.min(index,sessionEnd-1));}
  function displayPage(index) {
    const target=words[Math.max(0,Math.min(index,sessionEnd-1))];
    if(target)page=data.pages.get(target.page) || page;
    document.getElementById('reciteTitle').textContent=page.title;
    document.getElementById('reciteSubtitle').textContent=`Start ${origin.ref} · Continue through ${data.ayah(sessionEnd-1).ref}. ${practiceMode==='audio'?'Listen to Sudais, then recite.':'Recite from the outlined word.'}`;
    document.getElementById('recitePageLabel').textContent='Page '+page.page;
    const image=document.getElementById('reciteImage');if(image.getAttribute('src')!==page.image)image.src=page.image;
    image.width=page.width;image.height=page.height;
    image.alt=page.title+' practice page. Hidden words are revealed as you progress.';
    ui.Mask.setAttribute('viewBox',`0 0 ${page.width} ${page.height}`);
  }
  function saveSession() {
    clearTimeout(saveTimer);
    saveTimer=setTimeout(persistSession,150);
  }
  function persistSession() {
    if(!initialized || preparing)return;
    const marks=reviewIndices().map(i=>words[i]).filter(Boolean).map(({g,ref,word,ar,page})=>({g,ref,word,ar,page}));
    try {localStorage.setItem('hifz-recite-session-v2',JSON.stringify({range,start:sessionStart,end:sessionEnd,index:practice.index,
      origin:origin.ref,confirmed:[...practice.confirmed],states:[...practice.states],exposed:[...practice.exposed],
      mistakes:[...practice.mistakes],uncertain:[...practice.uncertain],hints:[...practice.hints],marks,focus:policy.focus}));}catch(_){}
  }
  function clearPackets() {audioPackets=[];packetSamples=0;heldTracking=[];commands.reset();}
  function globalTracking(update) {
    const offset=update.offset || 0;
    return {...update,cursor:update.cursor+offset,changes:update.changes.map(v=>({...v,index:v.index+offset})),
      rewound:update.rewound?{from:update.rewound.from+offset,to:update.rewound.to+offset}:null};
  }
  async function realign(index,resetAudio=false) {
    const request=++preparation,currentWorker=worker;
    clearPackets();practice.index=Math.max(0,Math.min(sessionEnd-1,index));practice.retry();
    try {
      if(reference && index>=reference.offset && index<reference.end) {
        if(currentWorker)currentWorker.postMessage({type:'passage',words:reference.words,offset:reference.offset,startIndex:practice.index-reference.offset,generation:++alignmentGeneration,resetAudio});
      } else {
        preparing=true;
        const next=await data.window(practice.index,sessionEnd);
        if(request!==preparation)return;
        reference=next;
        if(currentWorker && worker===currentWorker)currentWorker.postMessage({type:'passage',words:next.words,offset:next.offset,startIndex:practice.index-next.offset,generation:++alignmentGeneration,resetAudio});
      }
      displayPage(practice.index);render();
    } catch(error){paused();status('Could not load passage',error.message);}
    finally {if(request===preparation){preparing=false;render();}}
  }
  async function rollReference() {
    if(rolling || preparing || !worker || !reference || reference.end>=sessionEnd)return;
    const threshold=data.catalog.pages[Math.min(604,data.pageNumber(reference.end-1)-1)].start;
    if(practice.index<threshold)return;
    rolling=true;const currentWorker=worker,request=preparation;
    try {
      const next=await data.window(practice.index,sessionEnd);
      if(worker!==currentWorker || request!==preparation || next.offset===reference.offset && next.end===reference.end)return;
      reference=next;
      // No audio reset and no invented transcript: the worker migrates its
      // observed alignment history into the overlapping graph at a packet boundary.
      currentWorker.postMessage({type:'passage',words:next.words,offset:next.offset,startIndex:practice.index-next.offset,generation:alignmentGeneration,preserve:true});
    } catch(error){paused();status('Next page unavailable',error.message);}
    finally {rolling=false;}
  }
  async function requestWakeLock() {
    if(practiceMode!=='audio' || !navigator.wakeLock)return;
    try {
      const lock=await navigator.wakeLock.request('screen');
      if(practiceMode!=='audio' || !['live','audio-paused'].includes(mode)){await lock.release();return;}
      wakeLock=lock;ui.WakeStatus.textContent='Screen stays awake while this app is open.';
      lock.addEventListener('release',()=>{if(wakeLock===lock){wakeLock=null;ui.WakeStatus.textContent='Screen wake lock released. Keep the app open to continue.';}});
    } catch(_){ui.WakeStatus.textContent='Keep the screen awake; this browser could not hold a wake lock.';}
  }
  function releaseWakeLock() {if(wakeLock)wakeLock.release().catch(()=>{});wakeLock=null;}
  function guideStatus(state,value) {
    if(state==='playing' && helpPlaying) {
      const playingAyah=ayahs.find(a=>a.ref===value);
      if(playingAyah){guideTarget=playingAyah.start;practice.index=guideTarget;}
    }
    ui.AudioCard.dataset.state=state;
    ui.Interrupt.hidden=!['loading','playing','tail'].includes(state);
    ui.PlaybackStatus.textContent=state==='loading'?'Preparing Sudais…':state==='playing'?`Sudais · ${value} · ${helpPlaying || guide.usedFullAyah?'full ayah':'opening cue'}`:state==='tail'?'Your turn…':state==='error'?value:'Listening to you';
    if(state==='playing' && guide.usedFullAyah && !helpPlaying)status('Sudais · Full ayah','Word timings are incomplete for this recording. Sudais will read the full ayah.');
    if(state==='ended' && mode==='live') {
      realign(guideTarget,true);if(helpPlaying)policy.helped();helpPlaying=false;
      status('Your turn','Recite from the ayah’s beginning. You can go back a few words naturally.');
    } else if(state==='error') {
      // Keep controls and microphone usable, but never pretend a missing prompt played.
      helpPlaying=false;status('Audio prompt unavailable',value);
    }
    render();
  }
  function bargeIn(clean=[]) {
    guide.cancel();realign(guideTarget,true);if(helpPlaying)policy.helped();helpPlaying=false;
    ui.Interrupt.hidden=true;ui.PlaybackStatus.textContent='Following your interruption';
    for(const samples of clean){commands.feed(samples);enqueue(samples);}
    status('Listening · Your turn','Sudais stopped. Continue reciting from your restart point.');
  }
  function enqueue(samples) {
    audioPackets.push(samples);packetSamples+=samples.length;
    // Recognition retains its 480 ms packets; the microphone monitor runs at
    // 100 ms in audio mode so barge-in and command detection need not wait.
    if(commands.pending){while(packetSamples>16000){packetSamples-=audioPackets.shift().length;}return;}
    while(packetSamples>=7680) {
      const packet=new Float32Array(7680);let offset=0;
      while(offset<packet.length) {
        const chunk=audioPackets.shift(),take=Math.min(chunk.length,packet.length-offset);
        packet.set(chunk.subarray(0,take),offset);offset+=take;
        if(take<chunk.length)audioPackets.unshift(chunk.subarray(take));
      }
      packetSamples-=packet.length;
      worker?.postMessage({type:'audio',samples:packet,generation:alignmentGeneration},[packet.buffer]);
    }
  }
  function microphonePacket(samples) {
    if(practiceMode==='visual') {if(mode==='live' && !preparing)enqueue(samples);return;}
    if(!['live','audio-paused'].includes(mode))return;
    if(!commands.pending && !guide.blocked) {
      const pending=heldTracking;heldTracking=[];
      for(const update of pending)if(mode==='live' && update.generation===alignmentGeneration)tracked(update);
    }
    const gated=guide.observe(samples);
    if(!gated || (guide.probe && performance.now()-guide.probe.at>120))commands.feed(samples);
    if(mode!=='live' || preparing || gated || performance.now()<commandMutedUntil)return;
    enqueue(samples);
  }
  async function playCue() {
    if(mode!=='live' || practiceMode!=='audio')return;
    const ayah=currentAyah(policy.focus?.index ?? practice.index);
    guideTarget=ayah.start;helpPlaying=false;await realign(guideTarget,true);
    if(mode!=='live' || practiceMode!=='audio')return;
    guide.play([ayah.ref],settings.cueWords);
    status('Opening cue','Listen to Sudais, then recite the ayah from its beginning. Speak to interrupt.');
  }
  async function playHelp(index=policy.focus?.index ?? practice.index) {
    if(mode!=='live' || practiceMode!=='audio' || guide.blocked)return;
    const ayah=currentAyah(index),previous=ayahs[ayahs.indexOf(ayah)-1];
    const [chapter,verse]=ayah.ref.split(':').map(Number);
    const previousRef=previous?.ref || (verse>1?`${chapter}:${verse-1}`:null);
    const contextNeeded=words[index]?.word===1 && previousRef;
    guideTarget=contextNeeded && previous?previous.start:ayah.start;
    helpPlaying=true;await realign(guideTarget,true);
    if(mode!=='live' || practiceMode!=='audio')return;
    guide.play(contextNeeded?[previousRef,ayah.ref]:[ayah.ref]);
    status('Listen to Sudais',contextNeeded?'Previous ayah, then the current ayah. Speak whenever you want to take over.':'Listen to the ayah. Speak whenever you want to take over.');
  }
  function audioPause() {
    const index=guide.blocked?guideTarget:practice.index;
    guide.cancel();ui.Interrupt.hidden=true;realign(index,true);mode='audio-paused';
    status('Paused · Voice commands listening','Say “Resume” to continue, or “New test” for another prompt. End session turns off the microphone.');
  }
  function resumeAudio() {
    if(mode!=='audio-paused')return;realign(practice.index,true);mode='live';
    status('Listening','Continue from your saved place, or say “Repeat” for the opening cue.');requestWakeLock();
  }
  async function newTest() {
    if(preparing || mode==='loading')return;
    const running=['live','audio-paused'].includes(mode) && !!worker;
    const request=++preparation;preparing=true;
    guide.cancel();clearPackets();revealed=false;
    status('Choosing a prompt','Loading a random ayah in your practice range…');
    try {
      const selected=data.pick(range,origin?.ref),next=await data.window(selected.ayah.start,selected.end);
      if(request!==preparation)return;
      practice.reset();policy.focus=null;origin=selected.ayah;sessionStart=origin.start;sessionEnd=selected.end;
      practice.index=sessionStart;reference=next;guideTarget=sessionStart;resetDiagnostics();initialized=true;
      if(running)worker.postMessage({type:'passage',words:next.words,offset:next.offset,startIndex:sessionStart-next.offset,generation:++alignmentGeneration,resetAudio:true});
      mode=running?'live':'idle';preparing=false;
      if(practiceMode==='audio')guide.record(origin.ref).catch(()=>{});
      status('New prompt ready',`Begin at ${origin.name} ${origin.ref}. The opening words are visible; continue through ${data.ayah(sessionEnd-1).ref}.`);
      if(running && practiceMode==='audio')playCue();
    } catch(error){status('Could not prepare a test',error.message);}
    finally {if(request===preparation){preparing=false;render();}}
  }
  function voiceCommand(command) {
    if(practiceMode!=='audio')return;
    commandMutedUntil=performance.now()+350;
    if(command==='stop' && mode==='live')audioPause();
    else if(command==='resume')resumeAudio();
    else if(command==='new test')newTest();
    else if(command==='repeat' || command==='help') {
      if(mode==='audio-paused')resumeAudio();
      guide.cancel();ui.Interrupt.hidden=true;
      command==='repeat'?playCue():playHelp();
    }
    chime();
  }
  function chime() {
    try {
      cueSound ||= new (window.AudioContext || window.webkitAudioContext)();cueSound.resume().catch(()=>{});
      [440,554].forEach((frequency,index)=>{
        const oscillator=cueSound.createOscillator(),gain=cueSound.createGain(),at=cueSound.currentTime+index*.12;
        oscillator.frequency.value=frequency;gain.gain.setValueAtTime(.04,at);gain.gain.exponentialRampToValueAtTime(.001,at+.14);
        oscillator.connect(gain).connect(cueSound.destination);oscillator.start(at);oscillator.stop(at+.15);
        oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
      });
    }catch(_){}
  }
  function saveSettings() {
    settings={attempts:+ui.Attempts.value,cueWords:+ui.CueWords.value,commands:ui.VoiceCommands.checked};policy.limit=settings.attempts;
    try {localStorage.setItem('hifz-recite-settings',JSON.stringify({...settings,mode:practiceMode}));}catch(_){}
    render();
  }
  function switchMode(value) {
    if(value===practiceMode)return;
    paused();practice.retry();mode=practice.index?'paused':'idle';practiceMode=value;
    if(policy.focus && practice.states.get(policy.focus.index)==='ok')policy.focus=null;
    saveSettings();
    status(value==='audio'?'Audio practice ready':'Visual practice ready',value==='audio'?'Start to hear Sudais’s opening cue. Recite from the ayah’s beginning.':'Your progress and review marks are preserved. Continue at the outlined word.');
  }
  let cacheAbort=null;
  async function cacheAudio() {
    if(cacheAbort){cacheAbort.abort();return;}
    const abort=new AbortController();cacheAbort=abort;ui.CacheAudio.textContent='Cancel saving';
    try {
      if(!window.isSecureContext || !('caches' in window))throw Error('Offline saving needs the HTTPS app.');
      const pool=data.pool({...range}),first=pool[0],previous=ayahs[ayahs.indexOf(first)-1];
      // Include the same recognition overlap and first-word help used live.
      const contextStart=data.ayah(Math.min(previous?.start ?? first.start,Math.max(0,first.start-12)));
      const items=ayahs.slice(ayahs.indexOf(contextStart),ayahs.indexOf(pool.at(-1))+1);
      let count=0,expiry=Infinity;
      for(const ayah of items) {
        abort.signal.throwIfAborted();ui.OfflineStatus.textContent=`Saving Sudais ${++count} of ${items.length}…`;
        const {record}=await guide.audio(ayah.ref,abort.signal,true);
        expiry=Math.min(expiry,Date.parse(record.expiresAt));
      }
      const shell=await caches.open('hifz-quran-pages-v1');
      for(let p=contextStart.firstPage;p<=pool.at(-1).lastPage;p++) {
        abort.signal.throwIfAborted();ui.OfflineStatus.textContent=`Saving Mushaf page ${p}…`;
        for(const url of [`data/recite/pages/${p}.json`,`assets/pages/${p}.jpg`]) {
          const response=await fetch(url,{signal:abort.signal});if(!response.ok)throw Error(`Page ${p} is unavailable.`);await shell.put(url,response);
        }
      }
      if(settings.commands) {
        ui.OfflineStatus.textContent='Saving local voice commands…';
        const commandCache=await caches.open('hifz-commands-v1');
        const url='assets/models/commands/vosk-model-small-en-us-0.15.tar.gz',response=await fetch(url,{signal:abort.signal});
        if(!response.ok)throw Error('Voice command model could not load. Connect and try again.');
        await commandCache.put(url,response);
      }
      if(navigator.storage?.persist)await navigator.storage.persist();
      ui.OfflineStatus.textContent=`Range saved on this device. Audio expires ${new Date(expiry).toLocaleDateString()}; the recognition model is saved when you first start.`;
    } catch(error) {ui.OfflineStatus.textContent=error.name==='AbortError'?'Saving stopped. Completed items remain cached.':error.message;}
    finally {cacheAbort=null;ui.CacheAudio.textContent='Save range offline';}
  }
  function svg(tag,attrs={}) { const el=document.createElementNS(ns,tag); for(const [k,v] of Object.entries(attrs)) el.setAttribute(k,v); return el; }
  function box(rect,attrs={}) { const [x,y,width,height]=rect; return svg('rect',{x,y,width,height,...attrs}); }
  function reviewIndices() { return [...new Set([...practice.mistakes,...practice.uncertain,...practice.hints])].sort((a,b)=>a-b); }
  function retryIndex() { return reviewIndices().find(i=>!practice.confirmed.has(i)); }
  function isCue(i) {
    const ayah=practiceMode==='audio'?currentAyah(guideTarget || sessionStart):origin;
    return i>=ayah.start && i<Math.min(ayah.end,ayah.start+settings.cueWords);
  }
  function wordShown(i) { return revealed || practice.confirmed.has(i) || practice.exposed.has(i) || isCue(i) || practice.hints.has(i); }
  function boxShown(w) {
    const group=w.revealGroup || [w.g];
    return group.every(wordShown) || group.some(i=>isCue(i) || practice.exposed.has(i) || practice.hints.has(i));
  }
  function reviewKind(i) {
    const state=practice.states.get(i);
    if(state==='unsure' || practice.uncertain.has(i)) return 'unclear';
    if(state==='skipped') return 'skipped';
    if(state==='wrong') return 'wrong';
    if(practice.mistakes.has(i)) return practice.confirmed.has(i)?'corrected':'wrong';
    return practice.hints.has(i)?'hint':'cue';
  }
  function resetDiagnostics() {
    lastDiagnosis=null;ui.HeardOutput.dataset.empty='true';
    ui.HeardOutput.removeAttribute('lang');ui.HeardOutput.textContent='Start reciting to see what the model hears.';
    ui.LiveTiming.textContent='Processing time appears when recognition starts.';
  }
  function renderDiagnostics() {
    ui.HeardStatus.textContent=mode==='live'?(guide.blocked?'Sudais · Progress frozen':'Live'):mode==='demo'?'Demo · No recognition':mode==='loading'?'Preparing':['paused','audio-paused'].includes(mode)?'Paused':mode==='complete'?'Complete':'Waiting';
    const target=practice.index<sessionEnd?words[practice.index]:null;
    ui.TrackerWord.textContent=target?.ar || '—';
    ui.TrackerRef.textContent=target?`${target.ref} · word ${target.word}`:'End of session';
    const last=lastDiagnosis && words[lastDiagnosis.index];
    ui.LastWord.textContent=last?.ar || '—';
    ui.LastVerdict.textContent=lastDiagnosis?({ok:'Confirmed',unsure:'Unclear',wrong:'Wrong',skipped:'Skipped'}[lastDiagnosis.state] || 'Waiting'):'Waiting';
    ui.LastVerdict.dataset.state=lastDiagnosis?.state || '';
    ui.ComparedHeard.textContent=lastDiagnosis?(lastDiagnosis.heard || 'No aligned sounds'):'—';
    ui.ComparedExpected.textContent=lastDiagnosis?.expected || '—';
    ui.MatchMetrics.textContent=lastDiagnosis?
      `Signal margin: ${lastDiagnosis.margin.toFixed(2)} · Sound difference: ${lastDiagnosis.distance.toFixed(2)}. Lower difference means a closer match.`:
      'Matching details appear after a word settles.';
  }
  function heard(data) {
    const recent=data.recent.replace(/\u0619/gu,' '), latest=data.latest.replace(/\u0619/gu,' ');
    const previous=document.createElement('bdi'), newest=document.createElement('bdi');
    previous.className='reciteHeardPrevious';newest.className='reciteHeardNewest';
    if(latest && recent.endsWith(latest)) { previous.textContent=recent.slice(0,-latest.length);newest.textContent=latest; }
    else newest.textContent=recent;
    ui.HeardOutput.dataset.empty='false';ui.HeardOutput.lang='ar';
    ui.HeardOutput.replaceChildren(previous,newest);ui.HeardOutput.scrollTop=ui.HeardOutput.scrollHeight;
  }
  function render() {
    displayPage(practice.index);
    const audio=practiceMode==='audio';
    document.getElementById('recitePanel').dataset.practiceMode=practiceMode;
    ui.VisualMode.setAttribute('aria-pressed',String(!audio));ui.AudioMode.setAttribute('aria-pressed',String(audio));
    for(const el of [ui.AudioSettings,ui.AudioCard,ui.AudioTools,ui.CommandsStatus,ui.WakeStatus,ui.OfflineStatus])el.hidden=!audio;
    ui.EndSession.hidden=!audio || !['live','audio-paused','loading'].includes(mode);
    ui.AudioAyah.textContent=`${page.title} · Ayah ${currentAyah().ref.split(':')[1]}`;
    ui.AttemptStatus.textContent=policy.focus?`${policy.focus.attempts} of ${settings.attempts} unsuccessful attempts · ${words[policy.focus.index].ref}, word ${words[policy.focus.index].word}`:`Up to ${settings.attempts} attempts before Sudais helps. Unclear speech doesn’t count.`;
    ui.PlayCue.disabled=ui.PlayHelp.disabled=preparing || !['live','audio-paused'].includes(mode);
    ui.VisualMode.disabled=ui.AudioMode.disabled=preparing || mode==='loading';
    ui.NewTest.disabled=mode==='loading' || preparing;ui.Range.disabled=mode==='loading' || preparing;
    ui.SessionRange.textContent=`Prompt ${origin.ref} · Through ${data.ayah(sessionEnd-1).ref}`;
    const done=mode==='complete' || (mode==='demo' && practice.index===sessionEnd);
    const defs=svg('defs'), mask=svg('mask',{id:'recite-holes',maskUnits:'userSpaceOnUse',x:0,y:0,width:page.width,height:page.height});
    mask.append(box([0,0,page.width,page.height],{fill:'white'}));
    for(const r of page.medallions) mask.append(box(r,{fill:'black'}));
    page.words.forEach(w=>{ const i=w.g; if(boxShown(w)) mask.append(box(w.box,{fill:'black'})); });
    defs.append(mask); ui.Mask.replaceChildren(defs);
    ui.Mask.append(box(page.conceal,{fill:'#fff',mask:'url(#recite-holes)'}));
    page.words.forEach(w=>{ const i=w.g;
      const isShown=boxShown(w);
      const [x,y,width,height]=w.box;
      if(!isShown) ui.Mask.append(svg('line',{x1:x+width*.25,x2:x+width*.75,y1:y+height*.72,y2:y+height*.72,stroke:'#dcd7cb','stroke-width':2,'stroke-linecap':'round'}));
      if(practice.mistakes.has(i) || practice.uncertain.has(i) || practice.hints.has(i) || isCue(i)) {
        const kind=reviewKind(i);
        const colors={unclear:['#d79b3430','#b17a28'],wrong:['#b64b4b28','#b64b4b'],
          skipped:['#87909920','#7d8792'],corrected:['#b64b4b10','#b64b4b'],hint:['#c9ad4320','none'],cue:['#c9ad4320','none']};
        const [fill,stroke]=colors[kind];
        ui.Mask.append(box([x,y+3,width,height-5],{rx:5,fill,stroke,'stroke-width':kind==='corrected' ? 0.7 : 1,
          'stroke-dasharray':kind==='unclear'?'3 3':kind==='skipped'?'1 3':'0'}));
      }
      if(i===practice.index && !revealed && !done) ui.Mask.append(box([x,y+3,width,height-5],{rx:5,fill:practice.waitingRetry?'#aa504516':'none',stroke:practice.waitingRetry?'#ad554e':'#b29852','stroke-width':1.4,'stroke-dasharray':practice.waitingRetry?'0':'4 4'}));
    });
    const revisit=reviewIndices();
    const confirmed=[...practice.confirmed].filter(i=>i>=sessionStart && i<sessionEnd).length;
    ui.Count.textContent=`${confirmed} of ${sessionEnd-sessionStart} words · ${origin.ref}–${data.ayah(sessionEnd-1).ref}`;
    ui.Progress.max=sessionEnd-sessionStart;
    ui.Progress.value=confirmed;
    ui.ReviewCount.textContent=revisit.length?`${revisit.length} to revisit`:'No words to revisit';
    ui.ModeBadge.hidden=mode!=='demo';
    ui.Start.hidden=mode==='demo' || mode==='loading' || mode==='live' || practice.waitingRetry || done || revealed;
    ui.Start.disabled=ui.Demo.disabled=preparing || !initialized;
    ui.Start.textContent=mode==='paused' || mode==='audio-paused' || [...practice.confirmed].some(i=>i>=sessionStart && i<sessionEnd)?'Resume reciting':'Start reciting';
    ui.Demo.hidden=audio || mode==='demo' || mode==='loading' || mode==='live' || practice.waitingRetry || done || revealed;
    ui.Demo.textContent=practice.confirmed.size?'Continue in demo':'Try the demo';
    ui.Retry.hidden=revealed || (!practice.waitingRetry && retryIndex()===undefined);
    ui.Retry.textContent=practice.waitingRetry?'Try that word again':'Retry marked word';
    ui.Retry.disabled=preparing || mode==='loading';
    ui.Pause.hidden=!['loading','live'].includes(mode);
    ui.Pause.textContent=mode==='loading'?'Cancel':'Pause';
    ui.DemoControls.hidden=mode!=='demo' || done || revealed;
    ui.DemoNext.disabled=preparing || practice.waitingRetry;
    ui.DemoMistake.disabled=preparing || practice.waitingRetry;
    ui.Restart.disabled=ui.Reveal.disabled=preparing || mode==='loading';
    ui.Hint.disabled=preparing || done || practice.index>=sessionEnd || revealed || mode==='loading';
    ui.Reveal.disabled=preparing || mode==='loading' || revealed;
    ui.StatusDot.className='reciteStatusDot'+(practice.waitingRetry?' retry':mode==='live'?' listening':'');
    ui.Review.hidden=!revisit.length;
    ui.ReviewList.replaceChildren();
    for(const i of revisit) {
      const item=document.createElement('li'), ref=document.createElement('span'), text=document.createElement('bdi');
      const kind=reviewKind(i), label={wrong:'Wrong',unclear:'Unclear',skipped:'Skipped',corrected:'Corrected',hint:'Hint'}[kind];
      item.dataset.kind=kind;
      ref.textContent=`Page ${words[i].page} · ${words[i].ref} · ${label}`;
      text.lang='ar'; text.dir='rtl';
      text.textContent=wordShown(i)?words[i].ar:'Hidden word';
      item.append(ref,text); ui.ReviewList.append(item);
    }
    renderDiagnostics();
    saveSession();
  }
  function status(title,message) { ui.State.textContent=title; ui.Message.textContent=message; render(); }
  function stopCapture() {
    epoch++;++preparation;preparing=false;
    guide.cancel();commands.stop();clearPackets();releaseWakeLock();ui.Interrupt.hidden=true;
    if(cancelReady) { cancelReady(); cancelReady=null; }
    if(worker) { worker.terminate(); worker=null; }
    if(capture) { capture.port.onmessage=null; capture.disconnect(); capture=null; }
    if(stream) { stream.getTracks().forEach(t=>t.stop()); stream=null; }
    if(context) { context.close().catch(()=>{}); context=null; }
  }
  function activateIdleShell() {
    if(!['live','audio-paused','loading'].includes(mode))shellRegistration?.waiting?.postMessage({type:'activate-when-idle'});
  }
  function sound() {
    const now=Date.now(); if(now-lastCueAt<1500) return; lastCueAt=now;
    try {
      cueSound ||= new (window.AudioContext || window.webkitAudioContext)();
      cueSound.resume().catch(()=>{});
      // A short, fabric-muted hand tap: filtered contact noise and a damped thud.
      // Synthesize locally so the cue also works offline, without a recording.
      const duration=.16, rate=cueSound.sampleRate;
      const buffer=cueSound.createBuffer(1,Math.ceil(duration*rate),rate);
      const samples=buffer.getChannelData(0), alpha=1-Math.exp(-2*Math.PI*750/rate);
      let contact=0;
      for(let i=0;i<samples.length;i++) {
        const t=i/rate, attack=1-Math.exp(-t/.0008);
        contact+=alpha*((Math.random()*2-1)-contact);
        const thud=Math.sin(2*Math.PI*(105*t-130*t*t));
        const fade=Math.min(1,(duration-t)/.015);
        samples[i]=attack*fade*(.55*contact*Math.exp(-t/.022)+.17*thud*Math.exp(-t/.028));
      }
      const tap=cueSound.createBufferSource(); tap.buffer=buffer;
      tap.connect(cueSound.destination); tap.start();
      tap.onended=()=>tap.disconnect();
    } catch (_) { /* Visual retry remains usable on browsers without Web Audio. */ }
  }
  async function correct() {
    if(mode!=='demo' || preparing) return;
    try{await data.ensure(practice.index,Math.min(sessionEnd,practice.index+2));}catch(error){status('Next page unavailable',error.message);return;}
    if(mode!=='demo')return;
    if(practice.index>=sessionEnd || !practice.accept()) return;
    if(practice.index===sessionEnd) {
      const wasDemo=mode==='demo';
      stopCapture(); mode=wasDemo?'demo':'complete';
      status(wasDemo?'Demo complete':'Page complete',wasDemo?'You tried the reveal and retry flow. No speech was evaluated.':'Your words have returned. Revisit the marked words before another pass.');
    } else status(mode==='demo'?'Demo · Your turn':'Listening', mode==='demo'?'Use “Read next word” to simulate a confirmed word, or “Try a mistake” to explore a retry.':'Keep reciting. Your place moves as words are confirmed; pauses are welcome.');
  }
  function mistake() {
    if(mode!=='demo') return;
    if(!practice.mistake()) return;
    sound(); status('Try that word again','Your place is saved. Retry the outlined word, or use a hint if you need one.');
  }
  function tracked(update) {
    // Context before the chosen start can be heard without becoming a new test.
    update.changes=update.changes.filter(v=>v.index>=sessionStart && v.index<sessionEnd);
    update.cursor=Math.min(sessionEnd,update.cursor);
    const changed=update.changes.length || update.cursor!==practice.index || update.rewound;
    const newWrong=update.changes.some(v=>v.state==='wrong' && !practice.mistakes.has(v.index));
    const newSkipped=update.changes.some(v=>v.state==='skipped' && !practice.mistakes.has(v.index));
    const newMistake=newWrong || newSkipped;
    const newUnclear=update.changes.some(v=>v.state==='unsure');
    if(update.changes.length) lastDiagnosis=update.changes.at(-1);
    const previousAyah=currentAyah();practice.track(update);
    rollReference();
    if(practiceMode==='audio' && currentAyah()!==previousAyah){const upcoming=ayahs[ayahs.indexOf(currentAyah())+1];guide.record(currentAyah().ref).catch(()=>{});if(upcoming && upcoming.start<sessionEnd)guide.record(upcoming.ref).catch(()=>{});}
    const audioEvents=practiceMode==='audio'?policy.observe(update):[];
    if(practiceMode==='audio'?audioEvents.some(e=>e.type==='mistake'):newMistake) sound();
    const missing=sessionEnd-sessionStart-[...practice.confirmed].filter(i=>i>=sessionStart && i<sessionEnd).length;
    if(update.cursor===sessionEnd && !missing) {
      stopCapture();mode='complete';
      status('Session complete','You finished this range. Revisit marked words or choose New test.');
      if(practiceMode==='audio')chime();
    } else if(practiceMode==='audio') {
      if(update.boundary && policy.focus) {
        const action=policy.boundary();
        if(action?.type==='help'){playHelp(action.index);return;}
        if(action?.type==='retry')realign(Math.max(currentAyah(action.index).start,action.index-3));
      }
      if(policy.focus)status('Listening · Try again',`Go back a few words and correct the mistake. ${policy.focus.attempts} of ${settings.attempts} unsuccessful attempts; unclear recognition doesn’t count.`);
      else if(newUnclear)status('Listening · Unclear','Recognition was unclear. Repeat naturally if needed; this did not use an attempt.');
      else if(changed || update.boundary)status('Listening',update.rewound?'Following your repeat. Continue from there.':'Keep reciting. Say “Stop”, “Repeat”, “Help”, or “New test” when needed.');
    } else if(update.cursor===sessionEnd) {
      status('End reached · Still listening',
        `You reached the end. ${missing} word${missing===1?' needs':'s need'} another pass. Go back a few words and recite again, or use “Retry marked word”.`);
    } else if(changed) {
      const marked=retryIndex()!==undefined;
      status(update.rewound?'Listening · Repeating':newWrong?'Wrong word':newSkipped?'Skipped word':newUnclear?'Unclear word':'Listening',update.rewound?
        'Following your repeat. Keep reciting from there; earlier words and review marks stay visible.':marked?
        'Marked words are visible: amber means unclear, red means wrong. Keep reciting or go back and repeat.':
        'Keep reciting at your own pace. You can go back a few words and the tracker will follow.');
    }
  }
  function paused(message='Your place is saved. Resume when you’re ready.') {
    const live=['live','loading','audio-paused'].includes(mode);
    stopCapture();
    if(live) mode='paused';
    if(live) status('Paused',message);
    activateIdleShell();
  }
  function db() {
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open('hifz-recitation',1);
      req.onupgradeneeded=()=>req.result.createObjectStore('models');
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
  }
  async function stored(action,value) {
    const database=await db();
    return new Promise((resolve,reject)=>{
      const tx=database.transaction('models',action==='get'?'readonly':'readwrite'), store=tx.objectStore('models');
      const request=action==='get'?store.get(data.catalog.model.modelSha256):action==='put'?store.put(value,data.catalog.model.modelSha256):store.delete(data.catalog.model.modelSha256);
      tx.oncomplete=()=>{ database.close();resolve(request.result); };
      tx.onerror=()=>{ database.close();reject(tx.error); }; tx.onabort=tx.onerror;
    });
  }
  async function hash(bytes,algorithm='SHA-256') { return Array.from(new Uint8Array(await crypto.subtle.digest(algorithm,bytes)),b=>b.toString(16).padStart(2,'0')).join(''); }
  async function validate(record) {
    if(!record || record.model.size!==data.catalog.model.modelBytes) throw Error('Import the approved v3.1 INT8 model and tokens.txt first.');
    const bytes=await record.model.arrayBuffer();
    if(await hash(bytes)!==data.catalog.model.modelSha256) throw Error('The model checksum does not match the pinned v3.1 INT8 release.');
    const tokenData=new TextEncoder().encode(record.tokens);
    if(tokenData.length!==data.catalog.model.tokensBytes) throw Error('Token table size does not match the approved release.');
    const prefix=new TextEncoder().encode('blob '+tokenData.length+'\0'), gitBlob=new Uint8Array(prefix.length+tokenData.length);
    gitBlob.set(prefix); gitBlob.set(tokenData,prefix.length);
    if(await hash(gitBlob,'SHA-1')!==data.catalog.model.tokensGitBlob && await hash(tokenData)!==data.catalog.model.deployedTokensSha256) throw Error('The token table does not match a pinned source.');
    const tokens=ReciteCore.parseTokens(record.tokens);
    // Verify the independently generated page can be expressed by this exact table.
    const alphabet=new Set(tokens.slice(0,250).join(''));
    if(words.some(w=>w.phones?.some(p=>Array.from(p.replace(/\s/gu,'')).some(c=>!alphabet.has(c))))) throw Error('The phoneme fixture is incompatible with this token table.');
    return {bytes,tokens};
  }
  async function install() {
    ui.Import.disabled=true;
    try {
      const model=ui.ModelFile.files[0], file=ui.TokensFile.files[0];
      if(!model || !file) throw Error('Choose both the ONNX model and tokens.txt.');
      if(file.size>20000) throw Error('Unexpected token table size.');
      ui.ModelStatus.textContent='Checking the model checksum…';
      const record={model,tokens:await file.text()}; await validate(record); await stored('put',record);
      modelInstalled=true; ui.DeleteModel.hidden=false;
      ui.ModelStatus.textContent='v3.1 INT8 saved in this browser. Ready for a microphone trial.';
      ui.ModelFile.value=''; ui.TokensFile.value='';
      if(navigator.storage?.persist) navigator.storage.persist().catch(()=>{});
    } catch(e) { ui.ModelStatus.textContent=e.message; }
    finally { ui.Import.disabled=false; }
  }
  async function start() {
    if(mode==='audio-paused'){resumeAudio();return;}
    if(preparing || !initialized || !visible || mode==='loading' || mode==='live' || revealed || practice.waitingRetry) return;
    if(location.protocol==='file:' || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      ui.Setup.open=true;
      status('Open the HTTPS app','Microphone recognition needs HTTPS. Open the hosted Hifz Companion app, then start reciting.'); return;
    }
    stopCapture();resetDiagnostics();practice.index=Math.min(practice.index,sessionEnd-1);
    mode='loading'; const token=epoch;
    status('Preparing recognition','Loading the saved model. You can cancel at any time.');
    try {
      if(practiceMode==='audio'){await guide.unlock();if(token!==epoch)return;}
      reference=await data.window(practice.index,sessionEnd);if(token!==epoch)return;
      let record=await stored('get'); if(token!==epoch) return;
      if(!record) {
        status('Preparing recognition','Saving the downloaded model in this browser for future offline sessions. You can cancel.');
        const abort=new AbortController();cancelReady=()=>abort.abort();
        const responses=await Promise.all([
          fetch('assets/models/recite/zipformer_p_arabic_v3.1.int8.onnx',{signal:abort.signal}),
          fetch('assets/models/recite/tokens-prompter.txt',{signal:abort.signal})
        ]);
        if(responses.some(r=>!r.ok)) throw Error('Recognition model could not download. Check your connection or import the model in setup.');
        record={model:await responses[0].blob(),tokens:await responses[1].text()};
        if(token!==epoch) return;
        await validate(record);if(token!==epoch) return;
        await stored('put',record);if(token!==epoch) return;
        cancelReady=null;modelInstalled=true;ui.DeleteModel.hidden=false;
        if(navigator.storage?.persist) navigator.storage.persist().catch(()=>{});
      }
      const {bytes,tokens}=await validate(record); if(token!==epoch) return;
      const currentWorker=new Worker('recite-worker.js'); worker=currentWorker;
      alignmentGeneration=0;
      await new Promise((resolve,reject)=>{
        cancelReady=()=>reject(new DOMException('Cancelled','AbortError'));
        currentWorker.onerror=()=>{
          if(token!==epoch) return;
          const message='Recognition worker could not load. Reload the HTTPS app and try again.';
          if(mode==='loading') reject(Error(message));
          else { paused(); status('Recognition paused',message); }
        };
        currentWorker.onmessage=({data})=>{
          if(token!==epoch) return;
          if(data.type==='ready') { cancelReady=null; resolve(); }
          else if(data.type==='error') {
            if(mode==='loading') reject(Error(data.message));
            else { paused(); status('Recognition paused',data.message); }
          } else if(data.type==='heard' && !preparing && mode==='live' && !guide.blocked && (data.generation===undefined || data.generation===alignmentGeneration)) {
            heard(data);
          } else if(data.type==='tracking' && !preparing && mode==='live' && !guide.blocked && data.generation===alignmentGeneration) {
            if(commands.pending){heldTracking.push(globalTracking(data));if(heldTracking.length>10)heldTracking.shift();}
            else tracked(globalTracking(data));
          } else if(data.type==='timing') {
            const timing=`${Math.round(data.pipelineMs)} ms processing per 480 ms audio · ${Math.round(data.queuedMs)} ms queued.`;
            ui.ModelStatus.textContent='v3.1 INT8 · '+timing;ui.LiveTiming.textContent=timing;
          }
        };
        currentWorker.postMessage({type:'init',model:bytes,tokens,words:reference.words,offset:reference.offset,startIndex:practice.index-reference.offset,generation:alignmentGeneration},[bytes]);
      });
      if(token!==epoch) return;
      const AudioContextClass=window.AudioContext || window.webkitAudioContext;
      try { context=new AudioContextClass({sampleRate:16000}); }
      catch(_) { context=new AudioContextClass(); }
      await context.audioWorklet.addModule('recite-audio.js'); if(token!==epoch) return;
      status('Allow microphone access','Your voice is processed on this device. Allow the microphone to begin, or cancel.');
      const mic=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:16000,echoCancellation:practiceMode==='audio',noiseSuppression:false,autoGainControl:false},video:false});
      if(token!==epoch) { mic.getTracks().forEach(t=>t.stop()); return; }
      stream=mic;
      for(const track of stream.getTracks()) track.onended=()=>paused('Microphone disconnected. Your place is saved.');
      const source=context.createMediaStreamSource(stream);
      capture=new AudioWorkletNode(context,'recite-capture',{processorOptions:{chunkSize:practiceMode==='audio'?1600:7680}});
      capture.port.onmessage=({data})=>{ if(token===epoch) microphonePacket(data); };
      source.connect(capture).connect(context.destination); await context.resume();
      if(token!==epoch) return;
      mode='live'; status('Listening','Begin at the outlined word. Keep reciting; words return when confirmed.');
      if(practiceMode==='audio') {
        requestWakeLock();playCue();
        if(settings.commands)commands.start().catch(error=>{if(token===epoch && error.name!=='AbortError')ui.CommandsStatus.textContent='Voice commands unavailable: '+error.message;});
        else ui.CommandsStatus.textContent='Voice commands off. Use the controls to pause or ask for help.';
        const next=ayahs[ayahs.indexOf(currentAyah())+1];
        if(next)guide.buffer(next.ref).catch(()=>{});
      }
    } catch(e) {
      if(token!==epoch) return;
      stopCapture(); mode='paused';
      status('Could not start',e.name==='NotAllowedError'?'Microphone permission was denied. Allow access in your browser and try again.':e.message);
    }
  }
  ui.Start.addEventListener('click',start);
  ui.Demo.addEventListener('click',()=>{ stopCapture();resetDiagnostics();mode='demo';ui.HeardOutput.textContent='No model output in the button-operated demo.';status('Demo · Your turn','No microphone is used. Try the buttons below to explore word reveals and retries.'); });
  ui.DemoNext.addEventListener('click',()=>{ if(mode==='demo') correct(); });
  ui.DemoMistake.addEventListener('click',()=>{ if(mode==='demo') mistake(); });
  ui.Retry.addEventListener('click',async()=>{
    if(mode==='loading' || revealed) return;
    if(mode==='demo') {
      practice.retry();status('Demo · Try again','Read next word to simulate a successful retry. The revisit highlight will remain.');return;
    }
    const index=retryIndex();if(index===undefined) return;
    guide.cancel();ui.Interrupt.hidden=true;
    if(mode==='live' && worker) {
      await realign(index);if(policy.focus)policy.focus.armed=true;
      status('Listening · Retry','Begin at the outlined word and keep reciting. Your microphone is still listening.');
    } else {practice.index=index;practice.retry();start();}
  });
  ui.Pause.addEventListener('click',()=>{if(practiceMode==='audio' && mode==='live')audioPause();else paused();});
  ui.EndSession.addEventListener('click',()=>paused('Session ended. Microphone and voice commands are off; your place is saved.'));
  ui.VisualMode.addEventListener('click',()=>switchMode('visual'));ui.AudioMode.addEventListener('click',()=>switchMode('audio'));
  ui.Attempts.addEventListener('change',saveSettings);ui.CueWords.addEventListener('change',saveSettings);
  ui.VoiceCommands.addEventListener('change',()=>{
    saveSettings();commands.stop();
    if(settings.commands && practiceMode==='audio' && ['live','audio-paused'].includes(mode))commands.start().catch(error=>{if(error.name!=='AbortError')ui.CommandsStatus.textContent=error.message;});
    else ui.CommandsStatus.textContent='Voice commands off.';
  });
  ui.PlayCue.addEventListener('click',()=>{resumeAudio();playCue();});
  ui.PlayHelp.addEventListener('click',()=>{resumeAudio();guide.cancel();playHelp();});
  ui.Interrupt.addEventListener('click',()=>bargeIn());
  ui.NewTest.addEventListener('click',newTest);ui.CacheAudio.addEventListener('click',cacheAudio);
  ui.Hint.addEventListener('click',()=>{ practice.hint(); status('A little help','The current word is visible. Recite it to continue; it will stay marked for review.'); });
  ui.Restart.addEventListener('click',async()=>{ stopCapture();practice.reset();policy.focus=null;practice.index=sessionStart;await realign(sessionStart,true);guideTarget=sessionStart;resetDiagnostics();revealed=false;mode='idle';status('Ready to practice','The opening cue words are visible. Begin at the first word; the outline shows your place.'); });
  ui.Reveal.addEventListener('click',()=>{ stopCapture(); mode='idle'; revealed=true; status('Page revealed','Practice has ended. Read through the page, then start over for another pass.'); });
  ui.Import.addEventListener('click',install);
  ui.DeleteModel.addEventListener('click',async()=>{
    paused();
    try { await stored('delete'); modelInstalled=false;ui.DeleteModel.hidden=true;ui.ModelStatus.textContent='Saved model removed.'; }
    catch(e) { ui.ModelStatus.textContent=e.message; }
  });
  document.addEventListener('visibilitychange',()=>{ if(document.hidden)paused(practiceMode==='audio'?'Audio practice paused because this app left the foreground. Resume with the app open.':'Your place is saved. Resume when you’re ready.'); });
  window.addEventListener('pagehide',()=>{ persistSession();stopCapture();guide.close();if(cueSound) cueSound.close().catch(()=>{}); cueSound=null; });
  window.HIFZ_RECITE={
    enter() { visible=true; render();if(!initialized && !preparing)newTest();
      if(location.protocol!=='file:' && 'serviceWorker' in navigator)navigator.serviceWorker.register('recite-sw.js').then(registration=>{
        shellRegistration=registration;activateIdleShell();
        const watch=installing=>installing?.addEventListener('statechange',()=>{if(installing.state==='installed')activateIdleShell();});
        watch(registration.installing);registration.addEventListener('updatefound',()=>watch(registration.installing));
      }).catch(()=>{});
    },
    leave() { visible=false; paused(); if(cueSound) cueSound.suspend().catch(()=>{}); },
  };
  stored('get').then(record=>{
    modelInstalled=!!record;ui.DeleteModel.hidden=!record;
    if(record) ui.ModelStatus.textContent='Saved v3.1 INT8 model found. Checksum is verified before each start.';
  }).catch(()=>{ ui.ModelStatus.textContent='Browser storage is unavailable here. Open the HTTPS app to save the model.'; });
  function rangeControls() {
    ui.PageRange.hidden=range.mode!=='pages';ui.AyahRange.hidden=range.mode!=='ayah';
    document.querySelector(`input[name="reciteRangeMode"][value="${range.mode}"]`).checked=true;
    ui.StartPage.value=range.startPage;ui.EndPage.value=range.endPage;
    for(const side of ['Start','End']) {
      const [chapter,verse]=range[side.toLowerCase()+'Ref'].split(':').map(Number);
      ui[side+'Surah'].value=chapter;fillAyahs(side,verse);
    }
  }
  function fillAyahs(side,selected=1) {
    const chapter=+ui[side+'Surah'].value,select=ui[side+'Ayah'];select.replaceChildren();
    for(const ayah of ayahs.filter(a=>a.s===chapter)) {
      const option=document.createElement('option');option.value=ayah.a;option.textContent=ayah.a;select.append(option);
    }
    select.value=Math.min(+selected || 1,select.options.length);
  }
  function readRange() {
    const clamp=value=>Math.max(1,Math.min(604,Math.round(+value || 1)));
    return {mode:document.querySelector('input[name="reciteRangeMode"]:checked').value,
      startPage:clamp(ui.StartPage.value),endPage:clamp(ui.EndPage.value),
      startRef:`${ui.StartSurah.value}:${ui.StartAyah.value}`,endRef:`${ui.EndSurah.value}:${ui.EndAyah.value}`};
  }
  function normalizeRange(value) {
    const result={...value},pool=data.pool(result);
    if(!pool.length)throw Error('Choose a Quran range.');
    if(result.mode==='pages') {
      result.startPage=Math.min(value.startPage,value.endPage);result.endPage=Math.max(value.startPage,value.endPage);
      result.startRef=pool[0].ref;result.endRef=pool.at(-1).ref;
    } else {
      result.startRef=pool[0].ref;result.endRef=pool.at(-1).ref;
      result.startPage=pool[0].page;result.endPage=pool.at(-1).page;
    }
    return result;
  }
  function changeRange() {
    stopCapture();++preparation;preparing=false;mode='idle';
    range=normalizeRange(readRange());rangeControls();
    try{localStorage.setItem('hifz-recite-range-v2',JSON.stringify(range));}catch(_){}
    newTest();
  }
  for(const side of ['Start','End']) {
    for(const chapter of ayahs.filter(a=>a.a===1)) {
      const option=document.createElement('option');option.value=chapter.s;
      option.textContent=`${chapter.s}. ${chapter.name} (${window.QURAN_AYAT.find(a=>a.s===chapter.s).s_ar})`;
      ui[side+'Surah'].append(option);
    }
    ui[side+'Surah'].addEventListener('change',()=>{fillAyahs(side);changeRange();});
    ui[side+'Ayah'].addEventListener('change',changeRange);
  }
  for(const input of [ui.StartPage,ui.EndPage,...document.querySelectorAll('input[name="reciteRangeMode"]')])input.addEventListener('change',changeRange);
  async function initialize() {
    preparing=true;ui.Start.disabled=ui.Demo.disabled=true;
    try {
      try {
        const storedRange=JSON.parse(localStorage.getItem('hifz-recite-range-v2'));
        if(storedRange && ['pages','ayah'].includes(storedRange.mode) && data.pool(storedRange).length)range=storedRange;
      }catch(_){}
      range=normalizeRange(range);rangeControls();
      try{localStorage.setItem('hifz-recite-range-v2',JSON.stringify(range));}catch(_){}
      let saved;
      try{saved=JSON.parse(localStorage.getItem('hifz-recite-session-v2'));}catch(_){}
      const candidate=saved && data.byRef.get(saved.origin),pool=data.pool(range);
      const valid=i=>Number.isInteger(i) && i>=0 && i<words.length;
      if(candidate && JSON.stringify(saved.range)===JSON.stringify(range) && pool.includes(candidate) && saved.start===candidate.start && saved.end===pool.at(-1).end && Number.isInteger(saved.index) && saved.index>=0 && saved.index<=saved.end) {
        sessionStart=saved.start;sessionEnd=saved.end;origin=candidate;practice.index=saved.index;
        for(const key of ['confirmed','exposed','mistakes','uncertain','hints'])practice[key]=new Set((saved[key] || []).filter(i=>valid(i) && i>=sessionStart && i<sessionEnd));
        practice.states=new Map((saved.states || []).filter(([i])=>valid(i) && i>=sessionStart && i<sessionEnd));
        for(const word of saved.marks || [])if(valid(word.g) && data.ayah(word.g).ref===word.ref)words[word.g]=word;
        reference=await data.window(Math.min(practice.index,sessionEnd-1),sessionEnd);
        await data.ensure(origin.start,Math.min(origin.end,origin.start+settings.cueWords));guideTarget=origin.start;
        if(saved.focus && valid(saved.focus.index) && saved.focus.index>=sessionStart && saved.focus.index<sessionEnd)policy.focus={index:saved.focus.index,attempts:Math.max(0,+saved.focus.attempts || 0),armed:true};
        mode=practice.index===sessionEnd && practice.confirmed.size===sessionEnd-sessionStart?'complete':'paused';
        initialized=true;preparing=false;resetDiagnostics();
        status(mode==='complete'?'Range complete':'Your place is saved',mode==='complete'?'Choose New test for another random starting ayah.':'Resume when ready. Review marks and your retry allowance are preserved.');
      } else {preparing=false;await newTest();}
    } catch(error){preparing=false;status('Could not load Recite',error.message);}
  }
  initialize();
})();
