/* Canonical global word indices; page geometry and phonemes load on demand.
   Recognition receives an overlapping window, never the whole Quran graph. */
(function(root) {
  'use strict';
  class ReciteData {
    constructor(catalog) {
      this.catalog=catalog;this.ayahs=catalog.ayahs;this.byRef=new Map(this.ayahs.map(a=>[a.ref,a]));
      this.words=new Array(catalog.wordCount);this.pages=new Map();this.pending=new Map();
      for(const page of Object.values(root.RECITE_PAGES || {}))if(page.words.every(w=>Number.isInteger(w.g)))this.add(page);
    }
    add(page) {
      for(const w of page.words)this.words[w.g]={...w,page:page.page};
      this.pages.set(page.page,page);return page;
    }
    ayah(index) {
      index=Math.max(0,Math.min(this.words.length-1,index));
      let lo=0,hi=this.ayahs.length-1;
      while(lo<hi){const mid=(lo+hi)>>1;if(this.ayahs[mid].end<=index)lo=mid+1;else hi=mid;}
      return this.ayahs[lo];
    }
    pageNumber(index) {
      index=Math.max(0,Math.min(this.words.length-1,index));
      let lo=1,hi=604;
      while(lo<hi){const mid=(lo+hi)>>1;if(this.catalog.pages[mid].end<=index)lo=mid+1;else hi=mid;}
      return lo;
    }
    async loadPage(number) {
      if(this.pages.has(number))return this.pages.get(number);
      if(!this.pending.has(number))this.pending.set(number,(async()=>{
        let response;
        try{response=await fetch(`data/recite/pages/${number}.json`);}catch(_){throw Error(`Page ${number} is not saved here. Connect to the HTTPS app before practicing this range.`);}
        if(!response.ok)throw Error(`Page ${number} could not load. Connect to the HTTPS app to download this range first.`);
        const page=await response.json(),bounds=this.catalog.pages[number];
        if(page.page!==number || page.words.length!==bounds.words || page.words.some((w,i)=>w.g!==bounds.start+i))throw Error(`Page ${number} has inconsistent word references.`);
        return this.add(page);
      })().finally(()=>this.pending.delete(number)));
      return this.pending.get(number);
    }
    async ensure(start,end) {
      const first=this.pageNumber(start),last=this.pageNumber(Math.max(start,end-1));
      for(let p=first;p<=last;p++)await this.loadPage(p);
    }
    async window(index,end) {
      const current=this.ayah(Math.min(index,end-1)),prior=this.ayahs[this.ayahs.indexOf(current)-1];
      // Include a whole preceding ayah for first-word help and natural restarts.
      const start=this.ayah(Math.min(prior?.start ?? current.start,Math.max(0,index-12))).start;
      const number=this.pageNumber(index),next=Math.min(604,number+2);
      const pageEnd=this.catalog.pages[next].end;
      const stop=Math.min(end,this.ayah(Math.min(pageEnd-1,this.words.length-1)).end);
      await this.ensure(start,stop);
      for(let p=this.pageNumber(start);p<=this.pageNumber(stop-1);p++){const image=new Image();image.src=this.pages.get(p).image;}
      return {offset:start,end:stop,words:this.words.slice(start,stop)};
    }
    pool(range) {
      if(range.mode==='ayah') {
        let start=this.byRef.get(range.startRef),end=this.byRef.get(range.endRef);
        if(!start || !end)throw Error('Choose valid start and end ayahs.');
        if(start.start>end.start)[start,end]=[end,start];
        return this.ayahs.slice(this.ayahs.indexOf(start),this.ayahs.indexOf(end)+1);
      }
      const first=Math.min(range.startPage,range.endPage),last=Math.max(range.startPage,range.endPage);
      return this.ayahs.filter(a=>a.page>=first && a.page<=last);
    }
    pick(range,previous) {
      const pool=this.pool(range);if(!pool.length)throw Error('There are no ayahs in this range.');
      const choices=pool.length>1?pool.filter(a=>a.ref!==previous):pool;
      // Unbiased selection with rejection; avoid the previous prompt if possible.
      const ceiling=0x100000000-0x100000000%choices.length,random=new Uint32Array(1);
      do{crypto.getRandomValues(random);}while(random[0]>=ceiling);
      return {ayah:choices[random[0]%choices.length],end:pool.at(-1).end};
    }
  }
  root.ReciteData=ReciteData;
})(globalThis);
