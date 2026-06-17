'use strict';
// Unit tests for the PURE VSRG engine exported by vsrg.js.
// Run: `node --test vsrg.test.js`
// No DOM, no audio, no mocks — the engine is framework-agnostic by design.
// Tests are intentionally verbose so failures double as debugging output.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ENGINE = require('./vsrg.js');

test('vsrg.js exports an engine object with a version tag', () => {
  assert.equal(typeof ENGINE, 'object');
  assert.equal(ENGINE.VSRG_ENGINE, true);
});

// =========================================================================
// parseMeta
// =========================================================================
const SAMPLE_OSU = [
  'osu file format v14',
  '',
  '[General]',
  'AudioFilename: track.mp3',
  'Mode: 3',
  '',
  '[Metadata]',
  'Title:Test Song',
  'Artist:Tester',
  'Version:Normal 4K',
  '',
  '[Difficulty]',
  'CircleSize:4',
  'OverallDifficulty:8',
  '',
].join('\n');

test('parseMeta: extracts audio, mode, title, artist, diff, keyCount, OD', () => {
  const m = ENGINE.parseMeta(SAMPLE_OSU);
  assert.equal(m.audioFile, 'track.mp3');
  assert.equal(m.mode, 3);
  assert.equal(m.title, 'Test Song');
  assert.equal(m.artist, 'Tester');
  assert.equal(m.diffName, 'Normal 4K');
  assert.equal(m.keyCount, 4);
  assert.equal(m.overallDifficulty, 8);
});

test('parseMeta: trims whitespace around keys and values', () => {
  const m = ENGINE.parseMeta('[General]\nAudioFilename:  spaced.ogg \nMode: 3\n');
  assert.equal(m.audioFile, 'spaced.ogg');
});

// =========================================================================
// parseHitObjects
// =========================================================================
// In 4K, x=64 -> col 0, x=192 -> col 1, x=320 -> col 2, x=448 -> col 3.
// (column = floor(x * keyCount / 512))
const HITOBJECTS = [
  '64,192,1000,1,0,0:0:0:0:',        // normal note, col 0, t=1000
  '448,192,1500,1,0,0:0:0:0:',       // normal note, col 3, t=1500
  '192,192,2000,128,0,2750:0:0:0:0:',// hold note, col 1, t=2000..2750
].join('\n');

test('parseHitObjects: maps x to column and reads absolute times', () => {
  const notes = ENGINE.parseHitObjects(HITOBJECTS, 4);
  assert.equal(notes.length, 3);
  assert.deepEqual(
    notes.map(n => ({ time: n.time, lane: n.lane, endTime: n.endTime })),
    [
      { time: 1000, lane: 0, endTime: null },
      { time: 1500, lane: 3, endTime: null },
      { time: 2000, lane: 1, endTime: 2750 },
    ]
  );
});

test('parseHitObjects: notes are returned sorted by time', () => {
  const unordered = '448,192,1500,1,0,0:0:0:0:\n64,192,1000,1,0,0:0:0:0:';
  const notes = ENGINE.parseHitObjects(unordered, 4);
  assert.deepEqual(notes.map(n => n.time), [1000, 1500]);
});

// =========================================================================
// parseTiming
// =========================================================================
const TIMING = [
  '500,500,4,2,0,100,1,0',    // uninherited: beatLength 500 -> 120 BPM, offset 500
  '1000,-50,4,2,0,100,0,0',   // inherited (SV) -> ignored
].join('\n');

test('parseTiming: first uninherited point gives BPM and offset', () => {
  const r = ENGINE.parseTiming(TIMING);
  assert.equal(r.bpm, 120);
  assert.equal(r.offset, 500);
});

test('parseTiming: returns null fields when no uninherited point exists', () => {
  const r = ENGINE.parseTiming('1000,-50,4,2,0,100,0,0');
  assert.equal(r.bpm, null);
  assert.equal(r.offset, null);
});

// =========================================================================
// parseOsu
// =========================================================================
const FULL_OSU = [
  'osu file format v14',
  '[General]', 'AudioFilename: track.mp3', 'Mode: 3',
  '[Metadata]', 'Title:Test Song', 'Artist:Tester', 'Version:Normal 4K',
  '[Difficulty]', 'CircleSize:4', 'OverallDifficulty:8',
  '[TimingPoints]', '500,500,4,2,0,100,1,0',
  '[HitObjects]',
  '64,192,1000,1,0,0:0:0:0:',
  '192,192,2000,128,0,2750:0:0:0:0:',
].join('\n');

test('parseOsu: assembles a full chart object', () => {
  const c = ENGINE.parseOsu(FULL_OSU);
  assert.equal(c.title, 'Test Song');
  assert.equal(c.keyCount, 4);
  assert.equal(c.overallDifficulty, 8);
  assert.equal(c.bpm, 120);
  assert.equal(c.audioFile, 'track.mp3');
  assert.equal(c.notes.length, 2);
  assert.equal(c.notes[1].endTime, 2750);
});

test('parseOsu: throws on non-mania (Mode !== 3)', () => {
  const std = FULL_OSU.replace('Mode: 3', 'Mode: 0');
  assert.throws(() => ENGINE.parseOsu(std), /mania/i);
});

test('parseOsu: throws when no hit objects are present', () => {
  const empty = FULL_OSU.split('[HitObjects]')[0] + '[HitObjects]\n';
  assert.throws(() => ENGINE.parseOsu(empty), /no notes/i);
});

// =========================================================================
// windowsForOD
// =========================================================================
test('windowsForOD: OD8 produces the standard mania half-windows (ms)', () => {
  const w = ENGINE.windowsForOD(8);
  assert.equal(w.marvelous, 16.5);
  assert.equal(w.perfect, 64 - 3 * 8); // 40
  assert.equal(w.great, 97 - 3 * 8);   // 73
  assert.equal(w.good, 127 - 3 * 8);   // 103
  assert.equal(w.bad, 151 - 3 * 8);    // 127
});

test('windowsForOD: windows widen as OD decreases', () => {
  const easy = ENGINE.windowsForOD(2);
  const hard = ENGINE.windowsForOD(10);
  assert.ok(easy.perfect > hard.perfect);
});

// =========================================================================
// judge
// =========================================================================
test('judge: classifies by absolute timing error against the windows', () => {
  const w = ENGINE.windowsForOD(8); // perfect 40, great 73, good 103, bad 127
  assert.equal(ENGINE.judge(1000, 1000, w).tier, 'marvelous'); // 0ms
  assert.equal(ENGINE.judge(1000, 1010, w).tier, 'marvelous'); // 10ms <=16.5
  assert.equal(ENGINE.judge(1000, 1030, w).tier, 'perfect');   // 30ms <=40
  assert.equal(ENGINE.judge(1000, 1060, w).tier, 'great');     // 60ms <=73
  assert.equal(ENGINE.judge(1000, 1110, w).tier, 'bad');       // 110ms >103 -> bad
});

test('judge: reports signed error (negative = early, positive = late)', () => {
  const w = ENGINE.windowsForOD(8);
  assert.equal(ENGINE.judge(1000, 970, w).errorMs, -30);
  assert.equal(ENGINE.judge(1000, 1030, w).errorMs, 30);
});

test('judge: beyond the bad window is a miss', () => {
  const w = ENGINE.windowsForOD(8); // bad = 127
  assert.equal(ENGINE.judge(1000, 1200, w).tier, 'miss');
});

// =========================================================================
// accuracy
// =========================================================================
test('accuracy: all marvelous/perfect = 100%', () => {
  const acc = ENGINE.accuracy({ marvelous: 5, perfect: 5, great: 0, good: 0, bad: 0, miss: 0 });
  assert.equal(acc, 100);
});

test('accuracy: all misses = 0%', () => {
  assert.equal(ENGINE.accuracy({ marvelous: 0, perfect: 0, great: 0, good: 0, bad: 0, miss: 4 }), 0);
});

test('accuracy: mania weighting (50/100/200/300) over 300*total', () => {
  // 1 great(200) + 1 good(100) over 2 notes => (200+100)/(300*2) = 50%
  const acc = ENGINE.accuracy({ marvelous: 0, perfect: 0, great: 1, good: 1, bad: 0, miss: 0 });
  assert.equal(acc, 50);
});

test('accuracy: zero notes guards to 0 (no divide-by-zero)', () => {
  assert.equal(ENGINE.accuracy({ marvelous: 0, perfect: 0, great: 0, good: 0, bad: 0, miss: 0 }), 0);
});

// =========================================================================
// createRunState / applyJudgement
// =========================================================================
test('createRunState: starts at zero counts, zero combo, full chart size', () => {
  const chart = ENGINE.parseOsu(FULL_OSU);
  const s = ENGINE.createRunState(chart);
  assert.equal(s.combo, 0);
  assert.equal(s.maxCombo, 0);
  assert.equal(s.totalNotes, 2);
  assert.deepEqual(s.counts, { marvelous: 0, perfect: 0, great: 0, good: 0, bad: 0, miss: 0 });
});

test('applyJudgement: scoring tiers grow combo; miss resets it', () => {
  const chart = ENGINE.parseOsu(FULL_OSU);
  let s = ENGINE.createRunState(chart);
  s = ENGINE.applyJudgement(s, 'perfect');
  s = ENGINE.applyJudgement(s, 'great');
  assert.equal(s.combo, 2);
  assert.equal(s.maxCombo, 2);
  s = ENGINE.applyJudgement(s, 'miss');
  assert.equal(s.combo, 0);     // reset
  assert.equal(s.maxCombo, 2);  // peak retained
  assert.equal(s.counts.perfect, 1);
  assert.equal(s.counts.great, 1);
  assert.equal(s.counts.miss, 1);
});

test('applyJudgement: bad counts as a hit but still breaks combo', () => {
  const chart = ENGINE.parseOsu(FULL_OSU);
  let s = ENGINE.createRunState(chart);
  s = ENGINE.applyJudgement(s, 'great');
  s = ENGINE.applyJudgement(s, 'bad');
  assert.equal(s.combo, 0);          // bad breaks combo (project rule)
  assert.equal(s.counts.bad, 1);
});

test('applyJudgement: does not mutate the input state (pure reducer)', () => {
  const chart = ENGINE.parseOsu(FULL_OSU);
  const s0 = ENGINE.createRunState(chart);
  const s1 = ENGINE.applyJudgement(s0, 'perfect');
  assert.equal(s0.combo, 0);  // original untouched
  assert.equal(s1.combo, 1);
});
