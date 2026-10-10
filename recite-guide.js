/* Client-only Sudais playback and expiring browser cache. Recognition is quarantined through playback and echo
   tail. A muted probe confirms speech before barge-in; car AEC needs a trial. */
(function(root) {
  'use strict';
  class SudaisGuide {
    constructor(catalog,notify,interrupted) {
      this.ayahs=new Map(catalog.ayahs.map(a=>[a.ref,a]));
      this.manifest={reciter:'Abdur-Rahman as-Sudais',ayahs:{}};
      this.notify=notify;this.interrupted=interrupted;
      this.cacheName='hifz-sudais-v3';this.records=new Map();
      this.purgeExpired().catch(()=>{});
      this.buffers=new Map();this.epoch=0;this.blocked=false;this.source=null;
      this.noise=.003;this.cooldown=0;this.probe=null;this.state='idle';
    }
    async unlock() {
      this.context ||= new (window.AudioContext || window.webkitAudioContext)();
      if(!this.gain){this.gain=this.context.createGain();this.gain.connect(this.context.destination);}
      await this.context.resume();
    }
    metadataUrl(ref) {
      if(!this.ayahs.has(ref))throw Error('Choose a valid Quran ayah.');
      return `https://api.quran.com/api/v4/recitations/3/by_ayah/${ref}?fields=segments`;
    }
    async cache() {
      if(!root.caches)return null;
      try{return await caches.open(this.cacheName);}catch(_){return null;}
    }
    async purgeExpired() {
      const cache=await this.cache();if(!cache)return;
      for(const request of await cache.keys()) {
        if(!request.url.startsWith('https://api.quran.com/'))continue;
        const response=await cache.match(request);
        let record;try{record=await response.json();}catch(_){}
        if(!record || !(Date.parse(record.expiresAt)>Date.now())) {
          await cache.delete(request);if(record?.url)await cache.delete(record.url);
        }
      }
      // Remove the previous localhost endpoint caches during the migration.
      await Promise.all(['hifz-sudais-pilot-v1','hifz-sudais-v2'].map(name=>caches.delete(name)));
    }
    async saveRecord(record) {
      this.manifest.ayahs[record.ref]=record;
      const cache=await this.cache();
      if(cache)try{await cache.put(this.metadataUrl(record.ref),new Response(JSON.stringify(record),{headers:{'Content-Type':'application/json'}}));}catch(_){}
    }
    interpret(ref,item) {
      if(item.verse_key!==ref)throw Error('The audio source returned a different ayah.');
      const source=new URL(item.url,'https://verses.quran.com/');
      if(source.origin!=='https://verses.quran.com' || !source.pathname.startsWith('/Sudais/mp3/'))throw Error('Unexpected Sudais recording source.');
      let segments=item.segments || [];const issues=[];
      if(!Array.isArray(segments) || segments.some(seg=>!Array.isArray(seg) || seg.length!==4 ||
          seg.some(v=>!Number.isInteger(v)) || seg[0]<0 || seg[1]<=seg[0] || seg[2]<0 || seg[3]<=seg[2])) {
        segments=[];issues.push('Invalid word timing data');
      }
      const ayah=this.ayahs.get(ref),count=ayah.end-ayah.start;
      const covered=segments.filter(seg=>seg[1]===seg[0]+1).map(seg=>seg[1]);
      const missing=Array.from({length:count},(_,i)=>i+1).filter(i=>!covered.includes(i));
      if(missing.length)issues.push('Missing word timings: '+missing.join(', '));
      if(new Set(covered).size!==covered.length)issues.push('Duplicate word timings');
      if(segments.some(seg=>seg[1]!==seg[0]+1 || seg[1]>count))issues.push('Grouped or out-of-range timing spans');
      if(segments.some((seg,i)=>i && (seg[2]<segments[i-1][3] || seg[0]<=segments[i-1][0])))issues.push('Overlapping or unordered timing spans');
      const now=Date.now();
      return {ref,reciter:this.manifest.reciter,url:source.href,metadataUrl:this.metadataUrl(ref),segments,timingIssues:issues,
        fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+7*86400000).toISOString(),bytes:null,sha256:null};
    }
    async record(ref,signal) {
      signal?.throwIfAborted();
      const key=this.metadataUrl(ref);let record=this.manifest.ayahs[ref];
      if(record && Date.parse(record.expiresAt)>Date.now())return record;
      this.buffers.delete(ref);
      // Coalesce foreground/preload requests. Cancellable offline downloads
      // retain their own signal rather than cancelling another consumer's fetch.
      if(!signal && this.records.has(ref))return this.records.get(ref);
      const load=(async()=>{
        const cache=await this.cache(),cached=cache && await cache.match(key);
        if(cached) {
          try{record=await cached.json();}catch(_){record=null;}
          if(record?.ref===ref && Date.parse(record.expiresAt)>Date.now()) {
            this.manifest.ayahs[ref]=record;return record;
          }
          await cache.delete(key);if(record?.url)await cache.delete(record.url);
        }
        this.buffers.delete(ref);
        let response;
        try{response=await fetch(key,{signal,cache:'no-store',credentials:'omit'});}
        catch(error){if(error.name==='AbortError')throw error;throw Error('Connect to the internet to download or refresh this Sudais recording.');}
        if(!response.ok)throw Error('Quran.com audio metadata is temporarily unavailable. Try again.');
        const payload=await response.json(),items=payload.audio_files;
        if(!Array.isArray(items) || items.length!==1)throw Error(`Sudais audio is unavailable for ${ref}.`);
        record=this.interpret(ref,items[0]);await this.saveRecord(record);return record;
      })();
      if(!signal)this.records.set(ref,load);
      try{return await load;}finally{if(this.records.get(ref)===load)this.records.delete(ref);}
    }
    async audio(ref,signal,requireCache=false) {
      signal?.throwIfAborted();
      const record=await this.record(ref,signal),cache=await this.cache();
      if(requireCache && !cache)throw Error('This browser cannot save audio offline.');
      let response=cache && await cache.match(record.url),cached=!!response;
      if(!response) {
        try{response=await fetch(record.url,{signal,cache:'no-store',credentials:'omit'});}
        catch(error){if(error.name==='AbortError')throw error;throw Error('Connect to the internet to download this Sudais recording.');}
      }
      if(!response.ok)throw Error('The Sudais recording could not load. Try again.');
      const bytes=await response.clone().arrayBuffer();signal?.throwIfAborted();
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if(bytes.byteLength<1000 || (record.sha256 && (record.bytes!==bytes.byteLength || record.sha256!==digest))) {
        if(cache){await cache.delete(record.url);await cache.delete(this.metadataUrl(ref));}
        delete this.manifest.ayahs[ref];this.buffers.delete(ref);
        throw Error(`Sudais ${ref} failed its cache integrity check. Retry to download a fresh copy.`);
      }
      if(!record.sha256){record.bytes=bytes.byteLength;record.sha256=digest;await this.saveRecord(record);}
      if(cache && !cached)try{await cache.put(record.url,response.clone());}catch(error){if(requireCache)throw Error('Audio could not be saved. Check available browser storage.');}
      if(requireCache)await cache.put(this.metadataUrl(ref),new Response(JSON.stringify(record),{headers:{'Content-Type':'application/json'}}));
      return {record,bytes};
    }
    async buffer(ref) {
      await this.record(ref);
      if(!this.buffers.has(ref)) {
        const {bytes}=await this.audio(ref);
        this.buffers.set(ref,await this.context.decodeAudioData(bytes));
        if(this.buffers.size>8)this.buffers.delete(this.buffers.keys().next().value);
      }
      return this.buffers.get(ref);
    }
    async play(refs,cueWords=0) {
      this.cancel();const epoch=this.epoch;this.blocked=true;this.state='loading';
      this.notify('loading',refs[0]);
      try {
        await this.unlock();const clips=[];this.usedFullAyah=false;
        for(const ref of refs) {
          const buffer=await this.buffer(ref);if(epoch!==this.epoch)return;
          const segments=this.manifest.ayahs[ref].segments;
          const endpoint=segments.find(seg=>seg[1]===Math.min(cueWords,segments.length));
          const safeCue=cueWords && endpoint && segments[0]?.[0]===0 && !this.manifest.ayahs[ref].timingIssues?.length;
          this.usedFullAyah ||= !!cueWords && !safeCue;
          const start=safeCue?Math.max(0,segments[0][2]/1000-.03):0;
          const end=safeCue?Math.min(buffer.duration,endpoint[3]/1000):buffer.duration;
          if(end<=start)throw Error(`Invalid cue timing for ${ref}.`);
          clips.push({ref,buffer,start,end});
        }
        if(epoch!==this.epoch)return;
        this.clips=clips;this.clipIndex=0;this.begin(clips[0].start,epoch);
      } catch(error) {
        if(epoch!==this.epoch)return;
        this.cancel();this.notify('error',error.message);
      }
    }
    begin(offset,epoch) {
      const clip=this.clips[this.clipIndex];this.stopSource();this.probe=null;
      this.offset=offset;this.started=this.context.currentTime;this.startedWall=performance.now();
      this.gain.gain.value=1;this.state='playing';this.notify('playing',clip.ref);
      const source=this.context.createBufferSource();this.source=source;source.buffer=clip.buffer;
      source.connect(this.gain);source.start(0,offset,Math.max(.01,clip.end-offset));
      source.onended=()=>{
        source.disconnect();if(this.source!==source || epoch!==this.epoch)return;
        this.source=null;this.probe=null;
        if(++this.clipIndex<this.clips.length)this.begin(this.clips[this.clipIndex].start,epoch);
        else {
          this.state='tail';this.notify('tail',clip.ref);
          this.timer=setTimeout(()=>{if(epoch!==this.epoch)return;this.blocked=false;this.state='idle';this.notify('ended',clip.ref);},500);
        }
      };
    }
    observe(samples) {
      const rms=Math.sqrt(samples.reduce((n,v)=>n+v*v,0)/samples.length);
      const now=performance.now();
      if(!this.blocked) {
        if(rms<.015)this.noise=this.noise*.98+rms*.02;
        return false;
      }
      if(this.state!=='playing' || !this.source)return true;
      if(this.probe) {
        const p=this.probe;
        // Discard the first muted 100 ms to let loudspeaker echo decay.
        if(now-p.at>120) {
          p.samples.push(samples.slice());
          p.voiced=rms>Math.max(.012,this.noise*3)?p.voiced+1:0;
        }
        if(p.voiced>=2) {
          const clean=p.samples.slice(-3);this.cancel();
          this.interrupted(clean);return true;
        }
        if(now-p.at>450) {
          const offset=p.offset;this.cooldown=now+1200;this.begin(offset,this.epoch);
        }
      } else if(now>this.cooldown && now-this.startedWall>350 && rms>Math.max(.018,this.noise*4)) {
        this.probe={at:now,offset:this.offset+this.context.currentTime-this.started,samples:[],voiced:0};
        this.gain.gain.setTargetAtTime(0,this.context.currentTime,.01);
      }
      return true;
    }
    stopSource() {
      if(this.source) {const source=this.source;this.source=null;source.onended=null;try{source.stop();}catch(_){}source.disconnect();}
    }
    cancel() {
      this.epoch++;clearTimeout(this.timer);this.stopSource();this.probe=null;
      this.blocked=false;this.state='idle';
    }
    close() {this.cancel();if(this.context)this.context.close().catch(()=>{});this.context=null;this.gain=null;}
  }

  class RetryPolicy {
    constructor(limit=3) {this.limit=limit;this.focus=null;}
    observe(update) {
      const events=[];
      if(this.focus && update.rewound && update.rewound.to<=this.focus.index) this.focus.armed=true;
      for(const verdict of update.changes) {
        if(this.focus && verdict.index===this.focus.index && verdict.state==='ok') {
          events.push({type:'corrected',index:this.focus.index});this.focus=null;continue;
        }
        if(!['wrong','skipped'].includes(verdict.state))continue;
        if(!this.focus) this.focus={index:verdict.index,attempts:0,armed:true};
        if(verdict.index===this.focus.index && this.focus.armed) {
          this.focus.attempts++;this.focus.armed=false;
          events.push({type:'mistake',...this.focus});
        }
      }
      return events;
    }
    boundary() {
      if(!this.focus || this.focus.armed)return null;
      if(this.focus.attempts>=this.limit)return {type:'help',index:this.focus.index};
      this.focus.armed=true;return {type:'retry',index:this.focus.index};
    }
    helped() {if(this.focus){this.focus.attempts=0;this.focus.armed=true;}}
  }
  root.ReciteGuide=SudaisGuide;root.ReciteRetryPolicy=RetryPolicy;
})(globalThis);
