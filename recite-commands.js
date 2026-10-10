/* Optional local English command recognizer, independent of Quran phonetics.
   Commands commit only on a final, confident, exact phrase. No cloud fallback. */
(function(root) {
  'use strict';
  const COMMANDS=['stop','resume','repeat','help','new test'];
  class Commands {
    constructor(command,notify) {this.command=command;this.notify=notify;this.epoch=0;this.lastAt=0;this.pending=false;}
    async start() {
      this.stop();const epoch=this.epoch;this.notify('Loading local voice commands…');
      if(!root.Vosk) {
        await new Promise((resolve,reject)=>{
          const script=document.createElement('script');script.src='assets/vendor/vosk-browser-0.0.8/vosk.js';
          script.onload=resolve;script.onerror=()=>reject(Error('Voice command runtime is missing.'));document.head.append(script);
        });
      }
      if(epoch!==this.epoch)return;
      const model=new Vosk.Model(new URL('assets/models/commands/vosk-model-small-en-us-0.15.tar.gz',location.href).href,-1);
      this.model=model;
      await new Promise((resolve,reject)=>{
        const finish=(error)=>{clearTimeout(timeout);this.cancelLoad=null;error?reject(error):resolve();};
        const timeout=setTimeout(()=>{finish(Error('Voice commands took too long to load.'));this.stop();},90000);
        this.cancelLoad=()=>finish(new DOMException('Cancelled','AbortError'));
        model.on('load',m=>finish(m.result?null:Error('Voice command model could not load.')));
        model.on('error',m=>finish(Error(m.error || 'Voice command model could not load.')));
      }).catch(error=>{if(epoch===this.epoch)this.stop();throw error;});
      if(epoch!==this.epoch){model.terminate();return;}
      const recognizer=new model.KaldiRecognizer(16000,JSON.stringify([...COMMANDS,'[unk]']));this.recognizer=recognizer;
      recognizer.setWords(true);
      recognizer.on('partialresult',m=>{
        if(epoch!==this.epoch)return;
        this.pending=COMMANDS.includes(m.result.partial);
      });
      recognizer.on('result',m=>{
        if(epoch!==this.epoch)return;
        this.pending=false;
        const text=m.result.text.trim().toLowerCase(), words=m.result.result || [];
        if(!COMMANDS.includes(text) || !words.length || words.some(w=>w.conf<.9) || performance.now()-this.lastAt<1500)return;
        this.lastAt=performance.now();this.notify(`Heard “${text}”`);this.command(text);
      });
      recognizer.on('error',m=>{if(epoch===this.epoch){this.notify('Voice commands unavailable: '+m.error);this.stop();}});
      this.notify('Listening for Stop · Resume · Repeat · Help · New test');
    }
    feed(samples) {if(this.recognizer)this.recognizer.acceptWaveformFloat(samples,16000);}
    reset() {this.pending=false;}
    stop() {
      this.epoch++;this.pending=false;this.recognizer=null;
      if(this.cancelLoad){const cancel=this.cancelLoad;this.cancelLoad=null;cancel();}
      if(this.model) {
        this.model.terminate();
        // The upstream graceful shutdown expects a loaded model. Cancel its
        // underlying Worker too when a user leaves during WASM initialization.
        this.model.worker?.terminate();
      }
      this.model=null;
    }
  }
  root.ReciteCommands=Commands;
})(globalThis);
