'use strict';
// Exercise the actual browser adapters with controlled DOM/audio clocks. This
// checks wiring and state transitions; it is not a substitute for visual QA.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(mode, width=1280, height=720, dpr=1) {
  const drawCalls=[];
  const paint=new Proxy({}, {get:(o,k)=>k in o?o[k]:(...args)=>{drawCalls.push([k,...args]);return k==='createLinearGradient'?{addColorStop(){}}:k==='measureText'?{width:String(args[0]).length*8}:undefined;},set:(o,k,v)=>(o[k]=v,true)});
  class Element {
    constructor(){this.style={};this.dataset={};this.hidden=true;this.children=[];this.classList={add(){},remove(){},toggle(){},contains(){return false;}};this.listeners={};this.value='';this.width=width;this.height=height;}
    addEventListener(k,f){(this.listeners[k]??=[]).push(f);} removeEventListener(){}
    getBoundingClientRect(){return {width:this.style.width?parseFloat(this.style.width):width,height,left:0,top:0};}
    getContext(){return paint;} setAttribute(){} getAttribute(){return '';}
    append(...nodes){this.children.push(...nodes);}appendChild(n){this.append(n);return n;}
    querySelector(){return new Element();}querySelectorAll(){return [];}focus(){}setPointerCapture(){}
  }
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const document={getElementById:get,querySelector:get,querySelectorAll:()=>[],createElement:()=>new Element(),addEventListener(){},body:new Element(),head:new Element()};
  let audio;
  class AudioContext {
    constructor(){audio=this;this.currentTime=10;this.outputLatency=0;this.state='running';this.destination={};}
    resume(){return Promise.resolve();}
    decodeAudioData(){return Promise.resolve({duration:60});}
    createBufferSource(){return {connect(){return this;},start(){},stop(){}};}
    createGain(){return {gain:{value:1},connect(){return this;}};}
  }
  const window=new Element();Object.assign(window,{document,devicePixelRatio:dpr,AudioContext,
    RhythmCore:require('./rhythm-core'),RhythmMania:require('./rhythm-mania'),RhythmStandard:require('./rhythm-standard'),
    RhythmUI:{controls(){},pausePanel(){return {show(){},hide(){},cancelCountdown(){}};}},
    Hitsound:{play(){},playNote(){},playTick(){},tick(){},async prepare(){return new Map();}},I18N:require('./i18n')});
  window.window=window;
  const context=vm.createContext({window,document,console,performance:{now:()=>5000},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout:()=>1,clearTimeout(){},
    MutationObserver:class {observe(){}},IntersectionObserver:class {observe(){} disconnect(){}},navigator:{},URL,TextDecoder,TextEncoder,Blob});
  vm.runInContext(fs.readFileSync('rhythm-core.js','utf8'),context);
  const file=mode==='osu'?'osustd.js':'vsrg.js';
  const hooks=`window.__runtime={ensureCtx,startRun,loop,render,pauseRun,resumeRun,teardownRun,finishRun,onKeyDown,${mode==='osu'?'onMouseDown,onMouseUp,updateSliders,rememberInput,':'onKeyUp,'} setPanelOpen(v){panelOpen=v;},get run(){return run;}, setAuto(v){autoplay=v;},setCursor(v){${mode==='osu'?'cursor=v;':''}}};`;
  const source=fs.readFileSync(file,'utf8').replace('    function calOffset()',hooks+'\n    function calOffset()').replace("const rec = await api.getChartRecord(hash);","const rec = window.__mpRecord;");
  vm.runInContext(source,context,{filename:file});
  const settings={musicVol:0,osuKeys:['z','x']};
  window[mode==='osu'?'OsuStdGame':'VsrgGame'].init({settings,saveSettings(){}});
  const runtime=window.__runtime;
  return {window,context,runtime,settings,drawCalls,get,async start(chart,auto=false){await runtime.ensureCtx();runtime.setAuto(auto);runtime.startRun({title:'Test',diffName:'Test'},chart,{duration:60});},time(t){audio.currentTime=runtime.run.startCtx+t/1000;},event(key,extra={}){return {key,timeStamp:5000,preventDefault(){},...extra};}};
}
const stdChart=()=>require('./osustd').assembleChart('[General]\nMode:0\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\nSliderMultiplier:1\n[TimingPoints]\n0,500,4,1,0,100,1\n[HitObjects]\n100,100,1000,2,0,L|200:100,2,100\n300,200,2500,1,0\n256,192,3500,8,0,4500');
const maniaChart=()=>require('./vsrg').parseOsu('[General]\nMode:3\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\n[TimingPoints]\n0,500,4,1,0,100,1\n1500,-50,4,1,0,100,0\n[HitObjects]\n64,0,1000,128,0,2000:0:0:0:0:\n192,0,2500,1,0');
for(const mode of ['osu','vsrg']) {
  test(mode+': replay captures fractional input timing and freezes render state without re-judging',async()=>{
    const f=fixture(mode);vm.runInContext(fs.readFileSync('activity-replay.js','utf8'),f.context);
    f.window.__ACTIVITY__={instanceId:'discord'};f.window.ActivityGames={newRun:()=>({id:'run'})};
    await f.start(mode==='osu'?stdChart():maniaChart());f.time(1000.25);
    const key=mode==='osu'?'z':f.runtime.run.keys[0];
    f.runtime.onKeyDown(f.event(key,{timeStamp:4999.25}));
    const capture=f.runtime.run.replay;
    assert.ok(Math.abs(capture.data.inputs[0][0]-999.5)<1e-6);
    assert.equal(capture.data.inputs[0][2],true);
    f.runtime.loop();const view=capture.data.frames[0][2];
    const before=JSON.stringify(mode==='osu'?f.runtime.run.counts:f.runtime.run.state);
    f.window.ActivityReplay.renderer(f.get('replay-preview'),capture.data)(1000.25);
    assert.equal(JSON.stringify(mode==='osu'?f.runtime.run.counts:f.runtime.run.state),before);
    if(mode==='osu'){
      const old=view.run.objs[0].headJudged;f.runtime.run.objs[0].headJudged=!old;
      assert.equal(view.run.objs[0].headJudged,old);assert.equal(view.run.objs[0].number,1);
    }else{
      const old=view.run.notes[0].holding;f.runtime.run.notes[0].holding=!old;
      assert.equal(view.run.notes[0].holding,old);
    }
  });
  test(mode+': actual adapter records manual judgement events and frames only for Discord',async()=>{
    const f=fixture(mode);vm.runInContext(fs.readFileSync('activity-replay.js','utf8'),f.context);
    f.window.ActivityGames={newRun:()=>({id:'recorded-run'})};
    await f.start(mode==='osu'?stdChart():maniaChart());assert.equal(f.runtime.run.replay,null);
    f.window.__ACTIVITY__={instanceId:'discord'};
    await f.start(mode==='osu'?stdChart():maniaChart(),true);assert.equal(f.runtime.run.replay,null);
    await f.start(mode==='osu'?stdChart():maniaChart());
    for(const t of [0,500,1000,1500,2200,2600,3000]){f.time(t);f.runtime.loop();}
    const data=f.runtime.run.replay.finish(null);
    assert.ok(data.frames.length>3);assert.ok(data.events.length>0);
    assert.ok(data.events.some(e=>e[3]==='miss'));
    assert.equal(data.owner.id,'recorded-run');
    const drawn=f.window.ActivityReplay.renderer(f.get('replay-preview'),data);drawn(500);drawn(2500);
    assert.ok(f.drawCalls.every(c=>c.slice(1).filter(x=>typeof x==='number').every(Number.isFinite)));
  });
}
for (const mode of ['osu','vsrg']) {
  test(mode+': Discord reporting fires once for a manual finish, never autoplay or teardown',async()=>{
    const f=fixture(mode),reports=[];
    f.window.ActivityGames={newRun:()=>({id:'run',uid:'player'}),complete:async(run,result)=>{reports.push({run,result});}};
    await f.start(mode==='osu'?stdChart():maniaChart());
    // Local PB storage is absent in this VM; reporting must happen before it.
    await f.runtime.finishRun().catch(()=>{});
    await f.runtime.finishRun().catch(()=>{});
    assert.equal(reports.length,1);assert.equal(reports[0].result.mode,mode);
    await f.start(mode==='osu'?stdChart():maniaChart(),true);
    await f.runtime.finishRun();assert.equal(reports.length,1);
    await f.start(mode==='osu'?stdChart():maniaChart());f.runtime.teardownRun();
    assert.equal(reports.length,1);
  });
}
for(const mode of ['osu','vsrg']) {
  test(mode+': full run setup, audio mute, pause and resume preserve song position',async()=>{
    const f=fixture(mode);await f.start(mode==='osu'?stdChart():maniaChart());
    assert.equal(f.runtime.run.gain.gain.value,0);
    f.time(1300);f.runtime.pauseRun();assert.equal(f.runtime.run.paused,true);assert.ok(Math.abs(f.runtime.run.pauseRaw-1300)<1e-6);
    f.time(30000);assert.ok(Math.abs(f.runtime.run.clock.at()-1300)<1e-6);
    await f.runtime.resumeRun();assert.equal(f.runtime.run.paused,false);
    assert.ok(Math.abs(f.runtime.run.clock.at()-1250)<1e-6);
    f.runtime.teardownRun();assert.equal(f.runtime.run,null);
  });
  for(const [w,h,d] of [[1280,720,1],[390,844,3],[844,390,2]]) {
    test(`${mode}: render paths execute at ${w}x${h}, DPR ${d}`,async()=>{
      const f=fixture(mode,w,h,d);await f.start(mode==='osu'?stdChart():maniaChart(),true);
      for(const time of [0,1000,1250,1600,2100,2500,3500,4400,4600]) {f.time(time);f.runtime.loop();}
      assert.ok(f.drawCalls.length>0);
      assert.ok(f.drawCalls.every(c=>c.slice(1).filter(x=>typeof x==='number').every(Number.isFinite)),'drawing must have finite coordinates');
      assert.equal(mode==='osu'?f.runtime.run.counts.miss:f.runtime.run.state.counts.miss,0);
    });
  }
}
test('Standard releasing M1 leaves a held M2 active',async()=>{
  const f=fixture('osu');await f.start(stdChart());f.time(0);
  const e=button=>f.event('',{button,clientX:100,clientY:100});
  f.runtime.onMouseDown(e(0));f.runtime.onMouseDown(e(2));f.runtime.onMouseUp(e(0));
  assert.equal(f.runtime.run.pressed.m1,false);assert.equal(f.runtime.run.pressed.m2,true);
});
test('Mania real keyboard handlers judge a combined hold and ignore repeated keydowns',async()=>{
  const f=fixture('vsrg');await f.start(maniaChart());f.time(1000);
  f.runtime.onKeyDown(f.event('d'));f.runtime.onKeyDown(f.event('d'));
  f.time(2000);f.runtime.onKeyUp(f.event('d'));
  assert.equal(f.runtime.run.state.counts.marvelous,1);assert.equal(f.runtime.run.state.combo,1);
});
test('Standard results do not claim full combo after a slider break without a miss',async()=>{
  const f=fixture('osu');await f.start(stdChart(),true);
  f.runtime.run.counts.h100=1;f.runtime.run.counts.h300=2;f.runtime.run.maxCombo=2;
  await f.runtime.finishRun();assert.equal(f.get('osu-results-body').innerHTML.includes('Full Combo!'),false);
});
test('input calibration and visual offset are independent in the live draw path',async()=>{
  const f=fixture('vsrg');await f.start(maniaChart());f.time(0);
  f.runtime.loop();const baseline=f.drawCalls.filter(c=>c[0]==='roundRect').map(c=>c.slice(1));f.drawCalls.length=0;
  f.settings.vsrgCalibrationOffset=80;f.runtime.loop();const calibrated=f.drawCalls.filter(c=>c[0]==='roundRect').map(c=>c.slice(1));
  assert.deepEqual(calibrated,baseline);f.drawCalls.length=0;
  f.settings.vsrgVisualOffset=100;f.runtime.loop();const shifted=f.drawCalls.filter(c=>c[0]==='roundRect').map(c=>c.slice(1));
  assert.notDeepEqual(shifted,baseline);
});

test('Standard multiplayer uses scheduled audio time, disables autoplay/skip, and forfeits once on pause',async()=>{
  const f=fixture('osu');await f.runtime.ensureCtx();f.runtime.setAuto(true);
  const reports=[];
  f.runtime.startRun({title:'Race',diffName:'Test'},stdChart(),{duration:60},{startAt:9000,onScore:s=>reports.push(s)});
  assert.equal(f.runtime.run.startCtx,14);assert.equal(f.runtime.run.auto,false);
  f.time(500);f.runtime.loop();assert.equal(f.get('osu-skip').hidden,true);
  f.runtime.pauseRun();f.runtime.pauseRun();
  assert.equal(reports.filter(r=>r.state==='forfeit').length,1);
  assert.equal(f.runtime.run.multiplayer,null);f.runtime.teardownRun();
});

test('leaving a live Standard round reports a forfeit with the actual score',async()=>{
  const f=fixture('osu');await f.runtime.ensureCtx();const reports=[];
  f.runtime.startRun({title:'Race'},stdChart(),{duration:60},{startAt:9000,onScore:s=>reports.push(s)});
  f.runtime.run.counts.h300=2;f.runtime.run.counts.h100=1;f.runtime.run.maxCombo=3;
  f.runtime.teardownRun();assert.equal(reports.length,1);assert.equal(reports[0].state,'forfeit');assert.equal(reports[0].score,700);assert.equal(reports[0].combo,3);
});


test('Standard actual multiplayer API can prepare a new round after a paused forfeit',async()=>{
  const f=fixture('osu');f.runtime.setPanelOpen(true);
  f.window.__mpRecord={osuText:'[General]\nMode:0\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\n[TimingPoints]\n0,500,4,1,0,100,1\n[HitObjects]\n256,192,1000,1,0',audio:new Uint8Array([1,2,3]),samples:[]};
  const api=f.window.OsuStdGame,reports=[];
  const prepared=await api.prepareMultiplayer('hash');
  api.startMultiplayer(prepared,{startAt:9000,onScore:s=>reports.push(s)});
  f.runtime.pauseRun();assert.equal(reports[0].state,'forfeit');
  const next=await api.prepareMultiplayer('hash');assert.equal(f.runtime.run,null);
  api.startMultiplayer(next,{startAt:10000,onScore:s=>reports.push(s)});
  assert.equal(f.runtime.run.startCtx,15);assert.equal(f.runtime.run.paused,false);
  assert.equal(reports.length,1);f.runtime.teardownRun();
});
