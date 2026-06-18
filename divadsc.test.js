'use strict';
// Tests for the binary .dsc decoder. The committed tests build SYNTHETIC .dsc
// buffers in-code (no copyrighted game data); a guarded block additionally decodes
// the user's real fixtures when present (those files are gitignored). Verbose.
//
// Run: `node --test divadsc.test.js`
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const D = require('./divadsc.js');

// --- tiny DSC encoder: signature + a sequence of [opcode, ...args] int32 LE -----
function buildDsc(ops) {
  const ints = [D.SIGNATURE];
  for (const op of ops) for (const v of op) ints.push(v | 0);
  const buf = new ArrayBuffer(ints.length * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, ints[0] >>> 0, true);
  for (let i = 1; i < ints.length; i++) dv.setInt32(i * 4, ints[i], true);
  return buf;
}
const TIME = (u) => [0x01, u];
const FLY = (ms) => [0x3A, ms];                 // 0x3A arg is flying-time in ms (×100 units internally)
const TARGET = (type, x, y, ang, dist, amp, freq) => [0x06, type, x, y, ang, dist, amp, freq];
const END = [0x00];

test('decode: signature, TIME/FLY/TARGET mapping, hit time = timer + flyTime', () => {
  const buf = buildDsc([
    TIME(0), FLY(600),
    TARGET(0, 240000, 135000, 90000, 270000, 500, 2),   // triangle, centre
    END,
  ]);
  const r = D.decode(buf);
  assert.equal(r.notes.length, 1);
  const n = r.notes[0];
  assert.equal(n.button, 'triangle');
  assert.ok(Math.abs(n.x - 0.5) < 1e-9 && Math.abs(n.y - 0.5) < 1e-9);
  assert.equal(n.time, 600);          // (timer 0 + flyTime 60000 units) / 100
  assert.equal(n.flyTime, 600);
  assert.equal(n.angle, 0);           // 90000/1000 - 90
  assert.equal(n.frequency, 2);
  assert.ok(n.amplitude > 0 && n.distance > 0);
});

test('decode: every button family maps correctly', () => {
  const buf = buildDsc([
    TIME(0), FLY(500),
    TARGET(1, 0, 0, 0, 1, 0, 0),     // circle
    TARGET(2, 0, 0, 0, 1, 0, 0),     // cross
    TARGET(3, 0, 0, 0, 1, 0, 0),     // square
    TARGET(5, 0, 0, 0, 1, 0, 0),     // held circle -> circle tap
    TARGET(12, 0, 0, 0, 1, 0, 0),    // single slide L
    TARGET(13, 0, 0, 0, 1, 0, 0),    // single slide R
    TARGET(19, 0, 0, 0, 1, 0, 0),    // PV-event note -> circle
    END,
  ]);
  const got = D.decode(buf).notes.map((n) => n.button);
  assert.deepEqual(got, ['circle', 'cross', 'square', 'circle', 'slideL', 'slideR', 'circle']);
});

test('decode: consecutive slide-chain links share a slideChain id; direction change starts a new one', () => {
  const buf = buildDsc([
    TIME(0), FLY(500),
    TARGET(16, 100000, 100000, 0, 1, 0, 0),   // R chain link 1
    TARGET(16, 150000, 100000, 0, 1, 0, 0),   // R chain link 2 (same id)
    TARGET(16, 200000, 100000, 0, 1, 0, 0),   // R chain link 3 (same id)
    TARGET(15, 200000, 100000, 0, 1, 0, 0),   // L chain link (new id)
    TARGET(0, 0, 0, 0, 1, 0, 0),              // a tap resets the chain
    END,
  ]);
  const ns = D.decode(buf).notes;
  const chains = ns.map((n) => n.slideChain);
  assert.equal(chains[0], chains[1]);
  assert.equal(chains[1], chains[2]);
  assert.notEqual(chains[3], chains[2]);   // direction flip => new chain
  assert.equal(chains[4], null);           // the plain tap is not chained
  assert.equal(ns[3].button, 'slideL');
  assert.equal(ns[0].button, 'slideR');
});

test('decode: doubles stay same-time so assembleChart can group them', () => {
  // two TARGETs under one TIME → identical hit time
  const buf = buildDsc([
    TIME(50000), FLY(500),
    TARGET(0, 0, 0, 0, 1, 0, 0),
    TARGET(1, 0, 0, 0, 1, 0, 0),
    END,
  ]);
  const ns = D.decode(buf).notes;
  assert.equal(ns.length, 2);
  assert.equal(ns[0].time, ns[1].time);
});

test('decode: 0x1C bar-time sets flyTime from bpm', () => {
  // flyTime = (60/bpm)*(beats+1)*100000 units → ms = /100. bpm=120, beats arg=1 → (0.5)*(2)*1000 = 1000ms
  const buf = buildDsc([
    TIME(0), [0x1C, 120, 1],
    TARGET(0, 0, 0, 0, 1, 0, 0),
    END,
  ]);
  assert.equal(D.decode(buf).notes[0].flyTime, 1000);
});

test('decode: unknown TARGET type is skipped, not emitted', () => {
  const buf = buildDsc([
    TIME(0), FLY(500),
    TARGET(9, 0, 0, 0, 1, 0, 0),   // type 9 is not a playable note → skipped
    TARGET(0, 0, 0, 0, 1, 0, 0),
    END,
  ]);
  assert.equal(D.decode(buf).notes.length, 1);
});

test('decode: rejects a non-dsc buffer', () => {
  const bad = new ArrayBuffer(8); new DataView(bad).setUint32(0, 0xdeadbeef, true);
  assert.throws(() => D.decode(bad), /bad signature/);
});

test('decode: stops cleanly at END even with trailing bytes', () => {
  const ops = [TIME(0), FLY(500), TARGET(0, 0, 0, 0, 1, 0, 0), END];
  const base = buildDsc(ops);
  const padded = new Uint8Array(base.byteLength + 16);
  padded.set(new Uint8Array(base));
  const r = D.decode(padded.buffer);
  assert.equal(r.notes.length, 1);
});

// --- guarded: decode the user's REAL charts when the local fixtures exist --------
const FIX = path.join(__dirname, 'test', 'fixtures', 'divaft');
const realDsc = fs.existsSync(FIX) ? fs.readdirSync(FIX).filter((f) => f.endsWith('.dsc')) : [];
test('decode: real Mega Mix+ charts (skipped if fixtures absent)', { skip: realDsc.length === 0 ? 'no local fixtures' : false }, () => {
  for (const f of realDsc) {
    const b = fs.readFileSync(path.join(FIX, f));
    const r = D.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    assert.ok(r.notes.length > 50, f + ' has many notes');
    assert.ok(r.notes.every((n, i, a) => i === 0 || n.time >= a[i - 1].time), f + ' time-sorted');
    assert.ok(r.notes.every((n) => n.x >= -0.1 && n.x <= 1.1 && n.y >= -0.1 && n.y <= 1.1), f + ' positions in field');
    const buttons = new Set(r.notes.map((n) => n.button));
    assert.ok(buttons.size >= 2, f + ' has a mix of buttons');
    assert.ok(r.notes.every((n) => n.flyTime > 0), f + ' flyTime populated');
  }
});
