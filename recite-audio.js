/* Worklet capture: downmix, antialias and resample to 16 kHz; no uploads. */
class ReciteCapture extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.size=options.processorOptions?.chunkSize || 7680;
    this.buffer=[]; this.offset=0; this.position=0; this.chunk=new Float32Array(this.size); this.used=0;
    this.cutoff=Math.min(1,16000/sampleRate)*.9;
  }
  process(inputs,outputs) {
    // The graph remains connected, but the user's microphone is never monitored.
    for(const channels of outputs) for(const channel of channels) channel.fill(0);
    const channels=inputs[0]; if(!channels || !channels.length) return true;
    // Match Prompter's 480 ms packets; no resampling at the requested 16 kHz.
    if(sampleRate===16000) {
      for(let i=0;i<channels[0].length;i++) {
        this.chunk[this.used++]=channels.reduce((sum,c)=>sum+c[i],0)/channels.length;
        if(this.used===this.size) { this.port.postMessage(this.chunk,[this.chunk.buffer]); this.chunk=new Float32Array(this.size);this.used=0; }
      }
      return true;
    }
    for(let i=0;i<channels[0].length;i++) this.buffer.push(channels.reduce((sum,c)=>sum+c[i],0)/channels.length);
    const end=this.offset+this.buffer.length;
    while(this.position+24<end) {
      let sum=0,weights=0;
      for(let tap=-23;tap<=24;tap++) {
        const pos=Math.floor(this.position)+tap, distance=pos-this.position;
        const sinc=Math.abs(distance)<1e-8 ? this.cutoff : Math.sin(Math.PI*this.cutoff*distance)/(Math.PI*distance);
        const window=.5+.5*Math.cos(Math.PI*distance/24), weight=sinc*window;
        const idx=Math.max(0,pos)-this.offset;
        sum+=(this.buffer[idx] || 0)*weight; weights+=weight;
      }
      this.chunk[this.used++]=sum/weights; this.position+=sampleRate/16000;
      if(this.used===this.size) { this.port.postMessage(this.chunk,[this.chunk.buffer]); this.chunk=new Float32Array(this.size);this.used=0; }
    }
    const discard=Math.max(0,Math.floor(this.position)-24-this.offset);
    if(discard) { this.buffer.splice(0,discard); this.offset+=discard; }
    return true;
  }
}
registerProcessor('recite-capture',ReciteCapture);
