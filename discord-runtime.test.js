'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const flush=()=>new Promise(r=>setImmediate(r));
function presenceFixture(){
  const elements=new Map();
  class Element {constructor(){this.style={};this.children=[];}appendChild(n){this.children.push(n);if(n.id)elements.set(n.id,n);}}
  const document={createElement:()=>new Element(),getElementById:id=>elements.get(id),head:new Element(),body:new Element()};
  const refs=new Map(),intervals=new Map();let timer=0;
  function ref(path){if(!refs.has(path)) refs.set(path,{value:false,listeners:new Set(),writes:[],registrations:[],offCount:0,
    update(p){this.writes.push(p);return Promise.resolve();},onDisconnect(){return {update:p=>{let resolve;const result=new Promise(r=>resolve=r);this.registrations.push({payload:p,resolve});return result;},cancel:()=>Promise.resolve()};},
    on(_,fn){this.listeners.add(fn);},off(_,fn){this.listeners.delete(fn);this.offCount++;},once(){return Promise.resolve({val:()=>this.value});},emit(v){this.value=v;this.listeners.forEach(fn=>fn({val:()=>v}));}});return refs.get(path);}
  const window={events:[],dispatchEvent(e){this.events.push(e.type);}};
  vm.runInNewContext(fs.readFileSync('presence.js','utf8'),{window,document,console,Event,CustomEvent,setInterval:f=>{intervals.set(++timer,f);return timer;},clearInterval:id=>intervals.delete(id)});
  const deps={db:{ref},activity:{uid:'u',instanceId:'i',discordId:'123',discordName:'Alice'},getSelfState:()=>({name:'Alice',totalClicks:10,sessionClicks:2})};
  window.Presence.init(deps);
  return {window,deps,refs,intervals,elements,connection:ref('.info/connected'),self:ref('activities/i/participants/u')};
}

test('presence registers disconnect before publishing and re-registers after reconnect with unchanged counters',async()=>{
  const f=presenceFixture();assert.deepEqual(f.window.events,['presenceavailable','activityrosterchange']);
  assert.equal(f.self.writes.length,0);f.connection.emit(true);assert.equal(f.self.registrations.length,1);assert.equal(f.self.writes.length,0);
  f.self.registrations[0].resolve();await flush();assert.equal(f.self.writes[0].active,true);
  f.connection.emit(false);f.connection.emit(true);f.self.registrations[1].resolve();await flush();
  assert.equal(f.self.writes.length,2);assert.equal(f.self.writes[1].active,true);
  f.window.Presence.destroy();assert.equal(f.intervals.size,0);assert.equal(f.connection.listeners.size,0);assert.equal(f.self.writes.at(-1).active,false);
});

test('late disconnect-registration acknowledgment cannot republish after disconnect or teardown',async()=>{
  const f=presenceFixture();f.connection.emit(true);f.connection.emit(false);f.self.registrations[0].resolve();await flush();assert.equal(f.self.writes.length,0);
  f.connection.emit(true);f.window.Presence.destroy();const count=f.self.writes.length;f.self.registrations[1].resolve();await flush();assert.equal(f.self.writes.length,count);
});

function appCheckFixture(){
  const source=fs.readFileSync('app.js','utf8');const start=source.indexOf('        let acToken = A.appCheckToken');const end=source.indexOf('        firebase.appCheck().activate(provider, true);',start);
  const fetches=[];const pending=[];
  const context=vm.createContext({A:{},Date,AbortController,setTimeout,clearTimeout,
    firebase:{appCheck:{CustomProvider:class {constructor(opts){this.getToken=opts.getToken;}}},auth:()=>({currentUser:{getIdToken:async()=> 'id-token'}})},
    fetch:()=>{fetches.push(1);return new Promise(resolve=>pending.push(resolve));}});
  vm.runInContext(source.slice(start,end)+'\nglobalThis.getToken=provider.getToken;',context);
  return {get:context.getToken,fetches,pending};
}

test('Activity App Check refresh is single-flight; HTTP failure does not poison the cache',async()=>{
  const f=appCheckFixture();const a=f.get(),b=f.get();const results=Promise.allSettled([a,b]);await flush();assert.equal(f.fetches.length,1);
  f.pending.shift()({ok:false,status:503});assert.ok((await results).every(r=>r.status==='rejected'));
  const c=f.get();await flush();assert.equal(f.fetches.length,2);f.pending.shift()({ok:true,json:async()=>({appCheckToken:'fresh',appCheckTtlMillis:3600000})});
  assert.equal((await c).token,'fresh');assert.equal((await f.get()).token,'fresh');assert.equal(f.fetches.length,2);
});

test('invalid Activity refresh responses are rejected and remain retryable',async()=>{
  const f=appCheckFixture();const p=f.get();const rejected=assert.rejects(p,/Invalid App Check/);await flush();f.pending.shift()({ok:true,json:async()=>({})});await rejected;
  const next=f.get();await flush();assert.equal(f.fetches.length,2);f.pending.shift()({ok:true,json:async()=>({appCheckToken:'ok',appCheckTtlMillis:3600000})});assert.equal((await next).token,'ok');
});
