const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const core=require('../../recite-core.js');
const root=require('node:path').resolve(__dirname,'../..');
const env={window:{}};vm.runInNewContext(fs.readFileSync(root+'/data/recite/page-3.js','utf8'),env);
const page=JSON.parse(JSON.stringify(env.window.RECITE_PAGE));
function e(text,confidence=.95){return {text,confidence};}
function matcher(words){return new core.Matcher(words.map(p=>({phones:[p]})));}
test('page 3 covers 127 ordered words and audited cluster corrections',()=>{
 assert.equal(page.words.length,127);assert.equal(page.words[0].ref,'2:6');assert.equal(page.words.at(-1).ref,'2:16');
 assert.equal(page.words[67].ar,'أَلَآ');assert.deepEqual(page.words[67].box,[578,500,49,64]);
 for(const w of page.words){assert.ok(w.phones.length);assert.ok(w.box[0]>=0&&w.box[0]+w.box[2]<=page.width);}
});
test('partial words and silence never advance or flag mistakes',()=>{
 const m=matcher(['abcd','efgh']);assert.deepEqual(m.feed([e('ab')]),[]);assert.deepEqual(m.feed([],true),[]);
 assert.equal(m.index,0);assert.equal(m.blocked,false);
});
test('continuous words wait for next observed prefix, final word for a pause',()=>{
 const m=matcher(['abcd','efgh']);assert.deepEqual(m.feed([e('abcd')]),[]);
 assert.deepEqual(m.feed([e('ef')]),[{type:'correct',index:0}]);
 assert.deepEqual(m.feed([e('gh')],true),[{type:'correct',index:1}]);
});
test('confident wrong or skipped words require a retry; low confidence is uncertainty',()=>{
 const m=matcher(['abcd','efgh']);assert.deepEqual(m.feed([e('efgh')],true),[{type:'mismatch',index:0}]);assert.equal(m.index,0);
 assert.deepEqual(m.feed([e('abcd')],true),[]);
 const low=matcher(['abcd']);assert.deepEqual(low.feed([e('abcd',.2)],true),[{type:'uncertain',index:0}]);assert.equal(low.index,0);
});
test('cue, hint and retry do not count as confirmations; review survives retry',()=>{
 const p=new core.Practice(page);p.hint();assert.equal(p.index,0);p.mistake();assert.equal(p.accept(),false);
 p.retry();assert.equal(p.accept(),true);assert.ok(p.mistakes.has(0));assert.ok(p.hints.has(0));
 p.reset();assert.equal(p.index,0);assert.equal(p.hints.size,0);assert.equal(p.mistakes.size,0);
});
test('CTC emits only finalized tokens and handles repeats across calls and blanks',()=>{
 const table=Array.from({length:251},(_,i)=>String(i)),ctc=new core.CTC(table);
 const logits=(id,p=.95)=>Float32Array.from({length:251},(_,i)=>Math.log(i===id?p:(1-p)/250));
 assert.equal(ctc.frame(logits(2)),null);assert.equal(ctc.frame(logits(2)),null);
 assert.equal(ctc.frame(logits(250)).text,'2');assert.equal(ctc.frame(logits(2)),null);
 assert.equal(ctc.frame(logits(3)).text,'2');assert.equal(ctc.frame(logits(250)).text,'3');
});
test('token IDs must be exhaustive with CTC blank 250, not 0',()=>{
 const txt=Array.from({length:251},(_,i)=>(i===250?'<blk>':'t'+i)+' '+i).join('\n');
 assert.equal(core.parseTokens(txt)[250],'<blk>');assert.throws(()=>core.parseTokens(txt.replace('<blk> 250','<blk> 0')));
 assert.throws(()=>core.parseTokens(txt.split('\n').slice(1).join('\n')));
});
test('all independently generated page words match with acoustic word boundaries',()=>{
 const m=new core.Matcher(page.words);
 for(let i=0;i<page.words.length;i++) assert.deepEqual(m.feed([e(page.words[i].phones[0])],true),[{type:'correct',index:i}]);
 assert.equal(m.index,page.words.length);
});
test('duration choices normalize while consonants and gemination remain distinct',()=>{
 assert.equal(core.phones('ااۦۦۦۥۥ'), 'اۦۥ');assert.equal(core.phones('رَببِ'),'رَببِ');
});

test('a confident next word cannot wash out an uncertain preceding word',()=>{
 const m=matcher(['abcd','efgh']);
 assert.deepEqual(m.feed([e('abcd',.1),e('efgh',.99)],true),[{type:'uncertain',index:0}]);
 assert.equal(m.index,0);
});

test('deployed word separator does not become a mismatched phoneme',()=>{
 assert.equal(core.phones('اؙب'), 'اب');
 const m=matcher(['abcd','efgh']);assert.deepEqual(m.feed([e('abcdؙef')]),[{type:'correct',index:0}]);
 assert.deepEqual(m.feed([e('gh')],true),[{type:'correct',index:1}]);
});

test('assimilation waits for evidence instead of taking a pause consonant',()=>{
 const m=new core.Matcher([{phones:['qulubi','qulubim']},{phones:['mmmmar','mar']},{phones:['next']}]);
 assert.deepEqual(m.feed([e('qulubimmm')]),[]);
 assert.deepEqual(m.feed([e('marne')]),[{type:'correct',index:0},{type:'correct',index:1}]);
});
test('an identical joined pair can confirm both words without choosing an audible boundary',()=>{
 const m=new core.Matcher([{phones:['rbh','rbht']},{phones:['tti','ti']},{phones:['xy']}]);
 assert.deepEqual(m.feed([e('rbhtt')]),[]);
 assert.deepEqual(m.feed([e('ixy')]),[{type:'correct',index:0},{type:'correct',index:1}]);
 assert.deepEqual(m.feed([],true),[{type:'correct',index:2}]);
});
