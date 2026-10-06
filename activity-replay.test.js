'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
  class Element{constructor(){this.children=[];this.attrs={};}append(...nodes){this.children.push(...nodes);}appendChild(n){this.append(n);}setAttribute(k,v){this.attrs[k]=v;}remove(){this.removed=true;}}
  const document={head:new Element(),createElement:()=>new Element(),addEventListener(){},removeEventListener(){}};
  const window={I18N:require('./i18n'),__ACTIVITY__:{instanceId:'test'},VideoEncoder:class{},AudioEncoder:class{}};
  const context=vm.createContext({window,document,console,AbortController,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync('activity-replay.js','utf8'),context);
  const o={kind:'circle',x:100,y:100,time:1000};
  const run={activityRun:{id:'test'},audioBuf:{duration:3},objs:[{o}],chart:{},entry:{title:'Song',diffName:'Hard'},radius:32,preempt:1200};
  return {window,api:window.ActivityReplay,run,o,Element};
}
test('capture stays bounded, drops skipped intro and never starts an encoder during gameplay',()=>{
  const f=fixture(),capture=f.api.begin(f.run,'osu');
  for(let t=0;t<1000;t++)capture.sample(t,t,{x:t,y:1},0,{h300:1},1);
  assert.ok(capture.data.frames.length<=64);
  capture.skip(1200);assert.equal(capture.data.frames.length,0);
  capture.sample(1200,1200,{x:100,y:100},1,{h300:1},1);
  capture.mark(f.o,'end','h300',1300);assert.equal(capture.data.events.length,1);
  capture.sample(602000,602000,{},0,{},0);assert.equal(capture.data.disabled,true);assert.equal(capture.data.frames.length,0);
});
test('Share replay is only mounted for captured manual Discord results',()=>{
  const f=fixture(),parent=new f.Element();
  f.api.mount(parent,f.run);assert.equal(parent.children.length,0);
  f.run.replay=f.api.begin(f.run,'osu');
  f.run.replay.sample(0,0,{},0,{},0);f.run.replay.sample(1000,1000,{},0,{h300:1},1);
  f.api.mount(parent,f.run);assert.equal(parent.children[0].children[0].textContent,'Share replay');
  assert.equal(typeof f.run.disposeReplay,'function');f.run.disposeReplay();assert.equal(parent.children[0].removed,true);
  f.window.__ACTIVITY__=null;const web=new f.Element();f.api.mount(web,f.run);assert.equal(web.children.length,0);
});

test('adaptive export checks finalized bytes, retries overshoot, and bounds failure/cancellation',async()=>{
  const {api}=fixture(),data={start:0,end:180000},limit=20*1024*1024,plans=[],updates=[];
  const blob=await api.fitVideo(data,limit,new AbortController().signal,(...v)=>updates.push(v),async(plan,progress)=>{
    plans.push(plan);progress(50);return {size:plans.length===1?limit+1:limit-1};
  });
  assert.equal(blob.size,limit-1);assert.equal(plans.length,2);
  assert.ok(plans[1].bitrate<plans[0].bitrate);assert.deepEqual(updates,[[50,0],[50,1]]);
  assert.equal(api.encodingPlan(data,100*1024*1024).width,1280);
  assert.ok(api.encodingPlan(data,1024*1024).width<1280);
  let attempts=0;
  await assert.rejects(api.fitVideo(data,limit,new AbortController().signal,()=>{},async()=>{attempts++;throw new Error('tooLarge');}),/tooLarge/);
  assert.equal(attempts,4);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(api.fitVideo(data,limit,cancelled.signal,()=>{},async()=>{throw new Error('must not encode');}),/cancelled/);
});

test('sidebar shows gameplay accuracy and maps fractional Mania inputs to configured keys',()=>{
  const {api,run}=fixture();run.notes=[];run.keys=['d','f','j','k'];run.keyCount=4;
  const labels=[],boxes=[];
  const g=new Proxy({}, {get:(o,k)=>k in o?o[k]:(...args)=>{
    if(k==='fillText')labels.push(args);
    if(k==='roundRect')boxes.push({args,color:g.fillStyle});
    if(k==='measureText')return {width:String(args[0]).length*8};
  },set:(o,k,v)=>(o[k]=v,true)});
  const capture=api.begin(run,'vsrg',{snapshot:()=>({canvas:{width:640,height:480}}),draw(){}});
  capture.sample(0,0,null,0,{perfect:1},1);capture.sample(1000,1000,null,0,{perfect:1},1);
  capture.input(100.5,0,true);capture.input(100.6,0,true);capture.input(150.5,0,false);
  const draw=api.renderer({width:1280,height:720,getContext:()=>g},capture.finish());
  draw(100);assert.equal(boxes.at(-4).color,'#193e5a');
  draw(100.5);assert.equal(boxes.at(-4).color,'#009fe8');
  draw(101);assert.ok(labels.some(([s,x,y])=>s==='1'&&y===531));
  assert.ok(labels.some(([s])=>s==='100.00%'));assert.ok(labels.some(([s])=>s==='D'));
  draw(151);assert.equal(boxes.at(-4).color,'#193e5a');
  assert.equal(capture.data.frames[0][4].counts.perfect,1);
});
