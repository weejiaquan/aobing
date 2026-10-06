'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const R=require('./rhythm-core');
const M=require('./rhythm-mania');
const S=require('./rhythm-standard');
const Std=require('./osustd');
const Mania=require('./vsrg');
const session=notes=>M.createSession({keyCount:4,overallDifficulty:5,notes});
const hold=()=>session([{time:1000,endTime:2000,lane:0}]);

test('audible clock uses output timestamps without subtracting latency twice',()=>{
  const ctx={currentTime:10.2,outputLatency:0.2,getOutputTimestamp:()=>({contextTime:10,performanceTime:5000})};
  const c=R.createClock(ctx,9,()=>5050);
  assert.equal(c.at(),1050); assert.equal(c.at(5020),1020);
  c.pause(); assert.equal(c.at(7000),1050);
  c.reset(10); assert.equal(c.at(5050),50);
});
test('fallback clock follows audio clock rather than a stale song-start anchor',()=>{
  let now=5000; const ctx={currentTime:10,outputLatency:0.1};
  const c=R.createClock(ctx,9,()=>now); assert.ok(Math.abs(c.at()-900)<1e-8);
  now+=10000; ctx.currentTime+=9.98;
  assert.ok(Math.abs(c.at() - 10880)<1e-8);
});
test('input history never borrows a future pointer position or key state',()=>{
  const h=R.createHistory({x:0,y:0,held:false});
  h.push(0,{x:0,held:true}); h.push(100,{x:100,held:false});
  assert.equal(h.at(50).x,0);assert.equal(h.at(50).held,true); assert.equal(h.at(100).held,false);
  h.prune(90); assert.equal(h.at(95).held,true);
});
test('Mania hold receives one combined judgement, not independent head and tail grades',()=>{
  const s=hold();s.press(0,1010);assert.equal(Object.values(s.state.counts).reduce((a,b)=>a+b),0);
  s.release(0,2010);assert.equal(s.state.counts.marvelous,1);assert.equal(s.state.totalNotes,1);
  assert.equal(s.state.combo,1);
});
test('Mania late release and overholding cannot receive a free perfect',()=>{
  for(const late of [150,205]) { const s=hold();s.press(0,1000);s.release(0,2000+late);assert.equal(s.state.counts.miss,1);assert.equal(s.state.counts.marvelous,0); }
});
test('Mania early and late release errors combine with head error',()=>{
  for(const error of [-60,60]) { const s=hold();s.press(0,1030);s.release(0,2000+error);assert.equal(s.state.counts.perfect,1); }
});
test('dropped hold may recover, but its judgement is capped and combo stays broken',()=>{
  const s=hold();s.press(0,1000);s.release(0,1500);s.press(0,1800);s.release(0,2000);
  assert.equal(s.state.counts.bad,1);assert.equal(s.state.combo,0);assert.equal(s.state.counts.miss,0);
});
test('missed hold head can be recovered without producing two accuracy judgements',()=>{
  const s=hold();s.advance(1200);s.press(0,1850);s.release(0,2000);
  assert.equal(s.state.counts.bad,1);assert.equal(Object.values(s.state.counts).reduce((a,b)=>a+b),1);
});
test('Mania repeated notes select the oldest pending head instead of skipping forward',()=>{
  const s=session([{time:1000,lane:0},{time:1100,lane:0}]);s.press(0,1060);
  assert.equal(s.notes[0].headJudged,true);assert.equal(s.notes[1].headJudged,false);
  s.release(0,1070);s.press(0,1100);assert.equal(s.state.combo,2);
});
test('too-early mania keypress outside the miss window does not consume a note',()=>{
  const s=session([{time:1000,lane:0}]);s.press(0,700);s.release(0,701);assert.equal(s.notes[0].headJudged,false);
  s.press(0,1000);assert.equal(s.state.counts.marvelous,1);
});
test('a pending mania tap expires when the next head in its lane becomes due',()=>{
  const s=session([{time:1000,lane:0},{time:1100,lane:0}]);s.press(0,1100);
  assert.equal(s.state.counts.miss,1);assert.equal(s.state.counts.marvelous,1);assert.equal(s.state.combo,1);
});
test('classic tap windows allow an early 50 but never a late 50',()=>{
  const w=M.windows(5);assert.equal(M.tapTier(-125,w),'bad');assert.equal(M.tapTier(125,w),'miss');
  assert.equal(M.tapTier(16.49,w),'marvelous');assert.equal(M.tapTier(16.5,w),'perfect');
});
test('Mania chords and autoplay give identical results at 60Hz, 144Hz, and through a stall',()=>{
  const notes=[{time:1000,lane:0},{time:1000,lane:1,endTime:1700},{time:1200,lane:2},{time:1800,lane:1}];
  const results=[];
  for(const dt of [1000/60,1000/144,2400]) { const s=session(notes);for(let t=0;t<2600;t+=dt)s.auto(t);s.auto(2600);results.push(s.state); }
  assert.deepEqual(results[0],results[1]);assert.deepEqual(results[1],results[2]);assert.equal(results[0].counts.marvelous,4);
});
test('SV scroll positions remain continuous across red and green timing points',()=>{
  const points=R.timingPoints(['0,500,4,1,0,100,1','1000,-50,4,1,0,100,0','2000,250,4,1,0,100,1']);
  const timeline=R.scrollTimeline(points,2200);
  assert.equal(R.scrollAt(timeline,999),999);assert.equal(R.scrollAt(timeline,1000),1000);
  assert.equal(R.scrollAt(timeline,1500),2000);assert.equal(R.scrollAt(timeline,2000),3000);assert.equal(R.scrollAt(timeline,2100),3200);
});
test('map parser preserves sample sets, additions, custom filenames and edge overrides',()=>{
  const text='[General]\nMode:0\nSampleSet:Soft\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\nSliderMultiplier:1\n[TimingPoints]\n0,500,4,1,2,60,1\n[HitObjects]\n0,0,1000,2,8,L|100:0,2,100,2|4|8,1:2|3:1|2:3,0:0:0:0:custom.wav';
  const chart=Std.assembleChart(text),obj=chart.objects[0];
  assert.deepEqual(R.soundSpec(chart,obj,1500,1),{normalSet:3,additionSet:1,index:2,volume:60,filename:'',bits:4});
  assert.equal(R.soundSpec(chart,obj,1000,0).filename,'custom.wav');
});
function slider() {
  const o={kind:'slider',x:0,y:0,time:1000,endTime:2000,duration:1000,spanDuration:1000,slides:1,path:[{x:0,y:0},{x:100,y:0}]};
  return {o,headJudged:true,headResult:'h300',hitWindow:150,checkpoints:S.checkpoints(o,{timingPoints:[{time:0,beatLength:500,uninherited:true}],sliderTickRate:1})};
}
test('slider checkpoint results do not depend on display-frame frequency',()=>{
  const h=R.createHistory({x:0,y:0,held:false});h.push(1000,{x:0,held:true});h.push(1500,{x:50,held:true});h.push(1964,{x:96.4,held:true});h.push(2000,{x:100,held:false});
  const results=[];
  for(const dt of [1000/60,1000/144,1100]) {const s=slider(),events=[];for(let t=1000;t<2200;t+=dt)S.processSlider(s,t,h,32,(...e)=>events.push(e));S.processSlider(s,2200,h,32,(...e)=>events.push(e));results.push({result:S.sliderResult(s),events});}
  assert.deepEqual(results[0],results[1]);assert.deepEqual(results[1],results[2]);assert.equal(results[0].result,'h300');
});
test('missing tick is emitted as a break; tail remains a separate nonbreaking event',()=>{
  const s=slider(),h=R.createHistory({x:0,y:0,held:false}),events=[];
  S.processSlider(s,2100,h,32,(hit,kind)=>events.push({hit,kind}));
  assert.deepEqual(events,[{hit:false,kind:'tick'},{hit:false,kind:'tail'}]);assert.equal(S.sliderResult(s),'h50');
});
test('slider tail is checked 36ms early and short sliders use midpoint protection',()=>{
  assert.equal(slider().checkpoints.at(-1).time,1964);
  const o={...slider().o,duration:40,spanDuration:40,endTime:1040};
  assert.equal(S.checkpoints(o,{timingPoints:[],sliderTickRate:1}).at(-1).time,1020);
});
test('repeat slider returns to its start and emits one repeat per reversal',()=>{
  const o={...slider().o,duration:2000,slides:2,endTime:3000};
  assert.deepEqual(S.ball(o,3000),{x:0,y:0});assert.deepEqual(S.ball(o,2500),{x:50,y:0});
  assert.equal(S.checkpoints(o,{timingPoints:[],sliderTickRate:1}).filter(c=>c.kind==='repeat').length,1);
});
test('spinner requires held input and ignores centre jitter',()=>{
  const s={rot:0,lastAngle:null};
  for(let t=0;t<1000;t+=10)S.spinSample(s,{x:256+90*Math.cos(t/30),y:192+90*Math.sin(t/30),held:false},t);
  assert.equal(s.rot,0);
  for(let t=1000;t<2000;t+=10)S.spinSample(s,{x:256+2*Math.cos(t),y:192+2*Math.sin(t),held:true},t);
  assert.equal(s.rot,0);
  for(let t=2000;t<3000;t+=10)S.spinSample(s,{x:256+90*Math.cos(t/50),y:192+90*Math.sin(t/50),held:true},t);
  assert.ok(s.rot>Math.PI*4);
});
test('stacking offsets repeated circles and negative stacks after slider tails',()=>{
  const c=time=>({kind:'circle',time,x:100,y:100});
  const stacked=S.stack([c(1000),c(1100),c(1200)],1200,0.7,32);
  assert.deepEqual(stacked.map(o=>o.stackHeight),[2,1,0]);assert.equal(stacked[0].x,93.6);
  const o={...slider().o,path:[{x:0,y:0},{x:100,y:100}]};
  const negative=S.stack([o,c(2100)],1200,0.7,32);assert.equal(negative[1].stackHeight,-1);assert.equal(negative[1].x,103.2);
});
test('declared slider length extends a short control path rather than slowing its ball',()=>{
  const path=Std.samplePath('L',[{x:0,y:0},{x:50,y:0}],100,5);assert.deepEqual(path.at(-1),{x:100,y:0});
});
test('mania parser clamps the rightmost column and defaults missing OD',()=>{
  const c=Mania.parseOsu('[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n512,0,1000,1,0,0:0:0:0:');
  assert.equal(c.notes[0].lane,3);assert.equal(c.overallDifficulty,5);
});
test('archive lookup keeps subfolder samples and does not mix sibling map folders',()=>{
  const files=new Map([['A/chart.osu',1],['A/hits/clap.wav',2],['A/normal-hitnormal.wav',3],['B/normal-hitnormal.wav',4]]);
  const map=R.archiveFiles(files,'A/chart.osu');
  assert.equal(map.get('hits/clap.wav'),2);assert.equal(map.get('normal-hitnormal.wav'),3);assert.equal(map.has('B/normal-hitnormal.wav'),false);
});
test('multiplayer chart transfer preserves beatmap samples and accepts legacy payloads',()=>{
  const MP=require('./multiplayer');
  const record={hash:'a',osuText:'map',audio:new Uint8Array([1]),samples:[{name:'clap.wav',bytes:new Uint8Array([2,3])}]};
  const result=MP.decodeChartTransfer(MP.encodeChartTransfer(record));
  assert.equal(result.samples[0].name,'clap.wav');assert.deepEqual(result.samples[0].bytes,record.samples[0].bytes);
  const old=JSON.parse(MP.encodeChartTransfer(record));delete old.samples;assert.deepEqual(MP.decodeChartTransfer(JSON.stringify(old)).samples,[]);
});
