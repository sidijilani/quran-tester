/* Shared by the UI, worker and Node tests. Recognition never fills missing audio
   from the Quran text: only observed, finalized CTC emissions enter the matcher. */
(function (root) {
  'use strict';
  const BLANK = 250;
  // Matching settings observed in Prompter's main-Bme4fblZ.js (2026-10-09).
  // These are tracking tolerances, not a pronunciation or tajweed assessment.
  const MATCHING = Object.freeze({okDistance:.15, unsureDistance:.4, minMargin:.35,
    settleFrames:25, commitDwell:6, minHeardFraction:.34, repeatCost:10});
  const aliases={'ۦ':'ي','ۥ':'و','ں':'ن','۾':'م','ٱ':'ا','ى':'ي'};
  const vowels='َُِ', marks='ڇؙۣ۪ٞۜـ', hamzas='ءأإآاؤئٲ';
  const related=['ذدضتط','ظزذصسث','جزش','ةهت','قكغ','فبم','هح','غخ','ءع','نم','نل','ظض'];
  function phoneCost(a,b) {
    a=aliases[a] || a; b=aliases[b] || b;
    if(a===b) return 0;
    const av=vowels.includes(a), bv=vowels.includes(b);
    const am=av || marks.includes(a), bm=bv || marks.includes(b);
    if(am || bm) return am && bm ? (av && bv ? .1 : .25) : 1;
    if(hamzas.includes(a) && hamzas.includes(b)) return .1;
    return related.some(group=>group.includes(a) && group.includes(b)) ? .25 : 1;
  }
  function phoneDistance(heard,expected) {
    if(!heard.length || !expected.length) return heard===expected ? 0 : 1;
    let previous=Array.from({length:expected.length+1},(_,i)=>i);
    for(let i=1;i<=heard.length;i++) {
      const row=[i];
      for(let j=1;j<=expected.length;j++) row[j]=Math.min(
        previous[j]+1,row[j-1]+1,previous[j-1]+phoneCost(heard[i-1],expected[j-1]));
      previous=row;
    }
    return previous[expected.length]/Math.max(heard.length,expected.length);
  }
  function phones(text) {
    // Ignore duration choices for memorization; preserve consonants and gemination.
    return text.replace(/[\s\u0619]+/gu, '').replace(/([اۦۥ])\1+/gu, '$1');
  }
  function parseTokens(text) {
    const table = Array(251);
    for (const line of text.trim().split(/\r?\n/)) {
      const match = line.match(/^(.*?)\s+(\d+)\s*$/u);
      if (!match) throw Error('Invalid tokens.txt line.');
      const id = Number(match[2]);
      if (id > BLANK || table[id] !== undefined) throw Error('Unexpected or duplicate token ID.');
      table[id] = match[1];
    }
    if (table.some(x => x === undefined) || Object.keys(table).length !== 251 ||
        !/^<(?:blk|blank)>$/.test(table[BLANK])) throw Error('Expected 251 tokens with CTC blank at ID 250.');
    return table;
  }
  class CTC {
    constructor(table) {
      this.table=table; this.last=BLANK; this.pending=null;
      this.frameIndex=0; this.lastNonblankFrame=0; this.peak=-Infinity;
    }
    frame(logits) {
      if (logits.length !== 251) throw Error('Expected 251 CTC logits.');
      let best = 0, second = 1;
      if (logits[second] > logits[best]) [best, second] = [second, best];
      for (let i=2;i<251;i++) {
        if (logits[i] > logits[best]) { second=best; best=i; }
        else if (logits[i] > logits[second]) second=i;
      }
      const confidence = Math.max(0, Math.min(1, Math.exp(logits[best])-Math.exp(logits[second])));
      this.frameIndex++;
      if(best!==BLANK) this.lastNonblankFrame=this.frameIndex;
      let emission = null;
      if (best !== this.last) {
        emission = this.pending;
        this.pending = best === BLANK ? null : {text: this.table[best], confidence, frame:this.frameIndex};
        this.peak=logits[best];
      } else if (this.pending && logits[best]>this.peak) {
        // Like Prompter, take the margin at the peak probability of this run.
        this.peak=logits[best]; this.pending.confidence=confidence;
      }
      this.last = best;
      return emission;
    }
  }
  class Practice {
    constructor(page) { this.page = page; this.reset(); }
    reset() {
      this.index=0; this.confirmed=new Set(); this.states=new Map();
      this.exposed=new Set();
      this.mistakes=new Set(); this.uncertain=new Set(); this.hints=new Set(); this.waitingRetry=false;
    }
    accept() {
      if (this.waitingRetry || this.index >= this.page.words.length) return false;
      this.states.set(this.index,'ok');this.confirmed.add(this.index++); return true;
    }
    mistake() {
      if (this.index >= this.page.words.length || this.waitingRetry) return false;
      this.mistakes.add(this.index); this.exposed.add(this.index);
      this.states.set(this.index,'wrong');this.waitingRetry=true; return true;
    }
    retry() { this.waitingRetry=false; }
    hint() { if (this.index < this.page.words.length) this.hints.add(this.index); }
    track(update) {
      this.index=Math.max(0,Math.min(this.page.words.length,update.cursor));
      for(const verdict of update.changes) {
        const {index,state}=verdict;
        this.states.set(index,state);
        if(state==='ok') { this.confirmed.add(index); this.uncertain.delete(index); }
        else if(state!=='pending') {
          // Reveal review words as assistance, without counting them as correct.
          this.exposed.add(index);
          // Repeating previously successful words does not conceal them again.
          // New review marks still record problems on that repeated attempt.
          if(!verdict.repeated) this.confirmed.delete(index);
          if(state==='wrong' || state==='skipped') { this.mistakes.add(index); this.uncertain.delete(index); }
          else this.uncertain.add(index);
        }
      }
    }
  }
  // Retained for earlier pilot diagnostics. Live Recite uses ReciteTracker's
  // continuous passage graph; this word-by-word matcher is no longer its gate.
  class Matcher {
    constructor(words, index=0) {
      this.words=words.map(w=>Array.from(new Set(w.phones.map(phones))));
      this.index=index; this.buffer=''; this.confidences=[]; this.blocked=false;
    }
    followingPrefix(tail,next) {
      // A later mistake must not invalidate an already observed preceding word.
      return next.some(n=>{
        const size=Math.min(4,tail.length,n.length);
        return size>=2 && phoneDistance(tail.slice(0,size),n.slice(0,size))<=MATCHING.okDistance;
      });
    }
    approximate(options,next,boundary) {
      const candidates=[];
      for(const expected of options) {
        const slack=Math.ceil(expected.length*MATCHING.okDistance);
        for(let end=Math.max(1,expected.length-slack);end<=Math.min(this.buffer.length,expected.length+slack);end++) {
          const tail=this.buffer.slice(end);
          if(!((boundary && !tail) || this.followingPrefix(tail,next))) continue;
          const distance=phoneDistance(this.buffer.slice(0,end),expected);
          if(distance<=MATCHING.okDistance) candidates.push({end,distance});
        }
      }
      candidates.sort((a,b)=>a.distance-b.distance || b.end-a.end);
      // Keep listening if equally good alignments imply different boundaries.
      const best=candidates[0];
      if(!best || candidates.some(c=>c.end!==best.end && Math.abs(c.distance-best.distance)<.025)) return null;
      return this.buffer.slice(0,best.end);
    }
    feed(emissions, boundary=false) {
      if (this.blocked) return [];
      for (const e of emissions) for (const char of e.text.replace(/[\s\u0619]+/gu,'')) {
        if ('اۦۥ'.includes(char) && this.buffer.endsWith(char)) {
          this.confidences[this.confidences.length-1]=Math.max(this.confidences.at(-1),e.confidence);
        } else { this.buffer+=char; this.confidences.push(e.confidence); }
      }
      const events=[];
      while (this.index < this.words.length && this.buffer) {
        const options=this.words[this.index].slice().sort((a,b)=>b.length-a.length);
        const confidence=this.confidences.reduce((a,b)=>a+b,0)/Math.max(1,this.confidences.length);
        // Wait for the following word's prefix or an acoustic pause. A prefix alone
        // is insufficient to distinguish a partial word from its complete variant.
        const next=this.words[this.index+1] || [];
        const candidates=options.filter(p=>this.buffer.startsWith(p) &&
          ((boundary && this.buffer.length===p.length) || next.some(n=>{
            const tail=this.buffer.slice(p.length);
            const size=Math.min(4,tail.length,n.length);
            return size>=1 && tail.slice(0,size)===n.slice(0,size);
          })));
        // At assimilation boundaries a pause variant may consume a consonant
        // that belongs to the following word. Wait until the observed suffix
        // distinguishes the alternatives instead of greedily taking the longest.
        let match=candidates.length===1 && (this.buffer.length>=candidates[0].length+2 || (boundary && this.buffer.length===candidates[0].length)) ? candidates[0] : null;
        if(candidates.length>1) {
          // Two boundaries can represent the same correctly observed word pair
          // (e.g. رَبِحَت تِّجَارَتُهُمْ). Once the complete pair is observed,
          // use the canonical connected partition; never invent missing phones.
          const after=this.words[this.index+2] || [];
          match=this.words[this.index].find(p=>candidates.includes(p) && next.some(n=>{
            const joined=p+n,tail=this.buffer.slice(joined.length);
            return this.buffer.startsWith(joined) && ((boundary && !tail) ||
              after.some(a=>tail.length>=2 && (tail.length<a.length ? a.startsWith(tail) : tail.startsWith(a))));
          })) || null;
        }
        if(!match && candidates.length<2) match=this.approximate(options,next,boundary);
        const wordConfidence=match ? this.confidences.slice(0,match.length).reduce((a,b)=>a+b,0)/match.length : 0;
        if (match && wordConfidence >= MATCHING.minMargin) {
          events.push({type:'correct', index:this.index++});
          this.buffer=this.buffer.slice(match.length);
          this.confidences.splice(0,match.length);
          continue;
        }
        if (match && boundary && wordConfidence < MATCHING.minMargin) {
          this.buffer=''; this.confidences=[];
          events.push({type:'uncertain',index:this.index}); break;
        }
        const partial=options.some(p=>p.startsWith(this.buffer));
        const min=Math.min(...options.map(p=>p.length));
        const max=Math.max(...options.map(p=>p.length));
        // Borderline recognition should invite another reading, not mark a mistake.
        const distance=Math.min(...options.map(p=>phoneDistance(this.buffer,p)));
        if(boundary && !match && !partial && distance<=MATCHING.unsureDistance) {
          this.buffer=''; this.confidences=[];
          events.push({type:'uncertain',index:this.index}); break;
        }
        if (!partial && candidates.length<2 && confidence>=MATCHING.minMargin && ((boundary && this.buffer.length>=Math.max(3,min*.65)) || this.buffer.length>max+8)) {
          events.push({type:'mismatch',index:this.index}); this.blocked=true;
        }
        break;
      }
      if (!this.buffer) this.confidences=[];
      // Uncertain speech never becomes a confirmed mistake; discard at a pause.
      if (boundary && !events.length && !this.blocked && this.confidences.length &&
          this.confidences.reduce((a,b)=>a+b,0)/this.confidences.length < MATCHING.minMargin) {
        this.buffer=''; this.confidences=[];
        events.push({type:'uncertain',index:this.index});
      }
      // A hesitant fragment must not get concatenated with the next retry.
      if(boundary && !this.blocked && this.buffer && this.words[this.index]?.some(p=>p.startsWith(this.buffer))) {
        this.buffer=''; this.confidences=[];
      }
      return events;
    }
  }
  const api={BLANK,MATCHING,phoneCost,phoneDistance,phones,parseTokens,CTC,Practice,Matcher};
  if (typeof module !== 'undefined') module.exports=api;
  root.ReciteCore=api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
