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
