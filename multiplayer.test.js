'use strict';
// Unit tests for the PURE multiplayer core exported by multiplayer.js.
// Run: `node --test multiplayer.test.js`. No DOM, no real WebSocket.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const MP = require('./multiplayer.js');

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
