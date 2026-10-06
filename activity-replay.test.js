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
