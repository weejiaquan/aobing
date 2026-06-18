'use strict';
// Unit tests for the PURE osu!standard engine exported by osustd.js.
// Run: `node --test osustd.test.js`
// No DOM, no audio, no mocks. Verbose so failures double as debugging output.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('./osustd.js');

test('osustd.js exports an engine object', () => {
  assert.equal(E.OSUSTD_ENGINE, true);
});

// =========================================================================
// Geometry
// =========================================================================
test('csRadius: standard formula 54.4 - 4.48*CS', () => {
  assert.equal(E.csRadius(4), 54.4 - 4.48 * 4);
  assert.ok(Math.abs(E.csRadius(5) - 32) < 1e-9);
});

test('arPreempt: AR5=1200, AR0=1800, AR10=450', () => {
  assert.equal(E.arPreempt(5), 1200);
  assert.equal(E.arPreempt(0), 1800);
  assert.equal(E.arPreempt(10), 450);
  assert.ok(E.arPreempt(8) < E.arPreempt(5));   // higher AR = shorter preempt
});

test('odWindows: 300/100/50 shrink with OD', () => {
  const w = E.odWindows(5);
  assert.equal(w.h300, 80 - 30);   // 50
  assert.equal(w.h100, 140 - 40);  // 100
  assert.equal(w.h50, 200 - 50);   // 150
  assert.ok(E.odWindows(9).h300 < E.odWindows(2).h300);
});

// =========================================================================
// Parsing
// =========================================================================
const META = [
  'osu file format v14',
  '[General]', 'AudioFilename: a.mp3', 'Mode: 0',
  '[Metadata]', 'Title:T', 'Artist:A', 'Version:V',
  '[Difficulty]', 'CircleSize:4', 'OverallDifficulty:8', 'ApproachRate:9',
  'SliderMultiplier:1.6', 'SliderTickRate:1',
].join('\n');

test('parseStdMeta: reads CS/OD/AR/SliderMultiplier; mode 0', () => {
  const m = E.parseStdMeta(META);
  assert.equal(m.mode, 0);
  assert.equal(m.cs, 4); assert.equal(m.od, 8); assert.equal(m.ar, 9);
  assert.equal(m.sliderMultiplier, 1.6);
  assert.equal(m.audioFile, 'a.mp3');
});

test('parseStdMeta: AR defaults to OD when ApproachRate is absent', () => {
  const noAr = META.replace('ApproachRate:9\n', '');
  assert.equal(E.parseStdMeta(noAr).ar, 8);
});

test('parseHitObjects: circle / slider / spinner', () => {
  const objs = E.parseHitObjects([
    '256,192,1000,1,0,0:0:0:0:',                         // circle
    '100,100,2000,2,0,L|300:100,1,200',                  // linear slider, length 200, 1 slide
    '256,192,4000,8,0,6000',                             // spinner 4000..6000
  ].join('\n'));
  assert.equal(objs.length, 3);
  assert.equal(objs[0].kind, 'circle');
  assert.deepEqual({ x: objs[0].x, y: objs[0].y, time: objs[0].time }, { x: 256, y: 192, time: 1000 });
  assert.equal(objs[1].kind, 'slider');
  assert.equal(objs[1].curveType, 'L');
  assert.equal(objs[1].length, 200);
  assert.equal(objs[1].slides, 1);
  assert.deepEqual(objs[1].points[0], { x: 100, y: 100 });
  assert.deepEqual(objs[1].points[1], { x: 300, y: 100 });
  assert.equal(objs[2].kind, 'spinner');
  assert.equal(objs[2].endTime, 6000);
});

test('parseHitObjects: hitSound bitmask + slider edgeSounds are read', () => {
  const objs = E.parseHitObjects([
    '256,192,1000,1,2,0:0:0:0:',                          // circle, hitSound 2 (whistle)
    '100,100,2000,2,8,L|300:100,1,200,2|0,0:0|0:0',       // slider, hitSound 8 (clap), edgeSounds 2|0
    '256,192,4000,12,4,6000',                             // spinner, hitSound 4 (finish)
  ].join('\n'));
  assert.equal(objs[0].hitSound, 2);
  assert.equal(objs[1].hitSound, 8);
  assert.deepEqual(objs[1].edgeSounds, [2, 0]);
  assert.equal(objs[2].hitSound, 4);
});

test('parseHitObjects: NewCombo flag (type bit 2) is read', () => {
  const objs = E.parseHitObjects([
    '256,192,1000,1,0,0:0:0:0:',     // circle, type 1 -> no new combo
    '256,192,1100,5,0,0:0:0:0:',     // circle, type 5 (1|4) -> new combo
    '100,100,2000,6,0,L|300:100,1,200', // slider, type 6 (2|4) -> new combo
    '256,192,4000,12,0,6000',        // spinner, type 12 (8|4) -> new combo
  ].join('\n'));
  assert.equal(objs[0].newCombo, false);
  assert.equal(objs[1].newCombo, true);
  assert.equal(objs[2].newCombo, true);
  assert.equal(objs[3].newCombo, true);
});

test('parseSkinColors: reads [Colours] Combo1..N in order, skips gaps', () => {
  const ini = [
    '[General]', 'Name: My Skin',
    '[Colours]',
    'Combo1 : 255,192,0',
    'Combo2: 0,202,0',
    'SliderBorder: 1,2,3',          // ignored (not a Combo entry)
    'Combo4 : 10,20,30',            // Combo3 absent -> skipped, Combo4 still kept
  ].join('\n');
  const cols = E.parseSkinColors(ini);
  assert.deepEqual(cols, ['rgb(255,192,0)', 'rgb(0,202,0)', 'rgb(10,20,30)']);
});

test('parseSkinColors: empty / missing section -> []', () => {
  assert.deepEqual(E.parseSkinColors(''), []);
  assert.deepEqual(E.parseSkinColors('[General]\nName: x'), []);
});

test('estimateStars: denser/wider-spaced charts rate higher; clamped to [0.5,12]', () => {
  const mk = (n, spacing, dt) => {   // n circles, `spacing` px apart, `dt` ms apart
    const objs = [];
    for (let i = 0; i < n; i++) objs.push({ kind: 'circle', x: 256 + (i % 2 ? spacing : 0), y: 192, time: i * dt });
    return objs;
  };
  const easy = E.estimateStars(mk(20, 20, 600), 4, 8);    // sparse + tight spacing
  const hard = E.estimateStars(mk(120, 200, 150), 5, 9);  // dense + wide spacing
  assert.ok(hard > easy, 'dense/spaced chart rates higher (' + hard + ' > ' + easy + ')');
  assert.ok(easy >= 0.5 && hard <= 12, 'within [0.5,12]');
  assert.equal(E.estimateStars([], 5, 9), 0.5);           // empty → floor
  assert.equal(E.estimateStars(mk(50, 100, 200), 5, 9) * 10 % 1, 0);  // rounded to 1 decimal
});

test('assembleChart: attaches a star estimate + length', () => {
  const chart = E.assembleChart(META + '\n[HitObjects]\n' +
    '100,100,1000,1,0,0:0:0:0:\n300,100,1500,1,0,0:0:0:0:\n100,300,2000,1,0,0:0:0:0:');
  assert.ok(chart.stars >= 0.5 && chart.stars <= 12);
  assert.equal(chart.length, 1000);   // 2000 - 1000
});

test('parseTimingPoints + timingAt: BPM and SV resolve by time', () => {
  const tp = E.parseTimingPoints([
    '0,500,4,2,0,100,1,0',     // uninherited: beatLength 500 (120 BPM)
    '1000,-50,4,2,0,100,0,0',  // inherited: SV = 100/50 = 2.0
  ].join('\n'));
  assert.equal(E.timingAt(tp, 500).beatLength, 500);
  assert.equal(E.timingAt(tp, 500).sv, 1);
  assert.equal(E.timingAt(tp, 1500).sv, 2);     // after the inherited point
});

// =========================================================================
// Slider duration
// =========================================================================
test('sliderSpanDuration: length / (mult*100*sv) * beatLength', () => {
  // length 200, mult 1.0, sv 1, beatLength 500 -> 200/100 * 500 = 1000ms
  assert.equal(E.sliderSpanDuration(200, 1.0, 1, 500), 1000);
  // double SV halves the duration
  assert.equal(E.sliderSpanDuration(200, 1.0, 2, 500), 500);
});

// =========================================================================
// Curve sampling
// =========================================================================
test('samplePath: linear path starts at p0, ends at length along the line', () => {
  const path = E.samplePath('L', [{ x: 0, y: 0 }, { x: 100, y: 0 }], 100, 5);
  assert.ok(path.length > 2);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  const end = path[path.length - 1];
  assert.ok(Math.abs(end.x - 100) < 1e-6 && Math.abs(end.y) < 1e-6);
});

test('samplePath: linear cuts to `length` shorter than the control span', () => {
  const path = E.samplePath('L', [{ x: 0, y: 0 }, { x: 100, y: 0 }], 40, 5);
  const end = path[path.length - 1];
  assert.ok(Math.abs(end.x - 40) < 1e-6, 'ends at 40px, got ' + end.x);
});

test('samplePath: bezier endpoints honour the control points + length', () => {
  const ctrl = [{ x: 0, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 0 }];
  // full curve length of this quadratic is > 140; ask for 50px
  const path = E.samplePath('B', ctrl, 50, 5);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  // total sampled arc length ~= 50
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  assert.ok(Math.abs(len - 50) < 2, 'arc length ~50, got ' + len.toFixed(2));
});

test('samplePath: perfect circle arc passes near its middle control point', () => {
  // quarter circle: start (0,-50), mid (~35.4,-35.4), end (50,0) around origin r=50
  const a = { x: 0, y: -50 }, b = { x: 35.355, y: -35.355 }, c = { x: 50, y: 0 };
  const arcLen = Math.PI / 2 * 50;   // quarter of 2*pi*r
  const path = E.samplePath('P', [a, b, c], arcLen, 5);
  // every sampled point should be ~50px from the origin (on the circle)
  for (const pt of path) {
    const r = Math.hypot(pt.x, pt.y);
    assert.ok(Math.abs(r - 50) < 1.5, 'point off-circle: r=' + r.toFixed(2));
  }
});

test('samplePath: collinear perfect-circle falls back to a straight line', () => {
  const path = E.samplePath('P', [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], 100, 5);
  for (const pt of path) assert.ok(Math.abs(pt.y) < 1e-6, 'should stay on y=0');
});

// =========================================================================
// assembleChart
// =========================================================================
const FULL = [
  'osu file format v14',
  '[General]', 'AudioFilename: a.mp3', 'Mode: 0',
  '[Metadata]', 'Title:T', 'Artist:A', 'Version:V',
  '[Difficulty]', 'CircleSize:4', 'OverallDifficulty:8', 'ApproachRate:9',
  'SliderMultiplier:1.0', 'SliderTickRate:1',
  '[Events]', '0,0,"bg.jpg",0,0',
  '[TimingPoints]', '0,500,4,2,0,100,1,0',
  '[HitObjects]',
  '256,192,1000,1,0,0:0:0:0:',
  '100,100,2000,2,0,L|300:100,1,200',     // length 200, sv1, beatLength500 -> 1000ms span
].join('\n');

test('assembleChart: computes slider path, span and endTime; rejects non-std', () => {
  const c = E.assembleChart(FULL);
  assert.equal(c.cs, 4); assert.equal(c.ar, 9);
  assert.equal(c.backgroundFile, 'bg.jpg');
  assert.equal(c.objects.length, 2);
  const slider = c.objects[1];
  assert.equal(slider.kind, 'slider');
  assert.ok(slider.path.length > 2);
  assert.equal(slider.spanDuration, 1000);                 // 200/(1*100*1)*500
  assert.equal(slider.endTime, 3000);                      // 2000 + 1000*1
  assert.throws(() => E.assembleChart(FULL.replace('Mode: 0', 'Mode: 3')), /standard/i);
});
