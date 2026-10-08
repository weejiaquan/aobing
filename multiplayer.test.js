'use strict';
// Unit tests for the PURE multiplayer core exported by multiplayer.js.
// Run: `node --test multiplayer.test.js`. No DOM, no real WebSocket.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const MP = require('./multiplayer.js');

test('Activity preview does not join or replace an existing lobby or selected map', () => {
  for (const lobby of [null,{id:'JOINED',members:{self:{}}}]) {
    const state={status:'online',uid:'self',lobby,currentMap:{hash:'original'}};
    const next=MP.applyServerMessage(state,{type:'activity_lobby',lobby:{id:'PREVIEW',members:[]}});
    assert.equal(next.lobby,lobby);
    assert.equal(next.currentMap,state.currentMap);
  }
});

test('multiplayer.js exports an engine object', () => {
  assert.equal(MP.MP_ENGINE, true);
});

test('buildJoin produces a join_lobby message', () => {
  assert.deepEqual(MP.buildJoin('ROOM', 'pw'),
    { type: 'join_lobby', id: 'ROOM', password: 'pw' });
});

test('applyServerMessage: auth_ok sets uid and online status', () => {
  const s0 = { status: 'connecting', uid: null, lobby: null, error: null };
  const s1 = MP.applyServerMessage(s0, { type: 'auth_ok', uid: 'u1' });
  assert.equal(s1.status, 'online');
  assert.equal(s1.uid, 'u1');
  assert.equal(s0.uid, null); // input not mutated
});

test('applyServerMessage: lobby_state and member events update lobby', () => {
  let s = { status: 'online', uid: 'u1', lobby: null, error: null };
  const lobby = { id: 'ROOM', members: { u1: { name: 'A' } } };
  s = MP.applyServerMessage(s, { type: 'lobby_state', lobby });
  assert.equal(s.lobby.id, 'ROOM');
  const lobby2 = { id: 'ROOM', members: { u1: { name: 'A' }, u2: { name: 'B' } } };
  s = MP.applyServerMessage(s, { type: 'member_joined', lobby: lobby2 });
  assert.deepEqual(Object.keys(s.lobby.members), ['u1', 'u2']);
});

test('applyServerMessage: error sets error field', () => {
  const s = MP.applyServerMessage(
    { status: 'online', uid: 'u1', lobby: null, error: null },
    { type: 'error', code: 'bad_password' });
  assert.equal(s.error, 'bad_password');
});

// A controllable fake WebSocket for connection-manager tests.
function makeFakeWS() {
  const instances = [];
  class FakeWS {
    constructor(url) {
      this.url = url; this.sent = []; this.readyState = 0;
      this.onopen = null; this.onmessage = null;
      this.onclose = null; this.onerror = null;
      instances.push(this);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    _open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    _emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  }
  return { FakeWS, instances };
}

test('createConnection: opens, authenticates, reaches online', async () => {
  const { FakeWS, instances } = makeFakeWS();
  const states = [];
  const conn = MP.createConnection({
    url: 'wss://x/api/mp/ws',
    getToken: async () => 'TOK',
    WebSocketImpl: FakeWS,
    onState: (s) => states.push(s.status),
  });
  await new Promise((r) => setTimeout(r, 0)); // let getToken resolve
  const ws = instances[0];
  ws._open();
  await new Promise((r) => setTimeout(r, 0)); // auth frame sent after open
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'auth', token: 'TOK' });
  ws._emit({ type: 'auth_ok', uid: 'u1' });
  assert.equal(states[states.length - 1], 'online');
  conn.close();
});

test('createConnection: socket close flips status to offline', async () => {
  const { FakeWS, instances } = makeFakeWS();
  const states = [];
  MP.createConnection({
    url: 'wss://x/api/mp/ws', getToken: async () => 'TOK',
    WebSocketImpl: FakeWS, onState: (s) => states.push(s.status),
  });
  await new Promise((r) => setTimeout(r, 0));
  const ws = instances[0];
  ws._open();
  ws._emit({ type: 'auth_ok', uid: 'u1' });
  ws.close();
  assert.equal(states[states.length - 1], 'offline');
});

test('createConnection: connect timeout flips to offline', async () => {
  const { FakeWS } = makeFakeWS();
  const states = [];
  MP.createConnection({
    url: 'wss://x/api/mp/ws', getToken: async () => 'TOK',
    WebSocketImpl: FakeWS, onState: (s) => states.push(s.status),
    connectTimeoutMs: 5,
  });
  await new Promise((r) => setTimeout(r, 20)); // never opened
  assert.equal(states[states.length - 1], 'offline');
});

test('createConnection: getToken rejection flips to offline', async () => {
  const { FakeWS, instances } = makeFakeWS();
  const states = [];
  MP.createConnection({
    url: 'wss://x/api/mp/ws',
    getToken: async () => { throw new Error('no token'); },
    WebSocketImpl: FakeWS, onState: (s) => states.push(s.status),
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(states[states.length - 1], 'offline');
  assert.equal(instances.length, 0); // socket never constructed
});

test('createConnection: send before auth_ok is dropped', async () => {
  const { FakeWS, instances } = makeFakeWS();
  const conn = MP.createConnection({
    url: 'wss://x/api/mp/ws', getToken: async () => 'TOK',
    WebSocketImpl: FakeWS, onState: () => {},
  });
  await new Promise((r) => setTimeout(r, 0));
  const ws = instances[0];
  ws._open(); // auth frame is sent on open
  conn.send({ type: 'ping' }); // not authed yet → must be dropped
  assert.equal(ws.sent.length, 1); // only the auth frame
  assert.equal(JSON.parse(ws.sent[0]).type, 'auth');
  conn.close();
});

test('u8ToB64 / b64ToU8 round-trip arbitrary bytes', () => {
  const samples = [
    new Uint8Array([]),
    new Uint8Array([0, 1, 2, 254, 255]),
    new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256)),
  ];
  for (const u8 of samples) {
    const b64 = MP.u8ToB64(u8);
    assert.equal(typeof b64, 'string');
    const back = MP.b64ToU8(b64);
    assert.deepEqual(Array.from(back), Array.from(u8));
  }
});

test('encodeChartTransfer / decodeChartTransfer round-trip (with art)', () => {
  const rec = {
    osuText: 'osu file body\nwith lines', hash: 'abc123',
    title: 'Song', artist: 'X', diffName: 'Hard', stars: 4.2, length: 90000,
    audio: new Uint8Array([1, 2, 3, 250, 255]),
    art: new Uint8Array([9, 8, 7]),
  };
  const str = MP.encodeChartTransfer(rec);
  assert.equal(typeof str, 'string');
  const back = MP.decodeChartTransfer(str);
  assert.equal(back.osuText, rec.osuText);
  assert.equal(back.hash, 'abc123');
  assert.equal(back.title, 'Song');
  assert.equal(back.length, 90000);
  assert.equal(back.artist, 'X');
  assert.equal(back.diffName, 'Hard');
  assert.equal(back.stars, 4.2);
  assert.deepEqual(Array.from(back.audio), [1, 2, 3, 250, 255]);
  assert.deepEqual(Array.from(back.art), [9, 8, 7]);
});

test('decodeChartTransfer yields null art when absent', () => {
  const rec = { osuText: 'x', hash: 'h', title: 't', artist: 'a', diffName: 'd',
    stars: 1, length: 1, audio: new Uint8Array([1]), art: null };
  const back = MP.decodeChartTransfer(MP.encodeChartTransfer(rec));
  assert.equal(back.art, null);
  assert.deepEqual(Array.from(back.audio), [1]);
});

test('chunkString splits and reassembles in order', () => {
  const s = 'abcdefghij';
  const frames = MP.chunkString(s, 4);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].total, 3);
  const ra = MP.createReassembler();
  let done = false;
  for (const f of frames) done = ra.add(f);
  assert.equal(done, true);
  assert.equal(ra.result(), s);
});

test('reassembler tolerates out-of-order and duplicate frames', () => {
  const frames = MP.chunkString('hello world!!', 5); // 3 frames
  const ra = MP.createReassembler();
  ra.add(frames[2]); ra.add(frames[0]); ra.add(frames[0]); // dup
  assert.equal(ra.isComplete(), false);
  assert.equal(ra.result(), null);
  const done = ra.add(frames[1]);
  assert.equal(done, true);
  assert.equal(ra.result(), 'hello world!!');
  assert.equal(ra.received(), 3);
  assert.equal(ra.total(), 3);
});

test('chunkString of empty string yields one empty frame', () => {
  const frames = MP.chunkString('', 4);
  assert.deepEqual(frames, [{ seq: 0, total: 1, data: '' }]);
});

test('reassembler latches total from first frame, ignores divergent total', () => {
  const ra = MP.createReassembler();
  ra.add({ seq: 0, total: 2, data: 'AA' });
  // A stray/replayed frame claiming a different total must not corrupt completion.
  ra.add({ seq: 0, total: 99, data: 'AA' }); // duplicate seq, divergent total
  assert.equal(ra.total(), 2);
  assert.equal(ra.isComplete(), false);
  const done = ra.add({ seq: 1, total: 2, data: 'BB' });
  assert.equal(done, true);
  assert.equal(ra.result(), 'AABB');
});

test('buildSelectMap and buildRelay shapes', () => {
  assert.deepEqual(MP.buildSelectMap({ hash: 'h' }), { type: 'select_map', map: { hash: 'h' } });
  assert.deepEqual(MP.buildRelay('u2', { t: 'need_map' }),
    { type: 'relay', to_uid: 'u2', body: { t: 'need_map' } });
});

test('applyServerMessage: map_selected sets currentMap, does not mutate input', () => {
  const s0 = { status: 'online', uid: 'u1', lobby: null, error: null, currentMap: null };
  const s1 = MP.applyServerMessage(s0, { type: 'map_selected', map: { hash: 'h', title: 'T' } });
  assert.deepEqual(s1.currentMap, { hash: 'h', title: 'T' });
  assert.equal(s0.currentMap, null); // input untouched
});

test('createConnection: onMessage receives every raw incoming message', async () => {
  const { FakeWS, instances } = makeFakeWS();
  const raw = [];
  const conn = MP.createConnection({
    url: 'wss://x/api/mp/ws', getToken: async () => 'TOK',
    WebSocketImpl: FakeWS, onState: () => {}, onMessage: (m) => raw.push(m),
  });
  await new Promise((r) => setTimeout(r, 0));
  const ws = instances[0];
  ws._open();
  ws._emit({ type: 'auth_ok', uid: 'u1' });
  ws._emit({ type: 'relay', from_uid: 'u2', body: { t: 'need_map', hash: 'h' } });
  assert.equal(raw.length, 2);
  assert.deepEqual(raw[1], { type: 'relay', from_uid: 'u2', body: { t: 'need_map', hash: 'h' } });
  assert.equal(conn.getState().currentMap, null); // initial state carries the field
  conn.close();
});

test('first Create/Join action waits for authentication and is delivered exactly once', async () => {
  const {FakeWS,instances}=makeFakeWS();
  const conn=MP.createConnection({url:'wss://test',getToken:async()=> 'token',WebSocketImpl:FakeWS});
  assert.equal(conn.send(MP.buildJoin('ROOM')),true);
  assert.equal(conn.send(MP.buildJoin('OTHER')),false);
  await new Promise(r=>setImmediate(r)); const ws=instances[0]; ws._open();
  assert.equal(ws.sent.length,1); ws._emit({type:'auth_ok',uid:'u'});
  assert.equal(JSON.parse(ws.sent[1]).id,'ROOM'); assert.equal(ws.sent.length,2); conn.close();
});

test('timed-out token lookup cannot resurrect a connection',async()=>{
  const {FakeWS,instances}=makeFakeWS(); let resolve;
  const conn=MP.createConnection({url:'wss://test',getToken:()=>new Promise(r=>resolve=r),WebSocketImpl:FakeWS,connectTimeoutMs:5});
  await new Promise(r=>setTimeout(r,15));resolve('late');await new Promise(r=>setImmediate(r));
  assert.equal(conn.getState().status,'offline');assert.equal(instances.length,0);conn.close();
});

test('malformed incoming JSON closes socket and clears stale lobby',async()=>{
  const {FakeWS,instances}=makeFakeWS();
  const conn=MP.createConnection({url:'wss://test',getToken:async()=> 'token',WebSocketImpl:FakeWS});
  await new Promise(r=>setImmediate(r));const ws=instances[0];ws._open();ws._emit({type:'auth_ok',uid:'u'});
  ws._emit({type:'lobby_state',lobby:{id:'r',current_map:{hash:'a'}}});
  ws.onmessage({data:'{broken'});
  assert.equal(conn.getState().status,'offline');assert.equal(conn.getState().lobby,null);assert.equal(ws.readyState,3);
});

test('message callback reads the updated selected map and leave clears it',async()=>{
  const {FakeWS,instances}=makeFakeWS();let seen;
  const conn=MP.createConnection({url:'wss://test',getToken:async()=> 'token',WebSocketImpl:FakeWS,onMessage:m=>{if(m.type==='map_selected')seen=conn.getState().currentMap;}});
  await new Promise(r=>setImmediate(r));const ws=instances[0];ws._open();ws._emit({type:'auth_ok',uid:'u'});
  ws._emit({type:'map_selected',map:{hash:'a'}});assert.equal(seen.hash,'a');
  ws._emit({type:'lobby_state',lobby:null});assert.equal(conn.getState().currentMap,null);conn.close();
});

test('transfer validates chart text, audio and samples, independently of derived metadata',async()=>{
  const rec={osuText:'text',hash:await MP.digest('text'),title:'A',audio:new Uint8Array([1,2]),samples:[{name:'hit.wav',bytes:new Uint8Array([3,4])}]};
  const encoded=MP.encodeChartTransfer(rec), map={hash:rec.hash,contentHash:await MP.contentDigest(encoded)};
  assert.equal((await MP.verifyTransfer(encoded,map)).hash,rec.hash);
  const derived=MP.encodeChartTransfer({...rec,title:'Renamed metadata'});
  assert.equal(await MP.contentDigest(derived),map.contentHash);
  for(const changed of [{...rec,audio:new Uint8Array([9])},{...rec,osuText:'wrong'},{...rec,samples:[]}]) {
    await assert.rejects(MP.verifyTransfer(MP.encodeChartTransfer(changed),map),/corrupted/);
  }
  const dishonest=MP.encodeChartTransfer({...rec,hash:'f'.repeat(64)});
  await assert.rejects(MP.verifyTransfer(dishonest,{hash:'f'.repeat(64),contentHash:await MP.contentDigest(dishonest)}),/corrupted/);
});

test('reassembly rejects unbounded, conflicting and invalid frame indices',()=>{
  for(const frame of [{seq:-1,total:1,data:''},{seq:1,total:1,data:''},{seq:0,total:1e9,data:''},{seq:0,total:1,data:9},{seq:0,total:1,data:'a'.repeat(49153)}]) assert.throws(()=>MP.createReassembler().add(frame));
  const ra=MP.createReassembler();ra.add({seq:0,total:2,data:'a'});
  assert.throws(()=>ra.add({seq:0,total:2,data:'b'}));assert.throws(()=>ra.add({seq:1,total:3,data:'b'}));
  assert.throws(()=>MP.chunkString('x',0));
});

test('peer setup failure triggers fallback exactly once and closes safely',async()=>{
  let fallback=0;
  const p=MP.createPeerSession({offerer:true,RTCPeerConnectionImpl:class {constructor(){throw Error('blocked');}},onFailure:()=>fallback++,signal(){}});
  await new Promise(r=>setImmediate(r));await p.signal({kind:'ice',data:{}});p.close();assert.equal(fallback,1);
});

test('peer handshake buffers early ICE and timeout tears down without leaked callbacks',async()=>{
  const pcs=[],timers=new Map();let next=0,failures=0;
  class PC {constructor(){pcs.push(this);this.remoteDescription=null;this.candidates=[];}async setRemoteDescription(v){this.remoteDescription=v;}async addIceCandidate(v){this.candidates.push(v);}async createAnswer(){return {type:'answer',sdp:'x'};}async setLocalDescription(v){this.localDescription=v;}close(){this.closed=true;}}
  const signals=[];const p=MP.createPeerSession({offerer:false,RTCPeerConnectionImpl:PC,setTimeoutImpl:f=>{timers.set(++next,f);return next;},clearTimeoutImpl:id=>timers.delete(id),signal:s=>signals.push(s),onFailure:()=>failures++});
  await new Promise(r=>setImmediate(r));await p.signal({kind:'ice',data:{candidate:'x'}});assert.equal(pcs[0].candidates.length,0);
  await p.signal({kind:'offer',data:{type:'offer',sdp:'o'}});assert.equal(pcs[0].candidates.length,1);assert.equal(signals[0].kind,'answer');
  [...timers.values()][0]();assert.equal(failures,1);assert.equal(pcs[0].closed,true);assert.equal(timers.size,0);p.close();assert.equal(failures,1);
});

test('peer data channel transfers chunked Unicode payload and clears its watchdog on close',async()=>{
  let dc,pc;const sent=[];let failures=0;
  class PC {constructor(){pc=this;}createDataChannel(){return dc={readyState:'connecting',bufferedAmount:0,send:s=>sent.push(s),close(){this.readyState='closed';}};}async createOffer(){return {type:'offer',sdp:'o'};}async setLocalDescription(v){this.localDescription=v;}close(){this.closed=true;}}
  const session=MP.createPeerSession({offerer:true,RTCPeerConnectionImpl:PC,signal(){},onFailure:()=>failures++});
  await new Promise(r=>setImmediate(r));dc.readyState='open';dc.onopen();
  const data='abc日本語'.repeat(4000);await session.send(data);
  const ra=MP.createReassembler();sent.forEach(s=>ra.add(JSON.parse(s)));assert.equal(ra.result(),data);assert.ok(sent.length>1);
  session.close();assert.equal(pc.closed,true);assert.equal(failures,0);
});

test('peer backpressure timeout rejects instead of adding unbounded queued data',async()=>{
  let dc;const sent=[];
  class PC {createDataChannel(){return dc={readyState:'open',bufferedAmount:1024*1024,send:s=>sent.push(s),close(){}};}async createOffer(){return {type:'offer',sdp:'o'};}async setLocalDescription(v){this.localDescription=v;}close(){}}
  const session=MP.createPeerSession({offerer:true,RTCPeerConnectionImpl:PC,signal(){},onFailure(){}});
  await new Promise(r=>setImmediate(r));const original=Date.now;let fakeTime=0;
  try{Date.now=()=>fakeTime+=20000;await assert.rejects(session.send('data'),/peer closed/);assert.equal(sent.length,0);}
  finally{Date.now=original;session.close();}
});

test('ICE discovered during setLocalDescription is sent after the offer so the host can route it',async()=>{
  const signals=[];
  class PC {
    createDataChannel(){return {close(){}};}
    async createOffer(){return {type:'offer',sdp:'offer'};}
    async setLocalDescription(value){this.localDescription=value;this.onicecandidate({candidate:{candidate:'early'}});}
    close(){}
  }
  const session=MP.createPeerSession({offerer:true,RTCPeerConnectionImpl:PC,signal:s=>signals.push(s),onFailure(){assert.fail('unexpected peer failure');}});
  await new Promise(r=>setImmediate(r));assert.deepEqual(signals.map(s=>s.kind),['offer','ice']);session.close();
});
