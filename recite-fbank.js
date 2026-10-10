/* Kaldi-compatible streaming fbank, independently implemented from the documented
   frontend contract. Kept separate so numerical parity can be tested without ASR. */
(function(root) {
  'use strict';
  class Fbank {
    constructor() {
      this.samples=new Float32Array(0); this.offset=0; this.frames=0;
      this.window=Float32Array.from({length:400},(_,i)=>Math.pow(.5-.5*Math.cos(2*Math.PI*i/399),.85));
      this.filters=[];
      const mel=hz=>1127*Math.log(1+hz/700), low=mel(20), high=mel(7600);
      for(let b=0;b<80;b++) {
        const left=low+(high-low)*b/81, mid=low+(high-low)*(b+1)/81, right=low+(high-low)*(b+2)/81;
        this.filters.push(Float64Array.from({length:256},(_,i)=>Math.max(0,Math.min((mel(i*16000/512)-left)/(mid-left),(right-mel(i*16000/512))/(right-mid)))));
      }
    }
    frame(index,total) {
      const start=index*160-120, input=new Float64Array(400);
      for(let j=0;j<400;j++) {
        let pos=start+j;
        while(pos<0 || pos>=total) pos=pos<0 ? -pos-1 : 2*total-1-pos;
        input[j]=this.samples[pos-this.offset];
      }
      const mean=input.reduce((a,b)=>a+b,0)/400;
      for(let j=0;j<400;j++) input[j]-=mean;
      for(let j=399;j>0;j--) input[j]-=.97*input[j-1];
      input[0]*=.03;
      const real=new Float64Array(512), imag=new Float64Array(512);
      for(let j=0;j<400;j++) real[j]=input[j]*this.window[j];
      for(let i=1,j=0;i<512;i++) {
        let bit=256; for(;j&bit;bit>>=1) j^=bit; j^=bit;
        if(i<j) [real[i],real[j]]=[real[j],real[i]];
      }
      for(let size=2;size<=512;size*=2) {
        for(let start=0;start<512;start+=size) {
          for(let j=0;j<size/2;j++) {
            const angle=-2*Math.PI*j/size,c=Math.cos(angle),s=Math.sin(angle), a=start+j,b=a+size/2;
            const r=real[b]*c-imag[b]*s, im=real[b]*s+imag[b]*c;
            real[b]=real[a]-r; imag[b]=imag[a]-im; real[a]+=r; imag[a]+=im;
          }
        }
      }
      const power=Float64Array.from({length:256},(_,i)=>real[i]**2+imag[i]**2);
      return Float32Array.from(this.filters,f=>Math.log(Math.max(1.1920928955078125e-7,f.reduce((sum,w,i)=>sum+w*power[i],0))));
    }
    push(samples, finished=false) {
      const next=new Float32Array(this.samples.length+samples.length);
      next.set(this.samples); next.set(samples,this.samples.length); this.samples=next;
      const total=this.offset+next.length, output=[];
      const limit=finished ? Math.floor((total+80)/160) : Math.max(0,Math.floor((total-280)/160)+1);
      while(this.frames<limit) output.push(this.frame(this.frames++,total));
      const keep=Math.max(this.offset,this.frames*160-120);
      this.samples=this.samples.slice(keep-this.offset); this.offset=keep;
      return output;
    }
  }
  if(typeof module!=='undefined') module.exports={Fbank};
  root.ReciteFbank=Fbank;
})(typeof globalThis!=='undefined'?globalThis:this);
