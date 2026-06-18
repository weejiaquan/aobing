'use strict';
// Unit tests for the PURE Project Diva engine exported by divaft.js.
// Run: `node --test divaft.test.js`. No DOM, no audio, no mocks. Verbose.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('./divaft.js');

test('divaft.js exports an engine object', () => {
  assert.equal(E.DIVA_ENGINE, true);
  assert.deepEqual(E.FACE, ['triangle', 'circle', 'cross', 'square']);
});

// ---- fly-in geometry ----------------------------------------------------
test('trailPoint: p=0 at entry, p=1 at target', () => {
  const n = { x: 0.5, y: 0.5, angle: 0, distance: 0.3, amplitude: 0, frequency: 0 };
  const a = E.trailPoint(n, 0), b = E.trailPoint(n, 1);
  assert.ok(Math.abs(a.x - 0.8) < 1e-9 && Math.abs(a.y - 0.5) < 1e-9);  // entry = target + distance along +x
  assert.ok(Math.abs(b.x - 0.5) < 1e-9 && Math.abs(b.y - 0.5) < 1e-9);  // target
});
test('trailPoint: sine offset perpendicular, peaks at frequency phase', () => {
  const n = { x: 0.5, y: 0.5, angle: 0, distance: 0.4, amplitude: 0.1, frequency: 1 };
  const m = E.trailPoint(n, 0.25);   // sin(0.25*2π)=1 → +amplitude perpendicular
  // travel dir entry(+x)→target = (-1,0); perpendicular (dy,-dx) with d=(-1,0) → (0,1); offset*+1 → y +amplitude
  assert.ok(Math.abs(m.y - (0.5 + 0.1)) < 1e-6, 'y=' + m.y);
});

// ---- windows / accuracy / rank ------------------------------------------
test('tierFor: window boundaries match PH (32/64/96/128 ms)', () => {
  assert.equal(E.tierFor(0), 'cool');
  assert.equal(E.tierFor(32), 'cool');
  assert.equal(E.tierFor(33), 'fine');
  assert.equal(E.tierFor(64), 'fine');
  assert.equal(E.tierFor(65), 'safe');
  assert.equal(E.tierFor(96), 'safe');
  assert.equal(E.tierFor(97), 'sad');
  assert.equal(E.tierFor(128), 'sad');
  assert.equal(E.tierFor(129), 'worst');
});
test('accuracy matches PH NOTE_SCORES (COOL100/FINE80/SAFE50/SAD10)', () => {
  assert.equal(E.accuracy({ cool: 8, fine: 0, safe: 0, sad: 0, worst: 0 }), 100);
  assert.equal(E.accuracy({ cool: 0, fine: 0, safe: 0, sad: 0, worst: 0 }), 100);  // empty → 100
  assert.equal(E.accuracy({ cool: 1, fine: 1, safe: 0, sad: 0, worst: 0 }), 90);   // (100+80)/2
  assert.equal(E.accuracy({ cool: 0, fine: 0, safe: 0, sad: 1, worst: 0 }), 10);   // SAD weight 10, not 30
  assert.equal(E.accuracy({ cool: 1, fine: 0, safe: 0, sad: 0, worst: 1 }), 50);   // (100+0)/2
});
test('clearRank matches PH get_result_rating', () => {
  const c = (cool, fine, safe, sad, worst) => ({ cool: cool, fine: fine, safe: safe, sad: sad, worst: worst });
  assert.equal(E.clearRank(100, c(8, 0, 0, 0, 0)), 'PERFECT');     // all COOL
  assert.equal(E.clearRank(95, c(4, 4, 0, 0, 0)), 'PERFECT');      // COOL+FINE only → still PERFECT
  assert.equal(E.clearRank(96, c(7, 0, 1, 0, 0)), 'EXCELLENT');    // a SAFE bars PERFECT; ≥95 → EXCELLENT
  assert.equal(E.clearRank(92, c(5, 0, 0, 1, 0)), 'GREAT');        // ≥90
  assert.equal(E.clearRank(80, c(3, 0, 0, 2, 0)), 'STANDARD');     // ≥75
  assert.equal(E.clearRank(50, c(1, 0, 0, 0, 3)), 'CHEAP');        // <75
});

// ---- chart assembly ------------------------------------------------------
const SAMPLE = {
  title: 'T', artist: 'A', bpm: 160, audioFile: 'a.wav',
  notes: [
    { time: 2000, button: 'square', x: 0.5, y: 0.6, flyTime: 600, holdEnd: 2500 },
    { time: 1000, button: 'triangle', x: 0.3, y: 0.4, flyTime: 600, angle: 10, distance: 0.3, amplitude: 0.05, frequency: 1 },
    { time: 1000, button: 'circle', x: 0.7, y: 0.4 },     // same time as the triangle → a double
  ],
  chanceTimes: [{ start: 1500, end: 1900 }],
};
test('assembleChart: sorts, defaults, groups doubles, stars', () => {
  const ch = E.assembleChart(SAMPLE);
  assert.equal(ch.notes.length, 3);
  assert.equal(ch.notes[0].time, 1000);                 // sorted
  assert.equal(ch.notes[2].flyTime, 600);
  assert.equal(ch.notes[0].flyTime, 600);               // default applied
  assert.equal(ch.notes[0].groupId, ch.notes[1].groupId);  // the two time=1000 notes group
  assert.notEqual(ch.notes[0].groupId, null);
  assert.equal(ch.notes[2].groupId, null);              // the lone hold isn't grouped
  assert.equal(ch.notes[2].holdEnd, 2500);
  assert.ok(ch.stars >= 0.5 && ch.stars <= 12);
  assert.equal(ch.chanceTimes[0].start, 1500);
});
test('assembleChart: rejects unknown button', () => {
  assert.throws(() => E.assembleChart({ notes: [{ time: 0, button: 'banana', x: 0, y: 0 }] }), /Unknown button/);
});

// ---- input matcher -------------------------------------------------------
test('matchNote: nearest unhit matching-button note in window', () => {
  const objs = [
    { n: { time: 1000, button: 'triangle' }, headJudged: false },
    { n: { time: 1050, button: 'triangle' }, headJudged: false },
    { n: { time: 1045, button: 'circle' }, headJudged: false },
  ];
  assert.equal(E.matchNote(objs, 'triangle', 1040, 130), 1);   // 1050 nearer than 1000
  assert.equal(E.matchNote(objs, 'circle', 1040, 130), 2);
  assert.equal(E.matchNote(objs, 'square', 1040, 130), -1);    // no square
  objs[1].headJudged = true;
  assert.equal(E.matchNote(objs, 'triangle', 1040, 130), 0);   // now 1000
  assert.equal(E.matchNote(objs, 'triangle', 1040, 5), -1);    // out of window
});

test('inChanceTime', () => {
  const ct = [{ start: 1500, end: 1900 }];
  assert.equal(E.inChanceTime(ct, 1600), true);
  assert.equal(E.inChanceTime(ct, 1400), false);
});

// ---- bundled sample exercises every mechanic -----------------------------
test('bundled sample chart: assembles + has every mechanic', () => {
  const raw = require('./assets/divaft/test/sample.json');
  const ch = E.assembleChart(raw);
  assert.ok(ch.notes.length >= 15);
  assert.ok(ch.notes.every((n, i, a) => i === 0 || n.time >= a[i - 1].time), 'sorted by time');
  assert.ok(ch.notes.some((n) => n.holdEnd != null), 'has a hold');
  assert.ok(ch.notes.some((n) => n.button === 'slideL') && ch.notes.some((n) => n.button === 'slideR'), 'has slides');
  assert.ok(ch.notes.some((n) => n.slideChain != null), 'has a slide chain');
  assert.ok(ch.notes.some((n) => n.groupId != null), 'has a double/multi');
  assert.ok(ch.chanceTimes.length >= 1, 'has chance time');
  for (const b of E.FACE) assert.ok(ch.notes.some((n) => n.button === b), 'has a ' + b);
});
