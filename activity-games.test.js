'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const settle = async () => { for(let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve)); };

function fixture({store=new Map(), activity=true}={}) {
  const calls=[],timers=new Map(),events={};let timer=0,fail=false;
  let user={uid:'player',getIdToken:async()=> 'id-token'};
  let response={mode:'osu',session:'server-signed',expiresAt:Date.now()/1000+3600,revision:'launch-1',requestedBy:'111'};
  const window={__ACTIVITY__:activity?{uid:'player',discordId:'111',instanceId:'instance'}:null,
    addEventListener(k,fn){events[k]=fn;},GameShell:{enterActivity(){return false;}}};
  const context=vm.createContext({window,console,crypto:webcrypto,TextEncoder,AbortController,
    firebase:{auth:()=>({currentUser:user})},localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},
    setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});if(ms===400)setImmediate(fn);return id;},clearTimeout(id){timers.delete(id);},
    fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});
      if(fail) throw new Error('offline');
      return {ok:true,json:async()=>url.endsWith('/context')?response:{status:'pending'}};}});
  vm.runInContext(fs.readFileSync('activity-games.js','utf8'),context);
  return {api:window.ActivityGames,window,calls,timers,store,events,
    offline(v){fail=v;},identity(v){user=v;},context(v){response={...response,...v};},
    async tick(){const item=[...timers.values()].find(t=>t.ms===15000);assert.ok(item);await item.fn();await settle();}};
}
const result=()=>({mode:'osu',chartHash:'a'.repeat(64),title:'Song',difficulty:'Hard',counts:{h300:1,h100:0,h50:0,miss:0},maxCombo:1});

test('ordinary web boot has no Discord routing, reporting, or polling',async()=>{
  const f=fixture({activity:false});await f.api.init();assert.equal(f.api.newRun(),null);
  assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);
});
test('Activity boot resolves the destination and sends a completed run with its signed context',async()=>{
  const f=fixture();await f.api.init();assert.equal(f.api.initialMode,'osu');
  const run=f.api.newRun();await f.api.complete(run,result());await settle();
  const post=f.calls.find(c=>c.url.endsWith('/score'));
  assert.equal(post.body.session,'server-signed');assert.equal(post.body.runId,run.id);
  assert.equal(post.body.counts.h300,1);assert.equal(post.body.channelId,undefined);
  assert.ok(![...f.store.values()].join('').includes('id-token'));
});

test('regular Start Activity keeps normal boot and reports library-selected Standard and Mania',async()=>{
  const f=fixture();f.context({mode:null,revision:null,requestedBy:null});
  const routes=[];f.window.GameShell.enterActivity=mode=>{routes.push(mode);return true;};
  await f.api.init();assert.equal(f.api.initialMode,null);
  for(const mode of ['osu','vsrg']) {
    f.api.setMode(mode);await settle();
    assert.equal(f.calls.filter(c=>c.url.endsWith('/context')).at(-1).body.playingMode,mode);
    const run=f.api.newRun();assert.ok(run);
    await f.api.complete(run,{...result(),mode});await settle();
    assert.equal(f.calls.filter(c=>c.url.endsWith('/score')).at(-1).body.mode,mode);
  }
  await f.tick();assert.deepEqual(routes,[]);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/context')).at(-1).body.playingMode,undefined);
});

test('regular boot can receive a later explicit launch without confusing it with presence',async()=>{
  const f=fixture();f.context({mode:null,revision:null,requestedBy:null});await f.api.init();
  f.api.setMode('osu');await settle();
  const routes=[];f.window.GameShell.enterActivity=mode=>{routes.push(mode);return true;};
  f.context({mode:'vsrg',revision:'command-1',requestedBy:'111'});await f.tick();
  assert.deepEqual(routes,['vsrg']);
});

test('ordinary web mode selection does not create Discord presence or score requests',async()=>{
  const f=fixture({activity:false});await f.api.init();f.api.setMode('osu');await settle();
  assert.equal(f.calls.length,0);assert.equal(f.api.newRun(),null);
});
test('network failure persists the original run ID and reload retries the same receipt',async()=>{
  const f=fixture();await f.api.init();const run=f.api.newRun();f.offline(true);
  await f.api.complete(run,result());await settle();
  assert.ok([...f.store.values()].join('').includes(run.id));
  const reload=fixture({store:f.store});await reload.api.init();await settle();
  assert.equal(reload.calls.find(c=>c.url.endsWith('/score')).body.runId,run.id);
  assert.equal(JSON.parse([...f.store.values()][0]).length,0);
});
test('identity changes while hashing cannot enqueue or post another account’s result',async()=>{
  const f=fixture();await f.api.init();const run=f.api.newRun();let resolve;
  const payload={...result(),chartHash:null,getText:()=>new Promise(r=>resolve=r)};
  const finished=f.api.complete(run,payload);f.identity(null);resolve('chart');await finished;await settle();
  assert.equal(f.calls.filter(c=>c.url.endsWith('/score')).length,0);
  assert.equal(f.api.newRun(),null);
});
test('a later launch context cannot redirect a score from a song already started',async()=>{
  const f=fixture();await f.api.init();const run=f.api.newRun();
  f.context({session:'different-channel-session',revision:'launch-2'});await f.tick();
  await f.api.complete(run,result());await settle();
  assert.equal(f.calls.find(c=>c.url.endsWith('/score')).body.session,'server-signed');
});

test('cover metadata comes only from a positive bounded set ID in the chart metadata section',async()=>{
  for (const [text,expected] of [
    ['osu file format v14\r\n[Metadata]\r\nTitle:Song\r\nBeatmapSetID:123456\r\n[Difficulty]\r\nHPDrainRate:5',123456],
    ['[Metadata]\nBeatmapSetID:-1',undefined],
    ['[Metadata]\nBeatmapSetID:999999999999999999',undefined],
    ['[Events]\nBeatmapSetID:123456',undefined],
    ['[Metadata]\nTitle:Song\n[Events]\nBeatmapSetID:123456',undefined],
  ]) {
    const f=fixture();await f.api.init();
    await f.api.complete(f.api.newRun(),{...result(),getText:async()=>text});await settle();
    assert.equal(f.calls.find(c=>c.url.endsWith('/score')).body.beatmapSetId,expected);
  }
});
test('a new explicit command retries routing after the current round, without routing other players',async()=>{
  const f=fixture();await f.api.init();const routes=[];let allow=false;
  f.window.GameShell.enterActivity=mode=>{routes.push(mode);return allow;};
  f.context({revision:'launch-2',mode:'vsrg'});await f.tick();assert.deepEqual(routes,['vsrg']);
  allow=true;await f.tick();await f.tick();assert.deepEqual(routes,['vsrg','vsrg']);
  f.context({revision:'launch-3',requestedBy:'222'});await f.tick();assert.equal(routes.length,2);
});

test('real shell direct entry reveals the selected game with no clicker frame or Enter action',()=>{
  const events={},nodes=new Map(),launches=[];let gameplay=false;
  class Element {
    constructor(){this.listeners={};this.isConnected=true;this.inert=true;this.dataset={};this.style={setProperty(){}};this.children=[];
      const classes=new Set(['is-booting']);this.classList={add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)};}
    addEventListener(k,fn){this.listeners[k]=fn;}remove(){this.isConnected=false;}focus(){this.focused=true;}
    querySelectorAll(){return [];}querySelector(){return null;}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const document={body:new Element(),readyState:'loading',hidden:false,getElementById:get,querySelectorAll:()=>[],
    querySelector:()=>gameplay?{}:null,addEventListener(){}};
  const window={AobingSky:require('./sky-time'),ActivityGames:{initialMode:'osu'},
    addEventListener(k,fn){events[k]=fn;},dispatchEvent(event){launches.push([event.type,event.detail]);}};
  const context=vm.createContext({window,document,matchMedia:()=>({matches:true}),location:{search:''},
    I18N:{t:k=>k},URLSearchParams,Event,CustomEvent,setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(fs.readFileSync('game-shell.js','utf8'),context);
  events.aobingready();
  assert.deepEqual(launches,[['aobingstart',undefined],['aobinglaunch','osu']]);
  assert.equal(get('curtain').isConnected,false);assert.equal(get('osu-select').focused,true);
  assert.equal(document.body.classList.contains('is-booting'),false);
  gameplay=true;assert.equal(window.GameShell.enterActivity('vsrg'),false);assert.equal(launches.length,2);
  gameplay=false;assert.equal(window.GameShell.enterActivity('vsrg'),true);
  assert.deepEqual(launches[2],['aobinglaunch','vsrg']);
});
