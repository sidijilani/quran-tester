/* Incremental passage alignment. The recognizer emits observed phones; this
   tracker aligns them to a graph of connected/pausal Quran word variants.
   No word gates the next word, and no recognition state is reset on a mismatch. */
(function(root) {
  'use strict';
  const core=root.ReciteCore || (typeof require!=='undefined' ? require('./recite-core.js') : null);
  const HISTORY=256, LOOK_AHEAD=8, REPEAT_WORDS=8, RECOVERY_REPEAT_COST=2;
  // Backtrace actions: epsilon, substitution, insertion, deletion, repeat start.
  const EPSILON=0, MATCH=1, INSERT=2, DELETE=3, REPEAT=4;
  class PassageTracker {
    constructor(words,index=0) {
      this.words=words.map(w=>({ref:w.ref,variants:Array.from(new Set(w.phones.map(core.phones)))}));
      this.nodes=[{word:0,parents:[],phone:null}];
      this.boundaries=[0];
      for(let word=0;word<this.words.length;word++) {
        const ends=[];
        for(const variant of this.words[word].variants) {
          let parent=this.boundaries[word];
          for(let offset=0;offset<variant.length;offset++) {
            const id=this.nodes.length;
            this.nodes.push({word,parents:[parent],phone:variant[offset],first:offset===0});
            parent=id;
          }
          ends.push(parent);
        }
        this.boundaries.push(this.nodes.length);
        this.nodes.push({word:word+1,parents:ends,phone:null});
      }
      this.restart(index);
    }
    shiftWindow(words,delta) {
      // Carry the dynamic-programming state across the overlapping reference.
      // Node IDs change; observations and their original confidence do not.
      const next=new PassageTracker(words,Math.max(0,this.cursor-delta));
      const mapping=new Int32Array(this.nodes.length).fill(-1);
      for(let old=0;old<=this.words.length;old++) {
        const local=old-delta;if(local<0 || local>next.words.length)continue;
        mapping[this.boundaries[old]]=next.boundaries[local];
        if(old===this.words.length || local===next.words.length)continue;
        const size=this.boundaries[old+1]-this.boundaries[old];
        if(size!==next.boundaries[local+1]-next.boundaries[local] ||
           this.words[old].variants.join('\0')!==next.words[local].variants.join('\0'))throw Error('Overlapping reference changed during recitation.');
        for(let offset=1;offset<size;offset++)mapping[this.boundaries[old]+offset]=next.boundaries[local]+offset;
      }
      if(mapping[this.best]<0)throw Error('Recognition moved outside the reference overlap.');
      next.column.fill(Infinity);
      for(let id=0;id<mapping.length;id++)if(mapping[id]>=0)next.column[mapping[id]]=this.column[id];
      next.rows=this.rows.map(row=>{
        if(!row)return row;
        const copy={serial:row.serial,parent:new Int32Array(next.nodes.length).fill(-1),action:new Uint8Array(next.nodes.length)};
        for(let id=0;id<mapping.length;id++)if(mapping[id]>=0) {
          copy.parent[mapping[id]]=row.parent[id]>=0?mapping[row.parent[id]]:-1;
          copy.action[mapping[id]]=row.action[id];
        }
        return copy;
      });
      next.heard=this.heard;next.count=this.count;next.best=mapping[this.best];
      next.anchor=Math.max(0,this.anchor-delta);next.cursor=this.cursor-delta;
      next.publishedCursor=this.publishedCursor-delta;next.replayUntilWord=Math.max(0,this.replayUntilWord-delta);
      next.states=new Map([...this.states].filter(([i])=>i>=delta && i-delta<words.length).map(([i,v])=>[i-delta,v]));
      for(const key of ['lastDurationPhone','rewindUntil','lastRewindSerial'])next[key]=this[key];
      next.completed=false;return next;
    }
    restart(index) {
      this.anchor=Math.max(0,Math.min(this.words.length-1,index));
      this.cursor=this.anchor; this.count=0; this.best=this.boundaries[this.anchor];
      this.column=new Float64Array(this.nodes.length).fill(Infinity);
      this.column[this.best]=0;
      this.rows=Array(HISTORY); this.heard=Array(HISTORY); this.states=new Map();
      this.completed=false; this.lastDurationPhone='';
      this.publishedCursor=this.anchor;this.rewindUntil=0;
      this.lastRewindSerial=0;this.replayUntilWord=0;
      const row=this.makeRow(0);
      // The empty observation may delete reference phones, but never reveal them.
      for(let id=this.best+1;id<this.nodes.length;id++) {
        const node=this.nodes[id];
        if(node.word>this.anchor+LOOK_AHEAD) break;
        let parent=node.parents[0];
        for(const p of node.parents) if(this.column[p]<this.column[parent]) parent=p;
        this.column[id]=this.column[parent]+(node.phone===null ? 0 : 1);
        row.parent[id]=parent; row.action[id]=node.phone===null ? EPSILON : DELETE;
      }
    }
    makeRow(serial) {
      const slot=serial%HISTORY;
      let row=this.rows[slot];
      if(!row) row={parent:new Int32Array(this.nodes.length),action:new Uint8Array(this.nodes.length)};
      row.serial=serial; this.rows[slot]=row;
      return row;
    }
    consume(ch,confidence,frame) {
      const previous=this.column, next=new Float64Array(this.nodes.length).fill(Infinity);
      const previousCursor=this.nodes[this.best].word;
      // A correction can start before a manual retry's anchor, or in the previous
      // ayah. Keep both nearby earlier positions and forward positions available.
      const repeatFloor=Math.max(0,previousCursor-REPEAT_WORDS);
      const lastWord=Math.min(this.words.length,previousCursor+LOOK_AHEAD);
      const firstWord=repeatFloor;
      let hasRecentIssue=false;
      for(let word=repeatFloor;word<=Math.min(previousCursor,this.words.length-1);word++) {
        const state=this.states.get(word);
        if(state && state!=='ok') { hasRecentIssue=true;break; }
      }
      const repeatCost=hasRecentIssue || this.count<this.rewindUntil ? RECOVERY_REPEAT_COST : core.MATCHING.repeatCost;
      const row=this.makeRow(++this.count);
      this.heard[this.count%HISTORY]={serial:this.count,ch,confidence,frame};
      const bestCost=previous[this.best];
      for(let id=this.boundaries[firstWord];id<this.nodes.length;id++) {
        const node=this.nodes[id]; if(node.word>lastWord) break;
        let cost=previous[id]+1, parent=id, action=INSERT;
        if(node.phone===null) {
          for(const p of node.parents) if(next[p]<cost) { cost=next[p];parent=p;action=EPSILON; }
        } else {
          const p=node.parents[0], substitution=core.phoneCost(ch,node.phone);
          if(previous[p]+substitution<=cost) { cost=previous[p]+substitution;parent=p;action=MATCH; }
          if(next[p]+1<cost) { cost=next[p]+1;parent=p;action=DELETE; }
          // Let a repeated word start another local run. Large jumps elsewhere
          // on the page are deliberately excluded from this fixed-page exercise.
          if(node.first && node.word>=repeatFloor && node.word<=previousCursor &&
             bestCost+repeatCost+substitution<cost) {
            cost=bestCost+repeatCost+substitution; action=REPEAT; parent=-1;
          }
        }
        next[id]=cost; row.parent[id]=parent;row.action[id]=action;
      }
      let best=-1, minimum=Infinity;
      for(let id=this.boundaries[firstWord];id<this.nodes.length && this.nodes[id].word<=lastWord;id++) {
        // Prefer a completed boundary to its final character at equal cost.
        if(next[id]<minimum || (next[id]===minimum && this.nodes[id].phone===null)) { minimum=next[id];best=id; }
      }
      if(best<0 || !Number.isFinite(minimum)) return;
      // Fresh unmatched speech can precede a self-correction before a verdict
      // settles. Briefly allow recovery even if the UI has not marked it yet.
      if(minimum>=.75) this.rewindUntil=this.count+64;
      for(let id=this.boundaries[firstWord];id<this.nodes.length && this.nodes[id].word<=lastWord;id++) next[id]-=minimum;
      this.column=next;this.best=best;this.cursor=this.nodes[best].word;
    }
    trace() {
      let serial=this.count, id=this.best;
      const steps=[];
      // Reference deletions and epsilon edges move left within the same row;
      // match/insert edges move to the previous audio character's row.
      while(id>=0 && serial>=0) {
        if(serial===0 && id===this.boundaries[this.anchor]) break;
        const row=this.rows[serial%HISTORY];
        if(!row || row.serial!==serial) break;
        const node=this.nodes[id], action=row.action[id], parent=row.parent[id];
        if(action===EPSILON) { if(parent===id) break;id=parent;continue; }
        const word=Math.min(node.word,this.words.length-1);
        if(action===DELETE) {
          steps.push({word,expected:node.phone,first:node.first});id=parent;continue;
        }
        const heard=this.heard[serial%HISTORY];
        if(!heard || heard.serial!==serial) break;
        steps.push({word,expected:action===INSERT ? '' : node.phone,first:node.first && action!==INSERT,
          ch:heard.ch,confidence:heard.confidence,serial,frame:heard.frame,restart:action===REPEAT});
        if(action===REPEAT) break;
        serial--;id=parent;
      }
      return steps.reverse();
    }
    settleBoundary(word) {
      // Once a complete word is confirmed at a pause, start subsequent alignment
      // at its boundary. A tolerated missing final phone must not hold the cursor.
      const end=this.boundaries[word+1], cost=this.column[end];
      if(!Number.isFinite(cost)) return;
      this.column.fill(Infinity);this.column[end]=cost;
      this.best=end;this.cursor=word+1;
      const row=this.rows[this.count%HISTORY];
      for(let id=end+1;id<this.nodes.length;id++) {
        const node=this.nodes[id]; if(node.word>this.cursor+LOOK_AHEAD) break;
        let parent=node.parents[0];
        for(const p of node.parents) if(this.column[p]<this.column[parent]) parent=p;
        this.column[id]=this.column[parent]+(node.phone===null ? 0 : 1);
        row.parent[id]=parent;row.action[id]=node.phone===null ? EPSILON : DELETE;
      }
    }
    feed(emissions,boundary=false) {
      for(const emission of emissions) {
        for(const ch of emission.text.replace(/[\s\u0619]+/gu,'')) {
          // Match the fixture's duration normalization across token boundaries.
          if('اۦۥ'.includes(ch) && ch===this.lastDurationPhone) {
            const last=this.heard[this.count%HISTORY];
            if(last?.serial===this.count) last.confidence=Math.max(last.confidence,emission.confidence);
            continue;
          }
          this.consume(ch,emission.confidence,emission.frame);
          this.lastDurationPhone='اۦۥ'.includes(ch) ? ch : '';
        }
      }
      if(boundary) { this.lastDurationPhone='';this.rewindUntil=this.count+64; }
      const spans=new Map();
      const steps=this.trace();
      for(const step of steps) {
        let span=spans.get(step.word);
        if(!span) { span={expected:'',heard:'',margin:0,last:0,completeStart:false};spans.set(step.word,span); }
        span.expected+=step.expected || '';span.completeStart ||= !!step.first;
        if(step.ch) { span.heard+=step.ch;span.margin+=step.confidence;span.last=step.serial; }
      }
      const repeat=steps.find(step=>step.restart);
      let rewound=null;
      if(repeat && repeat.serial>this.lastRewindSerial) {
        const first=spans.get(repeat.word), following=spans.get(repeat.word+1);
        const distance=Math.min(...this.words[repeat.word].variants.map(p=>core.phoneDistance(first.heard,p)));
        const margin=first.margin/Math.max(1,first.heard.length);
        const heardCount=this.count-repeat.serial+1;
        // One common sound is insufficient to move the visible outline backward.
        // Wait for a word plus following context, or a complete word at a pause.
        const supported=heardCount>=core.MATCHING.commitDwell && margin>=core.MATCHING.minMargin &&
          distance<=core.MATCHING.unsureDistance && ((this.cursor>repeat.word && following?.heard.length>=2) || boundary);
        if(!supported && this.cursor<this.publishedCursor && heardCount<48 && !boundary) {
          return {cursor:this.publishedCursor,changes:[],finished:false,rewound:null};
        }
        this.replayUntilWord=Math.max(this.replayUntilWord,this.publishedCursor);
        if(supported) {
          rewound={from:this.publishedCursor,to:repeat.word};
          // A fresh repeat must produce a verdict even when it repeats the same
          // mistake. Otherwise retry budgets cannot distinguish new attempts.
          for(const index of this.states.keys())if(index>=repeat.word)this.states.delete(index);
        }
        this.lastRewindSerial=repeat.serial;this.completed=false;
      }
      const changes=[];
      for(const [index,span] of spans) {
        // A ring-buffer cutoff may land inside a word. Never regrade that fragment.
        if(!span.completeStart) continue;
        const atCursor=index>=this.cursor;
        const pending=(atCursor && !boundary) || (!boundary && span.last>this.count-core.MATCHING.commitDwell);
        let expected=span.expected;
        if(atCursor && boundary && this.nodes[this.best].phone!==null) {
          // Grade against a complete variant, never the matched prefix itself.
          expected=this.words[index].variants.reduce((best,p)=>
            core.phoneDistance(span.heard,p)<core.phoneDistance(span.heard,best) ? p : best);
          if(span.heard.length<expected.length*.65 && core.phoneDistance(span.heard,expected)>core.MATCHING.okDistance) continue;
        }
        let distance=core.phoneDistance(span.heard,expected);
        if(boundary) distance=Math.min(distance,...this.words[index].variants.map(p=>core.phoneDistance(span.heard,p)));
        const coverage=span.heard.length/Math.max(1,expected.length);
        const margin=span.margin/Math.max(1,span.heard.length);
        const state=pending ? 'pending' : !span.heard.length ? 'skipped' : margin<core.MATCHING.minMargin ? 'unsure' :
          coverage<core.MATCHING.minHeardFraction ? 'skipped' :
          distance<=core.MATCHING.okDistance && margin>=core.MATCHING.minMargin ? 'ok' :
          distance<=core.MATCHING.unsureDistance ? 'unsure' : 'wrong';
        if(state==='pending') continue; // Settled verdicts remain visible while a repeat is being heard.
        if(this.states.get(index)!==state) {
          this.states.set(index,state);
          changes.push({index,state,distance,margin,heard:span.heard,expected,repeated:index<this.replayUntilWord});
        }
        if(state==='ok' && atCursor && boundary) this.settleBoundary(index);
      }
      const reachedEnd=this.cursor===this.words.length;
      const finalState=this.states.get(this.words.length-1);
      const finished=!this.completed && reachedEnd && !!finalState;
      if(finished) this.completed=true;
      this.publishedCursor=this.cursor;
      return {cursor:this.cursor,changes,finished,rewound};
    }
  }
  root.ReciteTracker=PassageTracker;
  if(typeof module!=='undefined') module.exports=PassageTracker;
})(typeof globalThis!=='undefined' ? globalThis : this);
