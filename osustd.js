'use strict';

/*
 * osustd.js — osu!standard (cursor-aim) mode for aobing.
 *
 * Two halves (same shape as vsrg.js / typing.js):
 *   1. A PURE engine (no DOM, no audio): Mode-0 .osu parser, difficulty geometry
 *      (CS/AR/OD), slider velocity/duration, and curve sampling (linear, perfect
 *      circle, bezier, catmull) with arc-length resampling. Unit-tested in
 *      osustd.test.js.
 *   2. Browser wiring (playfield render, cursor/keys, audio) added in a later
 *      phase, guarded by `typeof document`.
 *
 * The engine is exported via module.exports for Node tests and attached to
 * window.OsuStdEngine in the browser. The whole file is IIFE-wrapped so its
 * top-level names don't collide with the other classic scripts on the page.
 */

(function () {
const R = typeof module !== 'undefined' && module.exports ? require('./rhythm-core.js') : window.RhythmCore;
const S = typeof module !== 'undefined' && module.exports ? require('./rhythm-standard.js') : window.RhythmStandard;

// =========================================================================
// .osu parsing (shared INI-ish helpers)
// =========================================================================
function splitSections(text) {
  const sections = {};
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { current = header[1]; sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  return sections;
}
function keyValues(lines) {
  const obj = {};
  for (const line of lines || []) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return obj;
}
function parseBackground(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.charAt(0) === '/') continue;
    const p = t.split(',');
    if ((p[0] === '0' || p[0] === 'Background') && p[2]) return p[2].trim().replace(/^"|"$/g, '');
  }
  return '';
}

// Metadata + difficulty. AR defaults to OD when absent (osu legacy behaviour).
function parseStdMeta(text) {
  const s = splitSections(text);
  const g = keyValues(s.General), m = keyValues(s.Metadata), d = keyValues(s.Difficulty);
  const od = Number.isFinite(parseFloat(d.OverallDifficulty)) ? R.clamp(parseFloat(d.OverallDifficulty),0,10) : 5;
  const arRaw = d.ApproachRate;
  return {
    audioFile: g.AudioFilename || '',
    mode: parseInt(g.Mode || '0', 10),
    version: Number((String(text).match(/osu file format v(\d+)/) || [0,14])[1]),
    stackLeniency: g.StackLeniency == null ? 0.7 : Math.max(0, Math.min(1, Number(g.StackLeniency))),
    sampleSet: ({Normal:1,Soft:2,Drum:3})[g.SampleSet] || 1,
    title: m.Title || '', artist: m.Artist || '', diffName: m.Version || '',
    cs: Number.isFinite(parseFloat(d.CircleSize)) ? R.clamp(parseFloat(d.CircleSize),0,10) : 5,
    od: od,
    ar: Number.isFinite(parseFloat(arRaw)) ? R.clamp(parseFloat(arRaw),0,10) : od,
    sliderMultiplier: parseFloat(d.SliderMultiplier) || 1.4,
    sliderTickRate: parseFloat(d.SliderTickRate) || 1,
  };
}

// Parse a skin.ini's [Colours] section into combo colours ['rgb(r,g,b)', ...]
// in Combo1..Combo8 order (osu cycles these per combo).
function parseSkinColors(iniText) {
  const s = splitSections(iniText);
  const c = keyValues(s.Colours || s.Colors || []);
  const out = [];
  for (let i = 1; i <= 8; i++) {
    const v = c['Combo' + i]; if (v == null) continue;
    const p = v.split(',').map((n) => parseInt(n, 10));
    if (p.length >= 3 && p.slice(0, 3).every((n) => !isNaN(n))) out.push('rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')');
  }
  return out;
}

// Timing points -> [{ time, beatLength, uninherited, sv }]. Inherited points
// carry SV = 100 / -beatLength; uninherited carry the BPM beatLength.
function parseTimingPoints(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split(',');
    if (p.length < 2) continue;
    const time = parseFloat(p[0]);
    const beatLength = parseFloat(p[1]);
    const uninherited = p.length >= 7 ? p[6].trim() === '1' : beatLength > 0;
    out.push({
      time: time, beatLength: beatLength, uninherited: uninherited,
      sv: uninherited ? 1 : (beatLength < 0 ? 100 / -beatLength : 1),
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Effective { beatLength (from last uninherited), sv (from last inherited) } at a time.
function timingAt(points, time) {
  let beatLength = 500, sv = 1;
  for (const p of points) {
    if (p.time > time) break;
    if (p.uninherited) { beatLength = p.beatLength; sv = 1; }   // a new BPM section resets SV to 1
    else { sv = p.sv; }
  }
  return { beatLength: beatLength, sv: sv };
}

// Parse [HitObjects] into typed raw objects (slider paths computed separately).
function parseHitObjects(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split(',');
    if (p.length < 4) continue;
    const x = parseFloat(p[0]), y = parseFloat(p[1]), time = parseInt(p[2], 10), type = parseInt(p[3], 10);
    const newCombo = !!(type & 4);   // bit 2 = start of a new combo (number resets, colour cycles)
    const hitSound = parseInt(p[4], 10) || 0;   // additions bitmask: 1 normal, 2 whistle, 4 finish, 8 clap
    if (type & 1) {
      out.push({ kind: 'circle', x: x, y: y, time: time, newCombo: newCombo, hitSound: hitSound, sample: R.sample(p[5]) });
    } else if (type & 2) {
      const seg = String(p[5] || '').split('|');
      const curveType = seg[0] || 'L';
      const points = [{ x: x, y: y }];
      for (let i = 1; i < seg.length; i++) {
        const xy = seg[i].split(':');
        points.push({ x: parseFloat(xy[0]), y: parseFloat(xy[1]) });
      }
      // edgeSounds (p[8]) = additions per edge (head, repeats…, tail); fall back to the base hitSound.
      const edgeSounds = String(p[8] || '').split('|').filter((s) => s !== '').map((s) => parseInt(s, 10) || 0);
      out.push({
        kind: 'slider', x: x, y: y, time: time, newCombo: newCombo, hitSound: hitSound,
        curveType: curveType, points: points, edgeSounds: edgeSounds,
        edgeSets: String(p[9] || '').split('|').map(e => e.split(':').map(Number)), sample: R.sample(p[10]),
        slides: parseInt(p[6], 10) || 1, length: parseFloat(p[7]) || 0,
      });
    } else if (type & 8) {
      out.push({ kind: 'spinner', time: time, endTime: parseInt(p[5], 10), newCombo: newCombo, hitSound: hitSound, sample: R.sample(p[6]) });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// =========================================================================
// Difficulty geometry
// =========================================================================
function csRadius(cs) { return 54.4 - 4.48 * cs; }                 // osu!px
function arPreempt(ar) {
  if (ar < 5) return 1200 + 600 * (5 - ar) / 5;
  if (ar > 5) return 1200 - 750 * (ar - 5) / 5;
  return 1200;
}
function arFadeIn(ar) {
  if (ar < 5) return 800 + 400 * (5 - ar) / 5;
  if (ar > 5) return 800 - 500 * (ar - 5) / 5;
  return 800;
}
// OD -> hit windows (± ms) for 300/100/50.
function odWindows(od) {
  return { h300: 80 - 6 * od, h100: 140 - 8 * od, h50: 200 - 10 * od };
}

// Duration (ms) of ONE span of a slider of `length` osu!px.
function sliderSpanDuration(length, sliderMultiplier, sv, beatLength) {
  const pxPerBeat = sliderMultiplier * 100 * sv;
  if (pxPerBeat <= 0) return 0;
  return (length / pxPerBeat) * beatLength;
}

// =========================================================================
// Curve sampling -> dense polyline, then arc-length resample to `length` px.
// =========================================================================
function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

function bezierAt(ctrl, t) {
  const pts = ctrl.map((p) => ({ x: p.x, y: p.y }));
  for (let r = 1; r < ctrl.length; r++)
    for (let i = 0; i < ctrl.length - r; i++)
      pts[i] = lerp(pts[i], pts[i + 1], t);
  return pts[0];
}
// Split bezier control points into sub-segments at repeated points (osu convention).
function bezierSegments(points) {
  const segs = [];
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].x === points[i - 1].x && points[i].y === points[i - 1].y) {
      segs.push(points.slice(start, i)); start = i;
    }
  }
  segs.push(points.slice(start));
  return segs.filter((s) => s.length > 1);
}
function denseBezier(points) {
  const dense = [];
  for (const seg of bezierSegments(points)) {
    const steps = Math.max(20, Math.ceil(segLength(seg) / 4));
    for (let i = 0; i <= steps; i++) dense.push(bezierAt(seg, i / steps));
  }
  return dense;
}
function segLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

function denseLinear(points) { return points.slice(); }

function denseCatmull(points) {
  const p = points;
  const dense = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
    const steps = Math.max(20, Math.ceil(dist(p1, p2) / 4));
    for (let j = 0; j <= steps; j++) {
      const t = j / steps, t2 = t * t, t3 = t2 * t;
      dense.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return dense;
}

function densePerfect(points) {
  if (points.length !== 3) return denseLinear(points);
  const [a, b, c] = points;
  // circumcentre
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return denseLinear(points);            // collinear -> straight
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const centre = { x: cx, y: cy }, r = dist(centre, a);
  let a0 = Math.atan2(a.y - cy, a.x - cx);
  const a1 = Math.atan2(b.y - cy, b.x - cx);
  let a2e = Math.atan2(c.y - cy, c.x - cx);
  // choose sweep direction that passes through b
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const dense = [];
  if (cross < 0) { if (a2e > a0) a2e -= 2 * Math.PI; }            // clockwise
  else { if (a2e < a0) a2e += 2 * Math.PI; }                      // counter-clockwise
  const steps = Math.max(24, Math.ceil(Math.abs(a2e - a0) * r / 4));
  for (let i = 0; i <= steps; i++) {
    const ang = a0 + (a2e - a0) * (i / steps);
    dense.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
  }
  return dense;
}

function densePath(curveType, points) {
  switch (curveType) {
    case 'L': return denseLinear(points);
    case 'P': return densePerfect(points);
    case 'C': return denseCatmull(points);
    case 'B': default: return denseBezier(points);
  }
}

// Resample a dense polyline to evenly-spaced points along arc length, cut to
// `length` osu!px (sliders have an authoritative pixel length). spacing px apart.
function arcResample(dense, length, spacing) {
  const out = [];
  if (!dense.length) return out;
  out.push({ x: dense[0].x, y: dense[0].y });
  let acc = 0, target = spacing, total = 0;
  for (let i = 1; i < dense.length && total < length; i++) {
    let segLen = dist(dense[i - 1], dense[i]);
    if (segLen === 0) continue;
    while (acc + segLen >= target && target <= length) {
      const t = (target - acc) / segLen;
      out.push(lerp(dense[i - 1], dense[i], t));
      target += spacing;
    }
    acc += segLen; total = acc;
  }
  // ensure the exact endpoint at `length`
  const endpt = pointAtLength(dense, length);
  if (endpt) out.push(endpt);
  return out;
}
function pointAtLength(dense, length) {
  let acc = 0;
  for (let i = 1; i < dense.length; i++) {
    const segLen = dist(dense[i - 1], dense[i]);
    if (acc + segLen >= length) return lerp(dense[i - 1], dense[i], (length - acc) / segLen);
    acc += segLen;
  }
  return dense.length ? dense[dense.length - 1] : null;
}

// Public: sampled slider path (array of {x,y}) following `curveType` up to `length`.
function samplePath(curveType, points, length, spacing) {
  const dense = densePath(curveType, points);
  const actual = segLength(dense);
  if (length > actual && dense.length > 1) {
    let i = dense.length - 2, b = dense[dense.length - 1];
    while (i > 0 && dist(dense[i], b) < 1e-7) i--;
    const a = dense[i], d = dist(a,b);
    if (d > 0) dense.push({x:b.x+(b.x-a.x)*(length-actual)/d,y:b.y+(b.y-a.y)*(length-actual)/d});
  }
  return arcResample(dense, length, spacing || 5);
}

// Rough osu!standard star estimate (osu doesn't store a star rating in the .osu).
// Density-driven (objects/sec) plus aim (mean spacing between consecutive objects),
// nudged by CS (smaller circles = harder) and AR (less read time = harder). Shown
// with a leading '~' — an approximation for labels/sorting, not osu's real algorithm.
function estimateStars(objects, cs, ar) {
  const objs = objects || [];
  if (objs.length < 2) return 0.5;
  let first = Infinity, last = -Infinity;
  for (const o of objs) { if (o.time < first) first = o.time; const e = (o.endTime != null) ? o.endTime : o.time; if (e > last) last = e; }
  const durSec = Math.max(1, (last - first) / 1000);
  const density = objs.length / durSec;                       // objects per second
  let spacingSum = 0, spacingN = 0, prev = null;
  for (const o of objs) {
    if (o.kind === 'spinner' || o.x == null) { prev = null; continue; }
    if (prev) { const dx = o.x - prev.x, dy = o.y - prev.y; spacingSum += Math.sqrt(dx * dx + dy * dy); spacingN++; }
    prev = o;
  }
  const meanSpacing = spacingN ? spacingSum / spacingN : 0;    // 0..~510 osu!px
  const csv = (cs >= 0 && cs <= 10) ? cs : 5;
  const arv = (ar >= 0 && ar <= 11) ? ar : 8;
  const csFactor = 1 + (csv - 4) * 0.04;
  const arFactor = 1 + (arv - 8) * 0.035;
  const stars = (density * 0.40 + meanSpacing / 190) * csFactor * arFactor + 0.4;
  return Math.max(0.5, Math.min(12, Math.round(stars * 10) / 10));
}

// =========================================================================
// Assemble a full, playable Mode-0 chart
// =========================================================================
function assembleChart(text) {
  const meta = parseStdMeta(text);
  if (meta.mode !== 0) throw new Error('Unsupported chart: only osu!standard (Mode 0) is supported');
  const s = splitSections(text);
  const timing = parseTimingPoints((s.TimingPoints || []).join('\n'));
  const raw = parseHitObjects((s.HitObjects || []).join('\n'));
  if (raw.length === 0) throw new Error('Unsupported chart: no hit objects');
  let objects = raw.map((o) => {
    if (o.kind !== 'slider') return o;
    const tm = timingAt(timing, o.time);
    const span = sliderSpanDuration(o.length, meta.sliderMultiplier, tm.sv, tm.beatLength);
    const path = samplePath(o.curveType, o.points, o.length, 5);
    return Object.assign({}, o, {
      path: path,
      spanDuration: span,
      duration: span * o.slides,
      endTime: o.time + span * o.slides,
    });
  });
  objects = S.stack(objects, arPreempt(meta.ar), meta.stackLeniency, csRadius(meta.cs), meta.version);
  const firstT = objects[0].time;
  const lastT = objects.reduce((m, o) => Math.max(m, (o.endTime != null ? o.endTime : o.time)), 0);
  return {
    audioFile: meta.audioFile, title: meta.title, artist: meta.artist, diffName: meta.diffName,
    cs: meta.cs, od: meta.od, ar: meta.ar,
    sliderMultiplier: meta.sliderMultiplier, sliderTickRate: meta.sliderTickRate,
    backgroundFile: parseBackground((s.Events || []).join('\n')),
    timingPoints: timing,
    sampleSet: meta.sampleSet, samplePoints: R.timingPoints(s.TimingPoints || []),
    objects: objects,
    stars: estimateStars(objects, meta.cs, meta.ar),
    length: Math.max(0, lastT - firstT),   // playable span (ms) for sorting/labels
  };
}

// Collapse library entries that point at the same song-difficulty so a map already
// present (bundled, cached, or imported this session) never shows up twice when the
// user imports again. Identity = title + artist + difficulty; first occurrence wins,
// so the bundled/persisted copy is kept over a duplicate re-import.
function dedupeLibrary(entries) {
  const seen = new Set(), out = [];
  for (const e of (entries || [])) {
    const key = String(e.title) + ' ' + String(e.artist) + ' ' + String(e.diffName);
    if (seen.has(key)) continue;
    seen.add(key); out.push(e);
  }
  return out;
}

// =========================================================================
// Exports
// =========================================================================
const ENGINE = {
  OSUSTD_ENGINE: true,
  gameplay: S,
  splitSections: splitSections,
  estimateStars: estimateStars,
  parseStdMeta: parseStdMeta,
  parseSkinColors: parseSkinColors,
  parseTimingPoints: parseTimingPoints,
  timingAt: timingAt,
  parseHitObjects: parseHitObjects,
  csRadius: csRadius,
  arPreempt: arPreempt,
  arFadeIn: arFadeIn,
  odWindows: odWindows,
  sliderSpanDuration: sliderSpanDuration,
  samplePath: samplePath,
  assembleChart: assembleChart,
  dedupeLibrary: dedupeLibrary,
};

if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
if (typeof window !== 'undefined') window.OsuStdEngine = ENGINE;

// =========================================================================
// Browser wiring — window.OsuStdGame.init(deps). Playfield + cursor + circles.
// Browser adapter for the shared clock and pure Standard gameplay helpers.
// =========================================================================
if (typeof document !== 'undefined') {
  const api = { init: initBrowser };
  const COMBO_COLORS = ['#67dfff', '#f5bd67', '#7cafff', '#9ce7d6', '#cab6ff'];
  const LEAD_IN_MS = 1500, END_PAD_MS = 2500;
  const PLAY_W = 512, PLAY_H = 384;

  function initBrowser(deps) {
    const settings = deps.settings || {};
    const panel = document.getElementById('osu-panel');
    if (!panel) return;
    const screens = {
      select:  document.getElementById('osu-select'),
      game:    document.getElementById('osu-game'),
      results: document.getElementById('osu-results'),
      calib:   document.getElementById('osu-calib'),
      hitsound: document.getElementById('osu-hitsound'),
      visual:  document.getElementById('osu-visual'),
    };
    const songlistEl = document.getElementById('osu-songlist');
    const keybindsEl = document.getElementById('osu-keybinds');
    const hitsoundBtn = document.getElementById('osu-hitsound-btn');
    const hitsoundDoneBtn = document.getElementById('osu-hitsound-done');
    const hsControlsEl = document.getElementById('osu-hs-controls');
    const autoBtn = document.getElementById('osu-auto');
    const visualBtn = document.getElementById('osu-visual-btn');
    const visualDoneBtn = document.getElementById('osu-visual-done');
    const cursorSizeEl = document.getElementById('osu-cursor-size');
    const cursorSizeVal = document.getElementById('osu-cursor-size-val');
    const bgDimEl = document.getElementById('osu-bg-dim');
    const bgDimVal = document.getElementById('osu-bg-dim-val');
    const calibrateBtn = document.getElementById('osu-calibrate');
    const calibCanvas = document.getElementById('osu-calib-canvas');
    const calibSlider = document.getElementById('osu-calib-slider');
    const calibValEl = document.getElementById('osu-calib-val');
    const calibDoneBtn = document.getElementById('osu-calib-done');
    const tapBtn = document.getElementById('osu-tap');
    const tapResultEl = document.getElementById('osu-tap-result');
    const exitBtn = document.getElementById('osu-exit');
    const canvas = document.getElementById('osu-canvas');
    const g = canvas.getContext('2d');
    const comboEl = document.getElementById('osu-combo');
    const accEl = document.getElementById('osu-acc');
    const judgeEl = document.getElementById('osu-judge');
    const fpsEl = document.getElementById('osu-fps');
    const skipBtn = document.getElementById('osu-skip');
    const keysOverlayEl = document.getElementById('osu-keys-overlay');
    const resultsBody = document.getElementById('osu-results-body');
    const retryBtn = document.getElementById('osu-retry');
    const backBtn = document.getElementById('osu-back');

    let audioCtx = null, panelOpen = false, library = [], run = null, loading = false, loadGen = 0;
    let fpsFrames = 0, fpsLast = 0, fpsPrev = 0, fpsMaxDt = 0;   // FPS + frametime accumulators (rhythm runs as fast as rAF allows)
    let currentGroups = [], expandedKey = null;       // song-select accordion (one open group at a time)
    let autoplay = false;                             // Auto preview mod: the map plays itself, no score saved
    let cursor = { x: PLAY_W / 2, y: PLAY_H / 2 };   // in osu!px
    let trail = [];                                   // recent cursor positions (osu!px) for a trail
    let bursts = [];                                  // hit feedback at the circle: { x, y, result, t }
    let errTicks = [];                                // recent signed hit errors for the live error bar
    let chartSources = new Map(), libraryVersion = 0;
    let localEntries = [];                            // maps imported this session (folder; not persisted)
    let availableSkins = [];                          // skin folders found in the last import/sync (selectable)
    let skin = null;                                  // active custom osu! skin (null = built-in look)
    const tintCache = new Map();                      // memoised combo-colour-tinted sprites
    const thumbUrls = new Map();                      // entry.id -> object URL for its song-list thumbnail
    let thumbObserver = null;                         // lazy-loads thumbnails as rows scroll into view

    const pauseUI = window.RhythmUI.pausePanel(panel, resumeRun, () => { if (run) loadAndPlay(run.entry); }, quitToSelect);
    function pauseRun(present = true) {
      if (!run || run.finished) return;
      if (run.multiplayer) reportMultiplayer('forfeit');
      if (run.paused) { if (present) pauseUI.cancelCountdown(); else pauseUI.hide(); return; }
      run.pauseRaw = run.clock.pause();
      updateSliders(run.pauseRaw - calOffset()); sweepMisses(run.pauseRaw - calOffset());
      run.paused = true; run.pressed = {};
      run.history.push(run.pauseRaw - calOffset(), {...cursor,held:false});
      cancelAnimationFrame(run.rafId);
      try { run.src.stop(); } catch (_) {}
      disarmQuickRestart(); Object.keys(keyBoxes).forEach(k => pressKey(k,false));
      if (present) pauseUI.show();
    }
    async function resumeRun() {
      if (!run || !run.paused) return;
      const active = run;
      await ensureCtx();
      if (run !== active || active.finished) return;
      const ac = audioCtx, offset = Math.max(0, run.pauseRaw / 1000);
      const when = ac.currentTime + 0.05 + Math.max(0, -run.pauseRaw / 1000);
      const src = ac.createBufferSource(); src.buffer = run.audioBuf; src.connect(run.gain);
      if (offset < run.audioBuf.duration) src.start(when, offset);
      run.src = src; run.startCtx = when - offset; run.clock.reset(run.startCtx);
      run.paused = false;
      run.history.push(run.pauseRaw - calOffset(), {...cursor,held:heldAny()});
      grabFocus(); run.rafId = requestAnimationFrame(loop);
    }
    window.addEventListener('blur', () => { if (run && !run.finished) pauseRun(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && run && !run.finished) pauseRun(); });
    function syncModalPause() {
      if (!run || run.finished) return;
      const covered = document.body.classList.contains('ui-window-open') || document.querySelector('dialog[open]:not(.rhythm-pause)');
      if (covered) pauseRun(false);
      else if (run.paused) pauseUI.show();
    }
    new MutationObserver(syncModalPause).observe(document.body, {subtree:true,attributes:true,attributeFilter:['open']});
    new MutationObserver(syncModalPause).observe(document.body, {attributes:true,attributeFilter:['class']});

    window.RhythmUI.controls(document.querySelector('#osu-visual .hs-controls'),settings,deps.saveSettings,[

      {key:'osuVisualOffset',label:'rhythm.visual_offset',min:-200,max:200,value:0,format:v=>v+' ms'}
    ]);

    const selector = window.RhythmSelect?.create({mode:'osu', settings, save:deps.saveSettings, ensureCtx, pauseBgm:deps.pauseBgm, resumeBgm:deps.resumeBgm, play:loadAndPlay});
    const stageHud = window.RhythmSelect?.hud('osu', pauseRun);

    function calOffset() { return Number(settings.osuCalibrationOffset) || 0; }   // osu!standard's own offset
    function cursorScale() { const s = Number(settings.osuCursorScale); return (s >= 0.5 && s <= 2) ? s : 1; }
    function bgBrightness() { const d = Number(settings.osuBgDim); return (1 - (isNaN(d) ? 80 : d) / 100); }   // 0 = black, 1 = full art
    // Unstable rate = stdev of signed hit errors × 10 (osu definition); the error
    // bar + UR readout mirror osu!mania's. recordError feeds both.
    function unstableRate(errs) {
      if (!errs || errs.length < 2) return 0;
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      const v = errs.reduce((s, e) => s + (e - mean) * (e - mean), 0) / errs.length;
      return Math.sqrt(v) * 10;
    }
    function recordError(errMs, result) {
      if (run) {
        run.errors.push(errMs);
        const n=run.errors.length, delta=errMs-(run.errorMean || 0);
        run.errorMean=(run.errorMean || 0)+delta/n;
        run.errorM2=(run.errorM2 || 0)+delta*(errMs-run.errorMean);
      }
      errTicks.push({ err: errMs, result: result, t: performance.now() });
      if (errTicks.length > 64) errTicks.shift();
    }
    function playHitsound(scale) { if (window.Hitsound && audioCtx) window.Hitsound.play(audioCtx, scale); }   // shared engine (hitsound.js)
    // Sound for a hit object: the map's per-note additions (whistle/finish/clap) when
    // 'Use map hitsounds' is on, otherwise the player's chosen preset/custom sound.
    function playObjectSound(obj, scale, edge = 0, time = obj.time) {
      if (window.Hitsound && audioCtx && run) window.Hitsound.playNote(audioCtx,run.samples,R.soundSpec(run.chart,obj,time,edge),scale);
    }
    // Combo colours come from the loaded skin's skin.ini [Colours] when present,
    // otherwise the built-in palette (matches osu's per-combo colour cycling).
    function comboColors() { return (skin && skin.colors && skin.colors.length) ? skin.colors : COMBO_COLORS; }
    function show(name) {
      selector?.screen(name);
      if (window.UIMotion) window.UIMotion.showScreen(panel, screens, name);
      else for (const k in screens) if (screens[k]) screens[k].hidden = (k !== name);
      panel.querySelectorAll('[data-rhythm-setting]').forEach(el => el.rhythmRefresh());
    }
    function grabFocus() { try { window.focus(); } catch (e) {} try { canvas.focus({ preventScroll: true }); } catch (e) {} }

    function ensureCtx() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({latencyHint:'interactive'});
      if (audioCtx.state !== 'running') return audioCtx.resume().then(() => audioCtx);
      return Promise.resolve(audioCtx);
    }
    // Audio output latency (seconds): how long after currentTime the sound is
    // actually HEARD. Varies a lot by device (Bluetooth, HDMI, onboard buffers),
    // which is why uncompensated timing "feels weird" on some machines but not
    // others. outputLatency is the full path; baseLatency is just the context buffer.
    function audioLatency() {
      if (!audioCtx) return 0;
      const l = (typeof audioCtx.outputLatency === 'number' && audioCtx.outputLatency) || audioCtx.baseLatency || 0;
      return Math.min(l || 0, 0.4);   // clamp pathological values (e.g. very high BT reports)
    }

    // ---- Playfield transform (osu 512x384 letterboxed into the canvas) -------
    function sizeCanvas() {
      // Size the backing store from the canvas's OWN rendered size (it fills the
      // game screen via CSS). Cap the resolution: high-DPR / 4K screens otherwise
      // fill 2–4× the pixels every frame, which is what makes weaker GPUs lag. The
      // cursor/transform math uses canvas.width/rect.width, so a capped backing
      // store stays pixel-accurate — just slightly softer.
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const MAX_W = 2200;                                  // cap longest backing dimension
      const scale = Math.min(dpr, 1.5, MAX_W / Math.max(rect.width, rect.height, 1));
      canvas.width = Math.max(1, Math.round(rect.width * Math.max(0.75, scale)));
      canvas.height = Math.max(1, Math.round(rect.height * Math.max(0.75, scale)));
    }
    function transform() {
      const W = canvas.width, H = canvas.height;
      const scale = Math.min(W / PLAY_W, H / PLAY_H) * 0.82;
      return { scale: scale, ox: (W - PLAY_W * scale) / 2, oy: (H - PLAY_H * scale) / 2 };
    }
    function osuToScreen(x, y, tf) { return { x: tf.ox + x * tf.scale, y: tf.oy + y * tf.scale }; }
    // Map a mouse event to osu!px using the canvas's actual backing/CSS ratio
    // (robust to any devicePixelRatio / layout mismatch).
    function updateCursorFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      const tf = transform();
      cursor = {
        x: ((e.clientX - rect.left) * sx - tf.ox) / tf.scale,
        y: ((e.clientY - rect.top) * sy - tf.oy) / tf.scale,
      };
      trail.push({ x: cursor.x, y: cursor.y, t: performance.now() });
      if (trail.length > 24) trail.shift();
    }

    // ---- Library / song select ----------------------------------------------
    async function loadBundled() {
      const entries = [];
      try {
        const manifest = await fetch('assets/osustd/bundled.json').then((r) => r.json());
        for (const m of manifest) {
          const base = m.dir.replace(/\/$/, '');
          const osuText = await fetch(base + '/' + m.osu).then((r) => r.text());
          let chart; try { chart = assembleChart(osuText); } catch (e) { continue; }
          entries.push({
            id: 'bundled:' + m.id, hash: await sha256(osuText), title: chart.title, artist: chart.artist, diffName: chart.diffName,
            stars: chart.stars, length: chart.length,
            getOsuText: () => Promise.resolve(osuText),
            getAudio: () => fetch(base + '/' + m.audio).then((r) => r.arrayBuffer()),
            getArt: () => m.bg ? fetch(base + '/' + m.bg).then((r) => r.blob()).catch(() => null) : Promise.resolve(null),
          });
        }
      } catch (e) { /* no bundled maps */ }
      return entries;
    }
    function escapeH(s) { return deps.escapeHtml ? deps.escapeHtml(String(s)) : String(s); }
    // Group the flat library by song (artist+title) so each song is one collapsible
    // row; difficulties live under it and only one song is expanded at a time.
    function buildGroups() {
      const map = new Map();
      library.forEach((e, i) => {
        const key = (e.artist || '') + ' ' + (e.title || '');
        let grp = map.get(key);
        if (!grp) { grp = { key: key, title: e.title || '(untitled)', artist: e.artist || '', items: [] }; map.set(key, grp); }
        grp.items.push({ entry: e, i: i });
      });
      const groups = Array.from(map.values());
      groups.forEach((g) => g.items.sort((a, b) => (a.entry.stars || 0) - (b.entry.stars || 0)));   // easy→hard within a song
      const gMax = (g, f) => g.items.reduce((m, it) => Math.max(m, f(it.entry) || 0), 0);
      const cmp = {
        title:  (a, b) => (a.title || '').localeCompare(b.title || '') || (a.artist || '').localeCompare(b.artist || ''),
        artist: (a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.title || '').localeCompare(b.title || ''),
        stars:  (a, b) => gMax(b, (e) => e.stars) - gMax(a, (e) => e.stars),
        length: (a, b) => gMax(b, (e) => e.length) - gMax(a, (e) => e.length),
      }[settings.osuSortBy || 'title'] || (() => 0);
      groups.sort(cmp);
      return groups;
    }
    function starStr(s) { return '~' + (Number(s) || 0).toFixed(1) + '★'; }
    function renderSongList() {
      if (selector) { selector.setEntries(library); return; }
      if (!songlistEl) return;
      if (!library.length) { songlistEl.innerHTML = '<div class="osu-empty">No songs yet.</div>'; return; }
      currentGroups = buildGroups();
      if (expandedKey && !currentGroups.some((g) => g.key === expandedKey)) expandedKey = null;
      songlistEl.innerHTML = currentGroups.map((g, gi) => {
        const single = g.items.length === 1;
        const open = !single && g.key === expandedKey;
        const caret = single ? '▸' : (open ? '▾' : '▸');
        const sMin = Math.min.apply(null, g.items.map((it) => it.entry.stars || 0));
        const sMax = Math.max.apply(null, g.items.map((it) => it.entry.stars || 0));
        const starLabel = (single || sMin === sMax) ? starStr(sMax) : ('~' + sMin.toFixed(1) + '–' + sMax.toFixed(1) + '★');
        const head =
          '<button class="osu-group' + (open ? ' open' : '') + '" data-g="' + gi + '">' +
            '<span class="osu-group-caret">' + caret + '</span>' +
            '<span class="osu-group-thumb" data-thumb-g="' + gi + '"></span>' +
            '<span class="osu-group-info"><span class="osu-song-title">' + escapeH(g.title) + '</span>' +
            '<span class="osu-song-meta">' + escapeH(g.artist || '(unknown)') + ' · ' +
              g.items.length + ' ' + (single ? 'difficulty' : 'difficulties') + '</span></span>' +
            '<span class="osu-group-star">' + starLabel + '</span>' +
          '</button>';
        const diffs = open
          ? '<div class="osu-group-diffs">' + g.items.map((it) =>
              '<button class="osu-song osu-diff" data-i="' + it.i + '">' + escapeH(it.entry.diffName || '(difficulty)') +
                '<span class="osu-diff-star">' + starStr(it.entry.stars) + '</span></button>'
            ).join('') + '</div>'
          : '';
        return '<div class="osu-group-wrap">' + head + diffs + '</div>';
      }).join('');
      loadThumbs();
    }
    // Lazy song-list thumbnails (each group's background art), loaded as rows scroll in.
    // URLs are cached per entry id for the session and revoked when the panel closes.
    function paintThumb(el) {
      const g = currentGroups[Number(el.getAttribute('data-thumb-g'))];
      const entry = g && g.items[0] && g.items[0].entry;
      if (!entry || !entry.getArt) return;
      const id = entry.id;
      if (thumbUrls.has(id)) { el.style.backgroundImage = 'url(' + thumbUrls.get(id) + ')'; el.classList.add('has-thumb'); return; }
      entry.getArt().then((b) => {
        if (!b) return;
        const url = URL.createObjectURL(b); thumbUrls.set(id, url);
        el.style.backgroundImage = 'url(' + url + ')'; el.classList.add('has-thumb');
      }).catch(() => {});
    }
    function loadThumbs() {
      if (!songlistEl) return;
      if (thumbObserver) thumbObserver.disconnect();
      const io = ('IntersectionObserver' in window)
        ? new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) { io.unobserve(e.target); paintThumb(e.target); } }, { root: songlistEl, rootMargin: '300px' })
        : null;
      thumbObserver = io;
      songlistEl.querySelectorAll('.osu-group-thumb').forEach((el) => { if (io) io.observe(el); else paintThumb(el); });
    }
    function revokeThumbs() {
      if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
      thumbUrls.forEach((u) => URL.revokeObjectURL(u)); thumbUrls.clear();
    }
    async function refreshLibrary() {
      const version = ++libraryVersion;
      const bundled = await loadBundled();
      let cached = [];
      try { cached = await loadCachedOsz(); } catch (e) {}
      const all = bundled.concat(cached).concat(localEntries);
      const pairs = await Promise.all(all.map(async entry => { entry.hash = entry.hash || (entry.getHash ? await entry.getHash() : await sha256(await entry.getOsuText())); return [entry.hash, entry]; }));
      if (version !== libraryVersion) return;
      chartSources = new Map(pairs);
      library = dedupeLibrary(all);
      renderSongList();
    }

    // ---- Folder access: File System Access API (persistent, 1-click re-sync) with
    // a <input webkitdirectory> fallback (Discord-Activity iframe / other browsers) --
    // Usable only with showDirectoryPicker AND a same-origin top-level context; reading
    // window.top throws in the cross-origin Activity iframe, which we treat as "no".
    function canFsAccess() {
      if (typeof window.showDirectoryPicker !== 'function') return false;
      try { return window.self === window.top; } catch (e) { return false; }
    }
    // Wrap a FileSystemFileHandle as a lazy File-like the scanners understand (they read
    // .webkitRelativePath / .name and call .text() / .arrayBuffer()); bytes load on demand.
    function handleFile(fh, rel) {
      return { name: fh.name, webkitRelativePath: rel,
        text: async () => (await fh.getFile()).text(),
        arrayBuffer: async () => (await fh.getFile()).arrayBuffer() };
    }
    async function walkDirHandle(dir, prefix, out) {
      out = out || [];
      for await (const [name, h] of dir.entries()) {
        const rel = prefix + name;
        if (h.kind === 'file') out.push(handleFile(h, rel));
        else if (h.kind === 'directory') await walkDirHandle(h, rel + '/', out);
      }
      return out;
    }
    async function ensurePermission(handle, prompt) {
      try {
        if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
        return prompt ? (await handle.requestPermission({ mode: 'read' })) === 'granted' : false;
      } catch (e) { return false; }
    }
    // getArt must resolve to a real Blob (consumers call URL.createObjectURL): normalise
    // a File (webkitdirectory) or a lazy handle-file (FS Access) into one.
    function artBlob(a) { return a ? Promise.resolve(a.arrayBuffer()).then((b) => new Blob([b])) : Promise.resolve(null); }

    // ---- Import (Mode-0 maps from a folder or .osz) --------------------------
    const importBtn = document.getElementById('osu-import');
    const importInput = document.getElementById('osu-import-input');
    const oszBtn = document.getElementById('osu-import-osz');
    const oszInput = document.getElementById('osu-osz-input');
    const importStatusEl = document.getElementById('osu-import-status');
    const skinBtn = document.getElementById('osu-import-skin');
    const skinClearBtn = document.getElementById('osu-skin-clear');
    const skinOskInput = document.getElementById('osu-skin-osk-input');
    const skinStatusEl = document.getElementById('osu-skin-status');
    function setImportStatus(m) { if (importStatusEl) importStatusEl.textContent = m; }
    function setSkinStatus(m) { if (skinStatusEl) skinStatusEl.textContent = m; }

    // Webkitdirectory fallback entry point (input change handler).
    function handleImportFiles(fileList) { return ingest(fileList, false); }
    // Shared import: scan a (root) folder's files for standard maps (mania → VSRG) and
    // skins. isSync=true reports how many maps are newly added vs the current session.
    async function ingest(fileList, isSync) {
      const list = Array.from(fileList || []);
      if (!list.length) return;
      try {
        const verb = isSync ? 'Syncing' : 'Scanning';
        setImportStatus(verb + '…');
        const res = await scanFileList(list, (n) => setImportStatus(verb + '… ' + n + ' .osu seen'));
        const prevIds = new Set(localEntries.map((e) => e.id));
        const added = res.entries.filter((e) => !prevIds.has(e.id)).length;
        localEntries = res.entries;
        const mania = await routeForeign(res.foreign);   // mania charts → the Mania library
        // Skins under the folder (e.g. an osu! install's Skins/): keep them all for the
        // picker; auto-apply the most complete only when no skin is active yet.
        availableSkins = findSkinDirs(list);
        if (!isSync && availableSkins.length && !skin) await loadSkinDir(availableSkins[0]);   // auto-apply best only on a fresh import
        renderSkinPicker();
        await refreshLibrary();
        const maniaNote = mania ? ' · ' + mania + ' mania → Mania' : '';
        const skinNote = availableSkins.length ? ' · ' + availableSkins.length + ' skin' + (availableSkins.length > 1 ? 's' : '') : '';
        setImportStatus(res.entries.length
          ? ((isSync ? (added + ' new · ' + res.entries.length + ' total standard map(s)') : ('Imported ' + res.entries.length + ' standard map(s)')) + maniaNote + skinNote)
          : ((mania ? mania + ' mania map(s) → Mania' : 'No osu! maps') + ' found' + skinNote + '.'));
      } catch (e) { setImportStatus('Import failed: ' + ((e && e.message) || e)); }
    }
    // "Import osu! folder": pick the install root. FS Access path remembers the handle
    // (for 1-click sync); otherwise the webkitdirectory input fires handleImportFiles.
    async function importOsuFolder() {
      if (canFsAccess()) {
        let handle;
        try { handle = await window.showDirectoryPicker({ id: 'osu-root', mode: 'read' }); }
        catch (e) { return; }   // user dismissed the picker
        try { await idbPut('fs', 'osuFolder', handle); } catch (e) {}
        await ingest(await walkDirHandle(handle, ''), false);
      } else if (importInput) {
        importInput.value = ''; importInput.click();
      } else { setImportStatus('Folder import unavailable in this browser.'); }
    }
    // "Sync new songs": re-walk the remembered folder (1 click) when possible, else re-pick.
    async function syncSongs() {
      let handle = null; try { handle = await idbGet('fs', 'osuFolder'); } catch (e) {}
      if (handle && canFsAccess() && await ensurePermission(handle, true)) {
        setImportStatus('Syncing…');
        await ingest(await walkDirHandle(handle, ''), true);
      } else {
        importOsuFolder();   // no remembered folder (or iframe/unsupported) → re-pick
      }
    }
    // On open: if a folder handle is remembered and still permitted (no prompt), re-walk
    // it so the imported library survives reloads (standalone Chrome/Edge only).
    async function restoreFolder() {
      if (!canFsAccess() || localEntries.length) return;   // once per session; skip if already imported
      let handle = null; try { handle = await idbGet('fs', 'osuFolder'); } catch (e) {}
      if (!handle || !(await ensurePermission(handle, false))) return;
      try { await ingest(await walkDirHandle(handle, ''), true); } catch (e) {}
    }
    // Find directories that look like a skin (skin sprites/ini, no .osu), best first.
    function findSkinDirs(fileList) {
      const byDir = new Map();
      for (const f of fileList) {
        const rel = f.webkitRelativePath || f.name;
        const slash = rel.lastIndexOf('/');
        const dir = slash >= 0 ? rel.slice(0, slash) : '';
        let m = byDir.get(dir); if (!m) { m = new Map(); byDir.set(dir, m); }
        m.set(f.name.toLowerCase(), f);
      }
      const dirs = [];
      for (const [dir, files] of byDir) {
        let hasOsu = false, skinCount = 0;
        for (const name of files.keys()) { if (name.endsWith('.osu')) hasOsu = true; if (skinFileWanted(name)) skinCount++; }
        if (hasOsu || !skinCount) continue;                 // beatmap dirs aren't skins
        dirs.push({ name: dir.split('/').pop() || 'skin', files: files, count: skinCount });
      }
      dirs.sort((a, b) => b.count - a.count);               // most complete first
      return dirs;
    }
    async function loadSkinDir(d) {
      const map = new Map();
      for (const [name, f] of d.files) if (skinFileWanted(name)) map.set(name, new Uint8Array(await f.arrayBuffer()));
      await importSkinMap(d.name, map);
    }
    // Build a portable record of a chart this mode can't play, so the OTHER mode
    // (mania) can store it — getU8(name) returns the file's bytes as a Uint8Array.
    async function buildForeign(osuText, getU8, sampleNames) {
      const meta = parseStdMeta(osuText);
      const audio = await getU8(String(meta.audioFile).toLowerCase());
      if (!audio) return null;
      const bg = parseBackground((splitSections(osuText).Events || []).join('\n'));
      const art = bg ? await getU8(bg.toLowerCase()) : null;
      return { osuText: osuText, audio: audio, art: art || null, samples: await R.collectSamples(sampleNames, getU8, meta.audioFile) };
    }
    // Hand collected non-standard charts to mania; returns how many it accepted.
    async function routeForeign(list) {
      if (!list.length || !window.VsrgGame || !window.VsrgGame.importForeignCharts) return 0;
      try { return (await window.VsrgGame.importForeignCharts(list)) || 0; } catch (e) { return 0; }
    }
    // Group webkitdirectory files by folder so each .osu resolves its audio/bg.
    async function scanFileList(fileList, onProgress) {
      const byDir = new Map();
      for (const f of fileList) {
        const rel = f.webkitRelativePath || f.name;
        const slash = rel.lastIndexOf('/');
        const dir = slash >= 0 ? rel.slice(0, slash) : '';
        let m = byDir.get(dir); if (!m) { m = new Map(); byDir.set(dir, m); }
        m.set(f.name.toLowerCase(), f);
      }
      const out = [], foreign = []; let scanned = 0;
      for (const files of byDir.values()) {
        const sampleNames = [...files.keys()];
        const getU8 = async (nm) => { const f = files.get(nm); return f ? new Uint8Array(await f.arrayBuffer()) : null; };
        for (const [name, f] of files) {
          if (!name.endsWith('.osu')) continue;
          scanned++; if (onProgress && scanned % 40 === 0) onProgress(scanned);
          let osuText; try { osuText = await f.text(); } catch (e) { continue; }
          let chart;
          try { chart = assembleChart(osuText); }
          catch (e) {   // not osu!standard — collect for mania routing instead of dropping it
            try { const rec = await buildForeign(osuText, getU8, sampleNames); if (rec) foreign.push(rec); } catch (_) {}
            continue;
          }
          const audio = files.get(String(chart.audioFile).toLowerCase()); if (!audio) continue;
          const art = chart.backgroundFile ? (files.get(chart.backgroundFile.toLowerCase()) || null) : null;
          out.push(makeEntry('local', osuText, chart, () => f.text(), () => audio.arrayBuffer(), () => artBlob(art), () => R.collectSamples(sampleNames, getU8, chart.audioFile)));
        }
      }
      return { entries: out, scanned: scanned, foreign: foreign };
    }
    function makeEntry(source, osuText, chart, getOsuText, getAudio, getArt, getSamples) {
      return { id: source + ':' + chart.artist + ':' + chart.title + ':' + chart.diffName, source: source, hash: chart.hash, getHash: () => chart.hash ? Promise.resolve(chart.hash) : sha256(osuText),
        title: chart.title, artist: chart.artist, diffName: chart.diffName,
        stars: chart.stars, length: chart.length,   // chart = assembled chart, or a stored osz record carrying these
        getOsuText: getOsuText, getAudio: getAudio, getArt: getArt, getSamples: getSamples };
    }

    async function handleOszFiles(fileList) {
      if (!fileList || !fileList.length) return;
      let imported = 0, scanned = 0; const foreign = [];
      try {
        for (const file of fileList) {
          setImportStatus('Reading ' + file.name + '…');
          let entries; try { entries = await unzip(await file.arrayBuffer()); } catch (e) { continue; }
          let byName = new Map(), sampleNames = [];
          const getU8 = (nm) => byName.get(nm) || null;
          for (const [nm, bytes] of entries) {
            if (!nm.toLowerCase().endsWith('.osu')) continue;
            byName = R.archiveFiles(entries,nm); sampleNames = [...byName.keys()];
            scanned++;
            const osuText = new TextDecoder().decode(bytes); let chart;
            try { chart = assembleChart(osuText); }
            catch (e) {   // not osu!standard — collect for mania routing instead of dropping it
              try { const rec = await buildForeign(osuText, getU8, sampleNames); if (rec) foreign.push(rec); } catch (_) {}
              continue;
            }
            const audio = byName.get(String(chart.audioFile).toLowerCase()); if (!audio) continue;
            const art = chart.backgroundFile ? (byName.get(chart.backgroundFile.toLowerCase()) || null) : null;
            const hash = await sha256(osuText);
            await idbPut('osz', hash, { title: chart.title, artist: chart.artist, diffName: chart.diffName, stars: chart.stars, length: chart.length, hash: hash, osuText: osuText, audio: audio, art: art, samples: await R.collectSamples(sampleNames,getU8,chart.audioFile) });
            imported++;
          }
        }
        const mania = await routeForeign(foreign);   // mania charts in the .osz → the Mania library
        await refreshLibrary();
        setImportStatus('Imported ' + imported + ' standard map(s)' + (mania ? ' · ' + mania + ' mania → Mania' : '') +
          ' from ' + scanned + ' .osu — saved, persist across reloads.');
      } catch (e) { setImportStatus('Import failed: ' + ((e && e.message) || e)); }
    }
    async function loadCachedOsz() {
      const all = await idbGetAll('osz');
      return (all || []).map((s) => makeEntry('osz', s.osuText, s, () => Promise.resolve(s.osuText),
        () => Promise.resolve(s.audio.slice().buffer), () => Promise.resolve(s.art ? new Blob([s.art]) : null), () => Promise.resolve(s.samples || [])));
    }
    async function unzip(arrayBuffer) {
      const dv = new DataView(arrayBuffer), u8 = new Uint8Array(arrayBuffer), n = dv.byteLength;
      let eocd = -1;
      for (let i = n - 22; i >= 0 && i >= n - 22 - 65536; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) throw new Error('not a valid .osz/zip');
      const count = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true);
      const headers = [];
      for (let i = 0; i < count; i++) {
        if (dv.getUint32(off, true) !== 0x02014b50) break;
        const method = dv.getUint16(off + 10, true), compSize = dv.getUint32(off + 20, true);
        const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), commentLen = dv.getUint16(off + 32, true);
        const localOff = dv.getUint32(off + 42, true);
        const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
        headers.push({ name: name, method: method, compSize: compSize, localOff: localOff });
        off += 46 + nameLen + extraLen + commentLen;
      }
      const result = new Map();
      for (const h of headers) {
        if (h.name.endsWith('/')) continue;
        const lhNameLen = dv.getUint16(h.localOff + 26, true), lhExtraLen = dv.getUint16(h.localOff + 28, true);
        const dataStart = h.localOff + 30 + lhNameLen + lhExtraLen, comp = u8.subarray(dataStart, dataStart + h.compSize);
        let bytes;
        if (h.method === 0) bytes = comp.slice();
        else if (h.method === 8) { const ds = new DecompressionStream('deflate-raw'); bytes = new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer()); }
        else continue;
        result.set(h.name, bytes);
      }
      return result;
    }

    async function sha256(text) {
      const data = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    // ---- Custom osu! skins ---------------------------------------------------
    // A skin contributes combo colours (skin.ini [Colours]) and sprite images for
    // the hit circle, overlay, approach circle, combo digits and cursor. Sliders
    // keep the built-in look but adopt the skin's combo colours.
    const SKIN_SPRITES = ['hitcircle', 'hitcircleoverlay', 'approachcircle', 'cursor', 'cursortrail'];
    // Only these files are kept/persisted from a skin (skins also ship audio etc.).
    function skinFileWanted(base) {
      if (base === 'skin.ini') return true;
      const m = base.match(/^(.+?)(@2x)?\.png$/);
      if (!m) return false;
      const nm = m[1];
      return SKIN_SPRITES.indexOf(nm) >= 0 || /^default-[0-9]$/.test(nm);
    }
    // Prefer the @2x variant (higher resolution) when both exist.
    function pickSkinBytes(map, name) { return map.get(name + '@2x.png') || map.get(name + '.png') || null; }
    async function buildSkin(name, map) {
      const iniBytes = map.get('skin.ini');
      const colors = parseSkinColors(iniBytes ? new TextDecoder('utf-8').decode(iniBytes) : '');
      const images = { digits: [] };
      for (const sp of SKIN_SPRITES) {
        const bytes = pickSkinBytes(map, sp); if (!bytes) continue;
        try { images[sp] = await createImageBitmap(new Blob([bytes])); } catch (e) {}
      }
      let haveAllDigits = true;
      for (let d = 0; d <= 9; d++) {
        const bytes = pickSkinBytes(map, 'default-' + d);
        if (!bytes) { haveAllDigits = false; break; }
        try { images.digits[d] = await createImageBitmap(new Blob([bytes])); } catch (e) { haveAllDigits = false; break; }
      }
      if (!haveAllDigits) images.digits = [];   // fall back to text numbers unless 0-9 all present
      return { name: name, colors: colors, images: images };
    }
    function applySkin(s) {
      skin = (s && (s.colors.length || s.images.hitcircle || s.images.cursor || s.images.digits.length)) ? s : null;
      tintCache.clear();
      renderSkinStatus(); renderSkinPicker();
    }
    function renderSkinStatus() {
      if (skinClearBtn) skinClearBtn.hidden = !skin;
      if (!skin) { setSkinStatus(''); return; }
      const has = [];
      if (skin.images.hitcircle) has.push('circles');
      if (skin.images.digits.length) has.push('numbers');
      if (skin.images.cursor) has.push('cursor');
      if (skin.colors.length) has.push(skin.colors.length + ' combo colours');
      setSkinStatus('Skin: ' + skin.name + (has.length ? ' — ' + has.join(', ') : ' (no usable sprites found)'));
    }
    // Picker of skin folders discovered in the imported osu! folder — click to apply.
    function renderSkinPicker() {
      const el = document.getElementById('osu-skin-picker'); if (!el) return;
      if (!availableSkins.length) { el.innerHTML = ''; el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = '<span class="osu-skin-pick-lbl">Skins:</span>' + availableSkins.map((d, i) =>
        '<button class="osu-skin-pick' + (skin && skin.name === d.name ? ' on' : '') + '" data-si="' + i + '">' + escapeH(d.name) + '</button>').join('');
    }
    // Keep only the sprite/ini bytes so the cached skin stays small.
    function trimSkinFiles(map) {
      const keep = new Map();
      for (const [nm, bytes] of map) { const base = nm.toLowerCase().split('/').pop(); if (skinFileWanted(base)) keep.set(base, bytes); }
      return keep;
    }
    async function importSkinMap(name, map) {
      const trimmed = trimSkinFiles(map);
      if (!trimmed.size) { setSkinStatus('No skin sprites found in ' + name + '.'); return; }
      setSkinStatus('Loading skin “' + name + '”…');
      const built = await buildSkin(name, trimmed);
      applySkin(built);
      if (skin) {
        try {
          await idbPut('skin', 'current', { name: name, files: Array.from(trimmed, ([n, b]) => ({ n: n, b: b })) });
        } catch (e) {}
      }
    }
    async function handleSkinOsk(file) {
      if (!file) return;
      try {
        const entries = await unzip(await file.arrayBuffer());
        await importSkinMap(file.name.replace(/\.(osk|zip)$/i, ''), entries);
      } catch (e) { setSkinStatus('Skin load failed: ' + ((e && e.message) || e)); }
    }
    // Load a skin from an extracted folder (some users keep skins unzipped). Reuses the
    // same skin-folder detection as the osu! folder import.
    async function handleSkinDir(fileList) {
      if (!fileList || !fileList.length) return;
      try {
        setSkinStatus('Reading skin folder…');
        const dirs = findSkinDirs(fileList);
        if (!dirs.length) { setSkinStatus('No skin files found there (need skin.ini / hitcircle / numbers / etc.).'); return; }
        await loadSkinDir(dirs[0]);
      } catch (e) { setSkinStatus('Skin load failed: ' + ((e && e.message) || e)); }
    }
    async function clearSkin() {
      applySkin(null);
      try { await idbDelete('skin', 'current'); } catch (e) {}
      setSkinStatus('Using the built-in look.');
    }
    async function loadCachedSkin() {
      try {
        const rec = await idbGet('skin', 'current');
        if (!rec || !rec.files) return;
        const map = new Map(rec.files.map((f) => [f.n, f.b]));
        applySkin(await buildSkin(rec.name, map));
      } catch (e) {}
    }
    // Multiply-tint a white/greyscale sprite by a combo colour, preserving alpha.
    function tintImage(key, img, color) {
      const ck = img.src + '|' + key + '|' + color;
      let c = tintCache.get(ck);
      if (c) return c;
      c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      cx.globalCompositeOperation = 'multiply'; cx.fillStyle = color; cx.fillRect(0, 0, c.width, c.height);
      cx.globalCompositeOperation = 'destination-in'; cx.drawImage(img, 0, 0);   // restore original alpha
      tintCache.set(ck, c);
      return c;
    }
    // Draw the combo number using the skin's default-0..9 digit sprites.
    function drawSkinNumber(sc, number, rad, g, skin) {
      const digits = String(number || '').split('');
      const h = rad * 1.0;
      let widths = 0; const dims = digits.map((d) => {
        const im = skin.images.digits[+d]; const w = h * (im.width / im.height); widths += w; return { im: im, w: w };
      });
      const overlap = h * 0.12;
      let total = widths - overlap * (digits.length - 1);
      let x = sc.x - total / 2;
      for (const dm of dims) { g.drawImage(dm.im, x, sc.y - h / 2, dm.w, h); x += dm.w - overlap; }
    }

    // ---- Run lifecycle -------------------------------------------------------
    function teardownRun() {
      if (!run) return;
      run.disposeReplay?.();
      if(audioCtx)audioCtx.__replaySound=null;
      if (!run.finished && run.multiplayer) reportMultiplayer('forfeit');
      run.finished = true;
      disarmQuickRestart();
      pauseUI.hide();
      cancelAnimationFrame(run.rafId);
      bindInput(false);
      try { run.src.stop(); } catch (e) {}
      run = null;
      if (fpsEl) fpsEl.textContent = '';
      if (skipBtn) skipBtn.hidden = true;
      if (keysOverlayEl) { keysOverlayEl.innerHTML = ''; keyBoxes = {}; }
    }
    async function loadAndPlay(entry) {
      if (loading) return;
      loading = true; const gen = ++loadGen; teardownRun(); run = null;
      selector?.stop();
      try {
        const [ac, osuText] = await Promise.all([ensureCtx(), entry.getOsuText()]);
        const chart = assembleChart(osuText);
        const [audioBuf, samples] = await Promise.all([ac.decodeAudioData(await entry.getAudio()), window.Hitsound.prepare(ac, entry.getSamples ? await entry.getSamples() : [])]);
        if (gen !== loadGen || !panelOpen) return;
        startRun(entry, chart, audioBuf);
        run.samples = samples;
      } catch (e) { show('select');setImportStatus(window.I18N.t('rhythm.load_failed'));selector?.failure();return false; }
      finally { loading = false; }
    }

    function startRun(entry, chart, audioBuf, multiplayer) {
      teardownRun();
      if (deps.pauseBgm) deps.pauseBgm();
      stageHud?.start(entry);
      show('game'); grabFocus(); sizeCanvas();
      const ac = audioCtx;
      const preempt = arPreempt(chart.ar), fadeIn = arFadeIn(chart.ar);
      const radius = csRadius(chart.cs);
      const windows = odWindows(chart.od);
      // per-object play state. Combo number resets to 1 at each new combo (and the
      // colour cycles), matching osu — a new combo is a NewCombo object, the first
      // object, or the first object after a spinner.
      const colors = comboColors();
      let comboNum = 0, colorIdx = -1, forceNew = true;
      const objs = chart.objects.map((o) => {
        const st = { o: o, judged: false, result: null };
        if (o.kind === 'circle' || o.kind === 'slider') {
          if (o.newCombo || forceNew) { colorIdx++; comboNum = 1; } else { comboNum++; }
          forceNew = false;
          st.number = comboNum;
          st.color = colors[colorIdx % colors.length];
        } else if (o.kind === 'spinner') { forceNew = true; }
        if (o.kind === 'slider') {
          st.hitWindow = windows.h50; st.headJudged = false; st.headResult = null; st.checkpoints = buildSliderCheckpoints(o, chart);
        }
        if (o.kind === 'spinner') {
          const dur = o.endTime - o.time;
          const rps = S.spinnerRequired(dur, chart.od) / (dur / 1000 || 1);          // required spins/sec scales with OD
          st.requiredRad = (dur / 1000) * rps * 2 * Math.PI;
          st.rot = 0; st.lastAngle = null;
        }
        return st;
      });
      const startCtx = multiplayer ? ac.currentTime + (multiplayer.startAt - performance.now()) / 1000 : ac.currentTime + Math.max(LEAD_IN_MS, preempt) / 1000;
      const src = ac.createBufferSource();
      const gain = ac.createGain();
      gain.gain.value = Math.max(0, Math.min(1, Number.isFinite(Number(settings.musicVol)) ? Number(settings.musicVol) / 100 : 0.6));
      src.buffer = audioBuf; src.connect(gain).connect(ac.destination); src.start(startCtx);
      const lastTime = chart.objects.reduce((m, o) => Math.max(m, o.endTime || o.time), 0);
      const firstTime = chart.objects.length ? chart.objects[0].time : 0;
      run = {
        entry: entry, chart: chart, objs: objs, src: src, gain: gain, startCtx: startCtx,
        t0perf: performance.now(), t0ctx: ac.currentTime, audioBuf: audioBuf,
        preempt: preempt, fadeIn: fadeIn, radius: radius, windows: windows,
        counts: { h300: 0, h100: 0, h50: 0, miss: 0 }, combo: 0, maxCombo: 0,
        lastTime: lastTime, finished: false, rafId: 0, artImg: null, pressed: {},
        clock: R.createClock(ac, startCtx), history: R.createHistory(cursor), paused: false,
        errors: [],   // signed hit-timing errors (ms, +late/-early) for UR + the error bar
        // Skip target: jump to ~1.5s before the first object if the intro is long enough.
        firstTime: firstTime, skipTo: Math.max(0, firstTime - 1500), skipped: false,
        multiplayer: multiplayer || null, mpLastReport: 0,
        auto: multiplayer ? false : autoplay, waypoints: !multiplayer && autoplay ? buildAutoWaypoints(chart) : null,
      };
      errTicks = [];
      if (entry.getArt) entry.getArt().then((b) => {
        if (!b || !run || run.entry !== entry) return;
        const url = URL.createObjectURL(b), img = new Image();
        img.onload = () => { if (run && run.entry === entry) run.artImg = img; URL.revokeObjectURL(url); };
        img.onerror = () => URL.revokeObjectURL(url); img.src = url;
      }).catch(() => {});
      trail = []; bursts = [];
      fpsFrames = 0; fpsLast = performance.now(); fpsPrev = 0; fpsMaxDt = 0;
      buildKeyOverlay();
      bindInput(true);
      run.activityRun = !run.auto ? window.ActivityGames?.newRun() : null;
      run.replay = window.ActivityReplay?.begin(run, 'osu', {snapshot: captureReplayView, draw: render});
      if(run.replay){run.replay.data.keys=tapKeys().concat(['m1','m2']);run.replay.data.musicVolume=run.gain.gain.value;const capture=run.replay,clock=run.clock;audioCtx.__replaySound=sound=>capture.sound(clock.at(),sound);}
      run.rafId = requestAnimationFrame(loop);
      updateHud();
    }

    // Both the rendered song time and the judged tap time are measured against the
    // audio the user actually HEARS, i.e. shifted back by the output latency. This
    // makes the default feel right across devices; calOffset is then a small
    // personal fine-tune rather than a per-device latency band-aid.
    function songTimeNow() { return run.clock.at() - calOffset(); }
    function inputSongTime(perfTs) { return run.clock.at(R.eventTime(perfTs)) - calOffset(); }

    function loop() {
      if (!run || run.finished || run.paused) return;
      const st = songTimeNow();
      stageHud?.update(st, run.lastTime);
      if (run.auto) {   // preview: drive cursor (+ trail) + auto-hit
        cursor = autoCursor(st);
        trail.push({ x: cursor.x, y: cursor.y, t: performance.now() }); if (trail.length > 24) trail.shift();
        autoTap(st);
      }
      updateSliders(st);
      updateSpinners(st);
      sweepMisses(st);
      render(st + calOffset() + (Number(settings.osuVisualOffset) || 0));
      run.replay?.sample(st + calOffset(), st + calOffset() + (Number(settings.osuVisualOffset) || 0), cursor, heldAny() ? 1 : 0, run.counts, run.combo);
      run.history.prune(st - 5000);
      tickFps();
      updateSkip(st);
      if (run.multiplayer && st >= 0 && performance.now() - run.mpLastReport >= 250) reportMultiplayer('playing');
      if (st > run.lastTime + END_PAD_MS) { finishRun(); return; }
      run.rafId = requestAnimationFrame(loop);
    }
    // Skip button: offered during a long intro; fast-forwards the audio + clock to
    // ~1.5s before the first object (like osu's Skip).
    function updateSkip(st) {
      if (!skipBtn) return;
      const show = !run.multiplayer && !run.skipped && run.skipTo > 800 && st < run.skipTo - 100;
      if (skipBtn.hidden === show) skipBtn.hidden = !show;
    }
    function doSkip() {
      if (!run || run.finished || run.multiplayer || run.skipped) return;
      if (songTimeNow() >= run.skipTo - 50) return;
      const ac = audioCtx, when = ac.currentTime;
      try { run.src.stop(); } catch (e) {}
      const src = ac.createBufferSource();
      src.buffer = run.audioBuf; src.connect(run.gain);     // gain is already wired to destination
      src.start(when, run.skipTo / 1000);                    // play from the skip offset
      run.src = src;
      run.startCtx = when - run.skipTo / 1000; run.clock.reset(run.startCtx);               // songTimeNow now reads ~skipTo
      run.t0ctx = ac.currentTime; run.t0perf = performance.now();   // re-sync the input→ctx mapping
      run.skipped = true;
      run.replay?.skip(run.skipTo);
      if (skipBtn) skipBtn.hidden = true;
    }
    // FPS counter: frames over the last ~half-second. The loop is a bare rAF, so
    // this is the display's refresh rate (60 / 144 / 240… as fast as the monitor +
    // render cost allow) — there's no artificial frame cap.
    function tickFps() {
      if (!fpsEl) return;
      const now = performance.now();
      if (fpsPrev) { const dt = now - fpsPrev; if (dt > fpsMaxDt) fpsMaxDt = dt; }   // worst frame this window
      fpsPrev = now;
      fpsFrames++;
      const elapsed = now - fpsLast;
      if (elapsed >= 500) {
        const fps = Math.round(fpsFrames * 1000 / elapsed);
        const avgMs = elapsed / fpsFrames;                                            // average frametime
        fpsEl.textContent = (settings.showFps !== false)
          ? (fps + ' FPS · ' + avgMs.toFixed(1) + ' ms · max ' + Math.round(fpsMaxDt) + ' ms') : '';
        fpsFrames = 0; fpsLast = now; fpsMaxDt = 0;
      }
    }

    function sweepMisses(st) {
      for (const s of run.objs) {
        if (s.judged) continue;
        if (s.o.kind === 'circle' && st > s.o.time + run.windows.h50) { judgeResult(s, 'miss'); }
      }
    }

    // ---- Spinners ------------------------------------------------------------
    // Accumulate cursor rotation around the playfield centre; clear when the
    // accumulated angle reaches the required amount (scales with duration + OD).
    function updateSpinners(st) {
      for (const s of run.objs) {
        if (s.o.kind !== 'spinner' || s.judged) continue;
        const o = s.o;
        if (run.auto && st >= o.time) s.rot = Math.max(0, Math.min(st,o.endTime)-o.time) / 1000 * Math.PI * 12;
        if (st > o.endTime) {
          const result = S.spinnerResult(s.rot / (2*Math.PI), s.requiredRad / (2*Math.PI));
          judgeResult(s, result);
          if (result !== 'miss') playObjectSound(o);
        }
      }
    }
    function rememberInput(perfTs) {
      if (!run || run.paused || run.auto) return;
      const time = inputSongTime(perfTs), input = {...cursor, held:heldAny()};
      run.history.push(time, input);
      for (const s of run.objs) if (s.o.kind === 'spinner' && !s.judged && time >= s.o.time && time <= s.o.endTime) S.spinSample(s,input,time);
    }

    // ---- Sliders -------------------------------------------------------------
    function buildSliderCheckpoints(o, chart) { return S.checkpoints(o, chart); }
    function pointAtFrac(path, frac) {
      if (!path.length) return { x: 0, y: 0 };
      const f = Math.max(0, Math.min(1, frac)) * (path.length - 1);
      const i = Math.floor(f), t = f - i;
      const a = path[i], b = path[Math.min(path.length - 1, i + 1)];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    function sliderBallPos(o, st) { return S.ball(o, st); }
    function heldAny() { return (run && run.auto) || tapKeys().some((k) => run.pressed[k]) || !!run.pressed.m1 || !!run.pressed.m2; }

    // ---- Autoplay (preview): drive the cursor + auto-hit; no score saved -------
    // Cursor anchor points to lerp between when no slider/spinner is active.
    function buildAutoWaypoints(chart) {
      const wp = [];
      for (const o of chart.objects) {
        if (o.kind === 'circle') wp.push({ t: o.time, x: o.x, y: o.y });
        else if (o.kind === 'slider') { wp.push({ t: o.time, x: o.x, y: o.y }); const e = sliderBallPos(o, o.endTime); wp.push({ t: o.endTime, x: e.x, y: e.y }); }
        else if (o.kind === 'spinner') { wp.push({ t: o.time, x: PLAY_W / 2, y: PLAY_H / 2 }); wp.push({ t: o.endTime, x: PLAY_W / 2, y: PLAY_H / 2 }); }
      }
      return wp;
    }
    function autoCursor(st) {
      for (const s of run.objs) {                       // follow an active slider / spin an active spinner
        const o = s.o;
        if (o.kind === 'spinner' && st >= o.time && st <= o.endTime) {
          const ang = (st / 1000) * Math.PI * 2 * 6;    // 6 rev/sec — comfortably clears any spinner
          return { x: PLAY_W / 2 + Math.cos(ang) * 90, y: PLAY_H / 2 + Math.sin(ang) * 90 };
        }
        if (o.kind === 'slider' && st >= o.time && st <= o.endTime) return sliderBallPos(o, st);
      }
      const wp = run.waypoints; if (!wp || !wp.length) return { x: PLAY_W / 2, y: PLAY_H / 2 };
      let prev = wp[0], next = null;
      for (let i = 0; i < wp.length; i++) { if (wp[i].t <= st) prev = wp[i]; else { next = wp[i]; break; } }
      if (!next) return { x: prev.x, y: prev.y };
      const f = next.t > prev.t ? Math.max(0, Math.min(1, (st - prev.t) / (next.t - prev.t))) : 1;
      return { x: prev.x + (next.x - prev.x) * f, y: prev.y + (next.y - prev.y) * f };
    }
    // Auto-hit each circle / slider-head exactly on time as a perfect 300.
    function autoTap(st) {
      for (const s of run.objs) {
        const o = s.o;
        if (o.kind === 'spinner') continue;
        const headDone = o.kind === 'circle' ? s.judged : s.headJudged;
        if (headDone) continue;
        if (st < o.time) break;                          // this (and later) objects aren't due yet
        recordError(0, 'h300'); playObjectSound(o);
        if (o.kind === 'slider') { s.headJudged = true; s.headResult = 'h300'; sliderPart(true, 'head'); }
        else judgeResult(s, 'h300');
      }
    }

    function sliderPart(hit, kind) {
      if (hit) { run.combo++; run.maxCombo = Math.max(run.maxCombo, run.combo); }
      else if (kind !== 'tail') { run.combo = 0; flashJudge('miss'); }
      updateHud();
    }
    function updateSliders(st) {
      for (const s of run.objs) {
        if (s.o.kind !== 'slider' || s.judged) continue;
        const history = run.auto ? { at: t => ({...sliderBallPos(s.o,t),held:true}) } : run.history;
        const headBefore = s.headJudged;
        const ended = S.processSlider(s, st, history, run.radius, (hit, kind, time, edge) => {
          sliderPart(hit, kind);
          if (hit) {
            if (kind === 'tick') window.Hitsound.playTick(audioCtx, run.samples, R.soundSpec(run.chart,s.o,time));
            else playObjectSound(s.o, kind === 'repeat' ? 0.85 : 1, edge, time);
          }
        });
        if (!headBefore && s.headJudged) run.replay?.mark(s.o, 'head', s.headResult, run.clock.at());
        if (ended) finalizeSlider(s);
      }
    }
    function finalizeSlider(s) {
      const result = S.sliderResult(s);
      run.replay?.mark(s.o, 'end', result, run.clock.at());
      s.judged = true; s.result = result;
      run.counts[result]++;
      bursts.push({ x: s.o.x, y: s.o.y, result: result, t: performance.now() });
      flashJudge(result); updateHud();
    }

    function judgeResult(s, result) {
      run.replay?.mark(s.o, 'end', result, run.clock.at());
      s.judged = true; s.result = result;
      const c = run.counts;
      if (result === 'miss') { c.miss++; run.combo = 0; }
      else { c[result]++; run.combo++; run.maxCombo = Math.max(run.maxCombo, run.combo); }
      if (s.o.x != null) bursts.push({ x: s.o.x, y: s.o.y, result: result, t: performance.now() });
      if (bursts.length > 32) bursts.shift();
      flashJudge(result);
      updateHud();
    }

    // ---- Input ---------------------------------------------------------------
    function onTap(perfTs) {
      if (!run || run.finished || run.auto || run.paused) return;
      const st = inputSongTime(perfTs);
      updateSliders(st); sweepMisses(st);
      // earliest object whose head is still unhit, within the catchable window
      let best = null;
      for (const s of run.objs) {
        const o = s.o;
        if (o.kind === 'spinner') continue;
        const headDone = o.kind === 'circle' ? s.judged : s.headJudged;
        if (headDone) continue;
        if (st < o.time - 400) break;            // next ones are later — too early
        if (st <= o.time + run.windows.h50) { best = s; break; }
      }
      if (!best) return;
      // cursor must be over the head
      if (dist(cursor, { x: best.o.x, y: best.o.y }) > run.radius) return;   // missed aim
      const signed = st - best.o.time;                     // +late / -early
      const w = run.windows;
      const rounded = Math.abs(Math.round(signed));
      const result = rounded < Math.trunc(w.h300) ? 'h300' : rounded < Math.trunc(w.h100) ? 'h100' : rounded < Math.trunc(w.h50) ? 'h50' : 'miss';
      if (result !== 'miss') { recordError(signed, result); playObjectSound(best.o); }
      if (best.o.kind === 'slider') { best.headJudged = true; best.headResult = result; run.replay?.mark(best.o, 'head', result, run.clock.at()); sliderPart(result !== 'miss', 'head'); }  // body/tail scored later
      else judgeResult(best, result);
    }
    function bindInput(on) {
      const fn = on ? 'addEventListener' : 'removeEventListener';
      canvas[fn]('pointermove', onPointerMove);
      canvas[fn]('pointerdown', onPointerDown);
      canvas[fn]('mousedown', onMouseDown);
      window[fn]('pointerup', onPointerUp);
      window[fn]('mouseup', onMouseUp);
      canvas[fn]('pointercancel', onPointerUp);
      window[fn]('keydown', onKeyDown);
    }
    function onPointerMove(e) { if (!run) return; const events = e.getCoalescedEvents ? e.getCoalescedEvents() : []; for (const p of events.length ? events : [e]) { updateCursorFromEvent(p); rememberInput(p.timeStamp); } }
    // Both mouse buttons tap (left = M1, right = M2, like osu); right-click's context
    // menu is suppressed on the canvas so it can be used as a button.
    function mouseBtn(e) { return e.button === 2 ? 'm2' : 'm1'; }
    function onPointerDown(e) { if (!run || run.paused || e.pointerType === 'mouse') return; e.preventDefault(); updateCursorFromEvent(e); try { canvas.setPointerCapture(e.pointerId); } catch (_) {} run.pressed.m1 = true; pressKey('m1',true, e.timeStamp); rememberInput(e.timeStamp); onTap(e.timeStamp); }
    function onPointerUp(e) { if (!run || e.pointerType === 'mouse') return; run.pressed.m1 = false; pressKey('m1',false, e.timeStamp); rememberInput(e.timeStamp); }
    function onMouseDown(e) { if (!run || run.paused || ![0,2].includes(e.button)) return; e.preventDefault(); grabFocus(); updateCursorFromEvent(e); const b=mouseBtn(e); run.pressed[b]=true; pressKey(b,true, e.timeStamp); rememberInput(e.timeStamp); onTap(e.timeStamp); }
    function onMouseUp(e) { if (!run || ![0,2].includes(e.button)) return; const b=mouseBtn(e); run.pressed[b]=false; pressKey(b,false, e.timeStamp); rememberInput(e.timeStamp); }
    function tapKeys() {
      const k = settings.osuKeys;
      return (Array.isArray(k) && k.length) ? k.map((x) => String(x).toLowerCase()) : ['z', 'x'];
    }
    // Key-press overlay (right side): a live box per tap key + M1/M2 (mouse), lit
    // while held, with a running press count — like osu's key overlay.
    let keyBoxes = {}, keyCounts = {};
    function buildKeyOverlay() {
      if (!keysOverlayEl) return;
      keyBoxes = {}; keyCounts = {}; keysOverlayEl.innerHTML = '';
      tapKeys().concat(['m1', 'm2']).forEach((k) => {
        const label = k === 'm1' ? 'M1' : k === 'm2' ? 'M2' : (k === ' ' ? '␣' : k.toUpperCase());
        const box = document.createElement('div'); box.className = 'osu-key';
        box.innerHTML = '<span class="osu-key-label">' + label + '</span><span class="osu-key-count">0</span>';
        keysOverlayEl.appendChild(box); keyBoxes[k] = box; keyCounts[k] = 0;
      });
    }
    function pressKey(k, on, perfTs) {
      if(run&&!run.finished)run.replay?.input(inputSongTime(perfTs)+calOffset(),k,on);
      const box = keyBoxes[k]; if (!box) return;
      box.classList.toggle('active', on);
      if (on) { keyCounts[k] = (keyCounts[k] || 0) + 1; box.querySelector('.osu-key-count').textContent = keyCounts[k]; }
    }
    // Tap-key rebinding (song-select): click a key slot, then press the new key.
    let rebindIdx = null, rebindBtn = null;
    function renderKeybinds() {
      if (!keybindsEl) return;
      keybindsEl.innerHTML = '';
      tapKeys().forEach((key, i) => {
        const btn = document.createElement('button'); btn.type = 'button';
        btn.textContent = key === ' ' ? '␣' : key;
        btn.addEventListener('click', () => {
          if (rebindBtn) rebindBtn.classList.remove('binding');
          rebindIdx = i; rebindBtn = btn; btn.classList.add('binding'); btn.textContent = '…';
        });
        keybindsEl.appendChild(btn);
      });
    }
    function applyRebind(key) {
      const keys = tapKeys(); keys[rebindIdx] = key;
      settings.osuKeys = keys; if (deps.saveSettings) deps.saveSettings();
      rebindIdx = null; rebindBtn = null; renderKeybinds();
    }
    window.addEventListener('keydown', (e) => {
      if (rebindIdx === null) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape') { if (rebindBtn) rebindBtn.classList.remove('binding'); rebindIdx = null; rebindBtn = null; renderKeybinds(); return; }
      if (e.key.length === 1 || e.key === ' ') applyRebind(e.key.toLowerCase());
    }, true);
    function armQuickRestart() {
      if (!run || run.finished || run.multiplayer || run.restartTimer) return;   // run.restartTimer also guards key auto-repeat
      run.restartTimer = setTimeout(() => { if (run) run.restartTimer = null; if (run && run.entry) loadAndPlay(run.entry); }, 1500);
    }
    function disarmQuickRestart() { if (run && run.restartTimer) { clearTimeout(run.restartTimer); run.restartTimer = null; } }
    function onKeyDown(e) {
      if (!run || run.finished) return;
      if (e.key === '`' || e.code === 'Backquote') { e.preventDefault(); armQuickRestart(); return; }   // hold ~1.5s → quick restart
      if (e.key === 'Escape') { e.preventDefault(); if (!run.paused) pauseRun(); return; }
      if (run.paused) { const k=e.key.toLowerCase(); if(tapKeys().includes(k)) { run.pressed[k]=true; e.preventDefault(); } return; }
      if ((e.key === ' ' || e.code === 'Space') && skipBtn && !skipBtn.hidden) { e.preventDefault(); doSkip(); return; }
      const k = e.key.toLowerCase();
      if (tapKeys().indexOf(k) >= 0) { if (run.pressed[k]) return; run.pressed[k] = true; pressKey(k, true, e.timeStamp); e.preventDefault(); rememberInput(e.timeStamp); onTap(e.timeStamp); }
    }
    window.addEventListener('keyup', (e) => { if (e.key === '`' || e.code === 'Backquote') { disarmQuickRestart(); return; } const k = e.key.toLowerCase(); if (run) { run.pressed[k] = false; pressKey(k, false, e.timeStamp); rememberInput(e.timeStamp); } });

    // ---- Render --------------------------------------------------------------
    function accuracy() {
      const c = run.counts, total = c.h300 + c.h100 + c.h50 + c.miss;
      if (!total) return 100;
      return Math.round(((300 * c.h300 + 100 * c.h100 + 50 * c.h50) / (300 * total)) * 10000) / 100;
    }
    function liveRenderView() {
      return {canvas, g, run, skin, tf:transform(), dpr:canvas.width/canvas.getBoundingClientRect().width,
        brightness:bgBrightness(), cScale:cursorScale(), cursor, trail, bursts, errTicks, now:performance.now()};
    }
    function captureReplayView(st) {
      const v=liveRenderView();
      // Static geometry/images are shared; only visible mutable state is copied.
      v.canvas={width:canvas.width,height:canvas.height}; delete v.g;
      v.run={radius:run.radius,preempt:run.preempt,fadeIn:run.fadeIn,windows:run.windows,artImg:run.artImg,
        connections:run.chart.objects,errors:{length:run.errors.length},errorMean:run.errorMean,
        objs:run.objs.filter(s=>!s.judged && st>=s.o.time-Math.max(run.preempt,300)).map(s=>({...s,checkpoints:s.checkpoints?.map(cp=>({...cp}))}))};
      v.cursor={...cursor};v.trail=trail.slice();v.bursts=bursts.slice();v.errTicks=errTicks.slice();v.replay=true;
      v.hud=window.ActivityReplay.captureHud(canvas,[comboEl,accEl,judgeEl,fpsEl,skipBtn,...Object.values(keyBoxes)]);
      return v;
    }
    function render(st, view=liveRenderView()) {
      const {canvas,g,run,skin,tf,dpr,cursor,trail,bursts,errTicks,now}=view;
      const W = canvas.width, H = canvas.height;
      g.clearRect(0, 0, W, H); g.fillStyle = '#071827'; g.fillRect(0, 0, W, H);
      if (run.artImg) {
        const iw = run.artImg.naturalWidth, ih = run.artImg.naturalHeight;
        if (iw && ih) { const s = Math.max(W / iw, H / ih); g.globalAlpha = view.brightness; g.drawImage(run.artImg, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s); g.globalAlpha = 1; }
      }
      // No boxed boundary: the letterboxed hit geometry remains unchanged.
      const rad = run.radius * tf.scale;
      // Connections respect combo boundaries and start at a slider's final end.
      const connections=run.connections || run.chart.objects;
      for (let i=1;i<connections.length;i++) {
        const a=connections[i-1], b=connections[i];
        if (a.kind==='spinner' || b.kind==='spinner' || b.newCombo || st<b.time-run.preempt || st>b.time) continue;
        const start=a.kind==='slider'?sliderBallPos(a,a.endTime):a;
        const length=dist(start,b); if(length<run.radius*3) continue;
        g.save(); g.fillStyle='#fff'; g.globalAlpha=Math.min(0.4,Math.max(0,(st-(b.time-run.preempt))/300));
        for(let d=run.radius*1.5;d<length-run.radius*1.5;d+=24) {
          const p=osuToScreen(start.x+(b.x-start.x)*d/length,start.y+(b.y-start.y)*d/length,tf);
          g.beginPath();g.arc(p.x,p.y,2*dpr,0,Math.PI*2);g.fill();
        }
        g.restore();
      }
      // draw objects latest-first so earlier (upcoming) circles sit on top
      for (let i = run.objs.length - 1; i >= 0; i--) {
        const s = run.objs[i], o = s.o;
        if (o.kind === 'spinner') {
          if (s.judged || st < o.time - 300 || st > o.endTime + 150) continue;
          const ctr = osuToScreen(PLAY_W / 2, PLAY_H / 2, tf);
          const prog = Math.min(1, s.requiredRad > 0 ? s.rot / s.requiredRad : 0);
          const baseR = Math.min(W, H) * 0.32;
          const fadeS = Math.min(1, (st - (o.time - 300)) / 250);
          g.save(); g.globalAlpha = fadeS;
          // outer ring + progress arc
          g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 4 * dpr;
          g.beginPath(); g.arc(ctr.x, ctr.y, baseR, 0, Math.PI * 2); g.stroke();
          g.strokeStyle = prog >= 1 ? '#39d98a' : '#56a0ff'; g.lineWidth = 6 * dpr;
          g.beginPath(); g.arc(ctr.x, ctr.y, baseR, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); g.stroke();
          // spinning indicator
          const sp = (s.lastAngle || 0);
          g.strokeStyle = '#fff'; g.lineWidth = 3 * dpr;
          g.beginPath(); g.moveTo(ctr.x, ctr.y); g.lineTo(ctr.x + Math.cos(sp) * baseR * 0.8, ctr.y + Math.sin(sp) * baseR * 0.8); g.stroke();
          // text
          g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.font = (28 * dpr) + 'px system-ui'; g.fillText(window.I18N.t(prog >= 1 ? 'rhythm.clear' : 'rhythm.spin'), ctr.x, ctr.y);
          g.font = (16 * dpr) + 'px system-ui'; g.fillStyle = '#9aa0ab';
          g.fillText(Math.round(prog * 100) + '%', ctr.x, ctr.y + 30 * dpr);
          g.restore();
          continue;
        }
        const appear = o.time - run.preempt;
        if (st < appear || s.judged) continue;
        const sc = osuToScreen(o.x, o.y, tf);
        const fade = Math.min(1, (st - appear) / run.fadeIn);

        if (o.kind === 'slider') {
          // body track
          g.globalAlpha = fade;
          g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = rad * 2; g.lineCap = 'round'; g.lineJoin = 'round';
          g.beginPath();
          for (let j = 0; j < o.path.length; j++) { const pp = osuToScreen(o.path[j].x, o.path[j].y, tf); j ? g.lineTo(pp.x, pp.y) : g.moveTo(pp.x, pp.y); }
          g.stroke();
          g.strokeStyle = s.color; g.globalAlpha = fade * 0.55; g.lineWidth = rad * 1.6; g.stroke(); g.globalAlpha = fade;
          // ticks
          for (const cp of s.checkpoints) {
            if (cp.kind !== 'tick' || cp.ev) continue;
            const tp = osuToScreen(pointAtFrac(o.path, cp.frac).x, pointAtFrac(o.path, cp.frac).y, tf);
            g.fillStyle = '#fff'; g.beginPath(); g.arc(tp.x, tp.y, 3 * dpr, 0, Math.PI * 2); g.fill();
          }
          // Point the next repeat arrow back along the upcoming span.
          const repeat = s.checkpoints.find(cp => cp.kind==='repeat' && cp.time>=st);
          if (repeat) {
            const p=pointAtFrac(o.path,repeat.frac), inside=pointAtFrac(o.path,repeat.frac ? 0.95 : 0.05);
            const sp=osuToScreen(p.x,p.y,tf), angle=Math.atan2(inside.y-p.y,inside.x-p.x);
            g.save();g.translate(sp.x,sp.y);g.rotate(angle);g.strokeStyle='#fff';g.lineWidth=4*dpr;
            g.beginPath();g.moveTo(-rad*0.25,-rad*0.4);g.lineTo(rad*0.25,0);g.lineTo(-rad*0.25,rad*0.4);g.stroke();g.restore();
          }
          // tail cap
          const tail = osuToScreen(o.path[o.path.length - 1].x, o.path[o.path.length - 1].y, tf);
          g.strokeStyle = s.color; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(tail.x, tail.y, rad - 2 * dpr, 0, Math.PI * 2); g.stroke();
          // follow-ball while active
          if (st >= o.time && st <= o.endTime) {
            const ball = sliderBallPos(o, st); const bp = osuToScreen(ball.x, ball.y, tf);
            g.save();
            g.fillStyle = s.color; g.globalAlpha = 0.9; g.beginPath(); g.arc(bp.x, bp.y, rad * 0.7, 0, Math.PI * 2); g.fill();
            g.globalAlpha = s.following ? 0.9 : 0.4; g.strokeStyle = '#fff'; g.lineWidth = 3 * dpr;
            g.beginPath(); g.arc(bp.x, bp.y, rad * 2.4, 0, Math.PI * 2); g.stroke();   // follow circle
            g.restore();
          }
          g.globalAlpha = 1;
          if (s.headJudged) continue;   // head consumed — skip the head circle/approach below
        }

        // hit-circle head: body + ring + number + approach circle
        g.globalAlpha = fade;
        const ap = Math.max(0, (o.time - st) / run.preempt);
        if (skin && skin.images.hitcircle) {
          const d = rad * 2;
          g.drawImage(tintImage('hc', skin.images.hitcircle, s.color), sc.x - rad, sc.y - rad, d, d);
          if (skin.images.hitcircleoverlay) g.drawImage(skin.images.hitcircleoverlay, sc.x - rad, sc.y - rad, d, d);
          if (skin.images.digits.length) drawSkinNumber(sc, s.number, rad, g, skin);
          else { g.fillStyle = '#fff'; g.font = '700 ' + (rad * 0.9) + 'px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(s.number || ''), sc.x, sc.y); }
          if (ap > 0) {
            const ar = rad * (1 + ap * 3);
            if (skin.images.approachcircle) g.drawImage(tintImage('ac', skin.images.approachcircle, s.color), sc.x - ar, sc.y - ar, ar * 2, ar * 2);
            else { g.strokeStyle = s.color; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(sc.x, sc.y, ar, 0, Math.PI * 2); g.stroke(); }
          }
        } else {
          g.fillStyle = '#071827'; g.beginPath(); g.arc(sc.x, sc.y, rad, 0, Math.PI * 2); g.fill();
          g.save(); g.globalAlpha=fade*.2; g.fillStyle=s.color;g.fill();g.restore();
          g.strokeStyle='rgba(230,250,255,.85)';g.lineWidth=1.2*dpr;g.stroke();
          g.strokeStyle = s.color; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(sc.x, sc.y, rad - 2 * dpr, 0, Math.PI * 2); g.stroke();
          g.fillStyle = '#fff'; g.font = '700 ' + (rad * 0.9) + 'px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(s.number || ''), sc.x, sc.y);
          if (ap > 0) { g.strokeStyle = s.color; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(sc.x, sc.y, rad * (1 + ap * 3), 0, Math.PI * 2); g.stroke(); }
        }
        g.globalAlpha = 1;
      }
      // hit-feedback bursts at the circle position (expanding ring + judgement)
      const nowB = view.now;
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i]; const age = nowB - b.t;
        if (age > 350) { if(!view.replay) bursts.splice(i, 1); continue; }
        const k = age / 350, sc = osuToScreen(b.x, b.y, tf), col = JUDGE_COLORS[b.result] || '#fff';
        g.globalAlpha = 1 - k; g.strokeStyle = col; g.lineWidth = 3 * dpr;
        g.beginPath(); g.arc(sc.x, sc.y, rad * (1 + k * 0.8), 0, Math.PI * 2); g.stroke();
        if (b.result !== 'miss') { g.globalAlpha = (1 - k) * 0.9; g.fillStyle = col; g.font = (rad * 0.7) + 'px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(JUDGE_LABELS[b.result], sc.x, sc.y - rad * 1.4); }
        g.globalAlpha = 1;
      }
      // cursor trail — skin sprite if provided, else the built-in glow line
      const nowC = view.now;
      if (skin && skin.images.cursortrail) {
        const im = skin.images.cursortrail, ts = (30 * dpr) / Math.max(im.width, im.height), tw = im.width * ts, th = im.height * ts;
        for (let i = 0; i < trail.length; i++) {
          const p = osuToScreen(trail[i].x, trail[i].y, tf), age = nowC - trail[i].t; if (age > 220) continue;
          g.globalAlpha = (1 - age / 220) * 0.6; g.drawImage(im, p.x - tw / 2, p.y - th / 2, tw, th);
        }
      } else {
        for (let i = 1; i < trail.length; i++) {
          const a = osuToScreen(trail[i - 1].x, trail[i - 1].y, tf), bp = osuToScreen(trail[i].x, trail[i].y, tf);
          const age = nowC - trail[i].t; if (age > 220) continue;
          g.globalAlpha = (1 - age / 220) * 0.5; g.strokeStyle = '#2b6cff'; g.lineWidth = 4 * dpr; g.lineCap = 'round';
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(bp.x, bp.y); g.stroke();
        }
      }
      g.globalAlpha = 1;
      // cursor — skin sprite if provided, else the built-in glowing dot (× user size)
      const cs = osuToScreen(cursor.x, cursor.y, tf);
      const cScale = view.cScale;
      if (skin && skin.images.cursor) {
        const im = skin.images.cursor, csz = (44 * dpr * cScale) / Math.max(im.width, im.height), cw = im.width * csz, ch = im.height * csz;
        g.drawImage(im, cs.x - cw / 2, cs.y - ch / 2, cw, ch);
      } else {
        g.save();
        g.shadowColor = '#2b6cff'; g.shadowBlur = 14 * dpr;
        g.fillStyle = '#fff'; g.beginPath(); g.arc(cs.x, cs.y, 8 * dpr * cScale, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0; g.strokeStyle = '#2b6cff'; g.lineWidth = 3 * dpr;
        g.beginPath(); g.arc(cs.x, cs.y, 12 * dpr * cScale, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
      drawErrorBar(W, H, dpr, view);
    }

    // Hit-error bar near the bottom: ticks left of centre = early, right = late.
    // Background zones show the 300/100/50 windows; a marker tracks the running
    // mean. Ticks fade over ~2.5s. Mirrors osu!mania's bar.
    function drawErrorBar(W, H, dpr, view) {
      const {g,run,errTicks}=view;
      const w = run.windows;
      const cx = W / 2, y = H - 30 * dpr, half = W * 0.22;
      const pxPerMs = half / (w.h50 || 100);            // full bar = ±50 (widest) window
      const zone = (ms, color) => { g.fillStyle = color; g.fillRect(cx - ms * pxPerMs, y - 5 * dpr, ms * pxPerMs * 2, 10 * dpr); };
      zone(w.h50, 'rgba(255,209,102,0.20)');
      zone(w.h100, 'rgba(57,217,138,0.24)');
      zone(w.h300, 'rgba(86,160,255,0.30)');
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(cx - dpr, y - 9 * dpr, 2 * dpr, 18 * dpr);   // centre line
      const nowP = view.now;
      for (let i = errTicks.length - 1; i >= 0; i--) {
        const e = errTicks[i], age = nowP - e.t;
        if (age > 2500) { if(!view.replay) errTicks.splice(i, 1); continue; }
        const x = cx + Math.max(-half, Math.min(half, e.err * pxPerMs));
        g.globalAlpha = 1 - age / 2500; g.fillStyle = JUDGE_COLORS[e.result] || '#fff';
        g.fillRect(x - dpr, y - 8 * dpr, 2 * dpr, 16 * dpr); g.globalAlpha = 1;
      }
      if (run.errors.length >= 3) {                     // running-mean marker (small triangle under the bar)
        const mean = run.errorMean || 0;
        const mx = cx + Math.max(-half, Math.min(half, mean * pxPerMs));
        g.fillStyle = '#9be7ff';
        g.beginPath(); g.moveTo(mx, y + 9 * dpr); g.lineTo(mx - 4 * dpr, y + 15 * dpr); g.lineTo(mx + 4 * dpr, y + 15 * dpr); g.closePath(); g.fill();
      }
    }

    const JUDGE_LABELS = { h300: '300', h100: '100', h50: '50', miss: 'MISS' };
    const JUDGE_COLORS = { h300: '#56a0ff', h100: '#39d98a', h50: '#ffd166', miss: '#ff5470' };
    function flashJudge(r) {
      if (!judgeEl) return;
      judgeEl.textContent = JUDGE_LABELS[r] || r; judgeEl.style.color = JUDGE_COLORS[r] || '#fff';
      judgeEl.style.transition = 'none'; judgeEl.style.opacity = '1';
      requestAnimationFrame(() => { judgeEl.style.transition = 'opacity .3s'; judgeEl.style.opacity = '0'; });
    }
    function updateHud() {
      if (comboEl) comboEl.textContent = run.combo > 1 ? run.combo + 'x' : '';
      if (accEl) {
        const ur = run.errors.length > 1 ? Math.sqrt((run.errorM2 || 0) / run.errors.length) * 10 : 0;
        accEl.textContent = accuracy().toFixed(2) + '%' + (ur ? '  ·  UR ' + Math.round(ur) : '');
      }
    }

    // ---- Results / PB --------------------------------------------------------
    async function finishRun() {
      if (!run || run.finished) return;
      const active = run;
      const isAuto = active.auto;
      if (active.multiplayer) reportMultiplayer('finished');
      active.finished = true; disarmQuickRestart(); pauseUI.hide(); cancelAnimationFrame(active.rafId); bindInput(false);
      try { active.src.stop(); } catch (e) {}
      if (!active.auto && active.activityRun) {
        void window.ActivityGames?.complete(active.activityRun, {
          mode: 'osu', title: active.entry.title, difficulty: active.entry.diffName,
          getText: () => active.entry.getOsuText(), counts: active.counts, maxCombo: active.maxCombo,
        }).catch(() => {});
      }
      const acc = accuracy();
      let prev = null, improved = false;
      if (!isAuto) {   // autoplay is a preview — never recorded as a personal best
        const hash = 'classic-v2:' + await sha256(await active.entry.getOsuText());
        prev = await idbGet('osu-pb', hash);
        improved = !prev || acc > prev.accuracy || (acc === prev.accuracy && active.maxCombo > prev.maxCombo);
        if (improved) await idbPut('osu-pb', hash, { accuracy: acc, maxCombo: active.maxCombo, date: new Date().toISOString() });
      }
      if (run !== active) return;
      const c = active.counts;
      const total = c.h300 + c.h100 + c.h50 + c.miss;
      const grade = c.miss === 0 && acc === 100 ? 'SS' : acc >= 95 && c.miss === 0 ? 'S' : acc >= 90 ? 'A' : acc >= 80 ? 'B' : acc >= 70 ? 'C' : 'D';
      const gradeColor = { SS: '#ffd166', S: '#ffd166', A: '#39d98a', B: '#56a0ff', C: '#b06bff', D: '#ff5470' }[grade];
      const possibleCombo = active.objs.reduce((n,s) => n + (s.o.kind === 'slider' ? 1+s.checkpoints.length : 1),0);
      const fc = c.miss === 0 && active.maxCombo === possibleCombo ? '<span class="osu-res-fc">Full Combo!</span>' : '';
      const cell = (label, val, col) => '<div class="osu-res-cell"><div class="osu-res-cn" style="color:' + col + '">' + val + '</div><div class="osu-res-cl">' + label + '</div></div>';
      resultsBody.innerHTML =
        '<div class="osu-res-title">' + escapeH(active.entry.title) + ' · ' + escapeH(active.entry.diffName) + '</div>' +
        '<div class="osu-res-grade" style="color:' + gradeColor + '">' + grade + '</div>' +
        '<div class="osu-res-acc">' + acc.toFixed(2) + '%</div>' +
        '<div class="osu-res-grid">' +
          cell('300', c.h300, '#56a0ff') + cell('100', c.h100, '#39d98a') +
          cell('50', c.h50, '#ffd166') + cell('Miss', c.miss, '#ff5470') +
        '</div>' +
        '<div class="osu-res-combo">Max combo ' + active.maxCombo + 'x &nbsp;·&nbsp; ' + total + ' objects &nbsp;·&nbsp; UR ' + Math.round(unstableRate(active.errors)) + ' ' + fc + '</div>' +
        (isAuto ? '<div class="osu-res-pb">Autoplay preview — not saved.</div>'
                : (prev ? '<div class="osu-res-pb">Previous best: ' + prev.accuracy.toFixed(2) + '%' + (improved ? ' — <b>new best!</b>' : '') + '</div>'
                        : '<div class="osu-res-pb">First clear — saved as your best.</div>'));
      if (run !== active) return;
      show('results');
      window.ActivityReplay?.mount(resultsBody, active);
    }
    function quitToSelect() { loadGen++; teardownRun(); if (deps.resumeBgm) deps.resumeBgm(); show('select'); renderSongList(); }

    // ---- Calibration (tap-to-the-beat metronome → osuCalibrationOffset) -------
    let calibLoop = null, calibTiming = null, tapState = null;
    function tapReset() {
      tapState = null;
      if (tapResultEl) tapResultEl.textContent = '';
      if (tapBtn) tapBtn.textContent = 'Tap to the beat';
    }
    function registerTap(perfTs) {
      if (!tapState) return;
      const tapCtx = R.createClock(audioCtx,0).at(R.eventTime(perfTs)) / 1000;
      const k = Math.round((tapCtx - tapState.baseTick) / tapState.period);
      if (k < 0) return;                                   // before the first beat
      const beat = tapState.baseTick + k * tapState.period;
      const errMs = (tapCtx - beat) * 1000;       // vs the HEARD beep (same shift as gameplay)
      if (Math.abs(errMs) > tapState.period * 1000 / 2) return;   // not near any beat
      tapState.errors.push(errMs);
      const need = 12;
      if (tapBtn) tapBtn.textContent = 'Tap! (' + tapState.errors.length + '/' + need + ')';
      if (tapState.errors.length >= need) finishTapCalibration();
    }
    function finishTapCalibration() {
      const e = tapState.errors.slice().sort((a, b) => a - b);
      const trimmed = e.slice(1, e.length - 1);            // drop the worst outlier each side
      const mean = trimmed.reduce((a, b) => a + b, 0) / (trimmed.length || 1);
      const offset = Math.round(mean);
      settings.osuCalibrationOffset = offset;
      if (deps.saveSettings) deps.saveSettings();
      if (calibSlider) calibSlider.value = offset;
      if (calibValEl) calibValEl.textContent = offset + ' ms';
      if (tapResultEl) tapResultEl.textContent = 'Your offset: ' + offset + ' ms (set). Tap again to redo.';
      tapState = null;
      if (tapBtn) tapBtn.textContent = 'Tap to the beat';
    }
    function onTapButton(perfTs) {
      if (!calibTiming) return;
      if (!tapState) tapState = { baseTick: calibTiming.baseTick, period: calibTiming.period, tc0: calibTiming.tc0, tp0: calibTiming.tp0, errors: [] };
      registerTap(perfTs);
    }
    function openCalibration() {
      show('calib'); tapReset();
      if (calibSlider) { calibSlider.value = calOffset(); if (calibValEl) calibValEl.textContent = calOffset() + ' ms'; }
      ensureCtx().then((ac) => {
        const cctx = calibCanvas ? calibCanvas.getContext('2d') : null;
        const period = 0.6;                       // 100 BPM metronome
        const baseTick = ac.currentTime + 0.2;    // first beep; flash phase is anchored here
        calibTiming = { baseTick: baseTick, period: period, tc0: ac.currentTime, tp0: performance.now() };
        let nextTick = baseTick;
        function tick() {
          if (!calibTiming) return;               // closed mid-loop
          while (nextTick < ac.currentTime + 0.1) {
            const o = ac.createOscillator(), gg = ac.createGain();
            o.frequency.value = 1200;
            gg.gain.setValueAtTime(0.0001, nextTick);
            gg.gain.exponentialRampToValueAtTime(0.4, nextTick + 0.001);
            gg.gain.exponentialRampToValueAtTime(0.0001, nextTick + 0.05);
            o.connect(gg).connect(ac.destination);
            o.start(nextTick); o.stop(nextTick + 0.06);
            nextTick += period;
          }
          if (cctx) {
            // Phase from the HEARD beep (baseTick + output latency), with calOffset
            // applied — same shift as gameplay; wrap negatives into [0,period).
            const rel = R.createClock(ac,baseTick).at() / 1000 - calOffset() / 1000;
            const phase = (((rel % period) + period) % period) / period;
            const flash = phase < 0.12 ? 1 : 0;
            cctx.clearRect(0, 0, calibCanvas.width, calibCanvas.height);
            cctx.fillStyle = flash ? '#39d98a' : '#1a1c22';
            cctx.beginPath(); cctx.arc(calibCanvas.width / 2, calibCanvas.height / 2, 40, 0, Math.PI * 2); cctx.fill();
          }
          calibLoop = requestAnimationFrame(tick);
        }
        tick();
      });
    }
    function closeCalibration() {
      if (calibLoop) cancelAnimationFrame(calibLoop);
      calibLoop = null; calibTiming = null; tapReset(); show('select');
    }

    // ---- Open / close (called by app.js applyMode) ---------------------------
    function open() {
      panel.classList.add('open'); panelOpen = true;
      if (deps.captureKeyboard) deps.captureKeyboard(true);
      show('select'); refreshLibrary(); renderKeybinds(); renderSkinPicker();
      if (!skin) loadCachedSkin(); else renderSkinStatus();
      restoreFolder();   // re-walk a remembered osu! folder so the library survives reloads (standalone)
    }
    function close() {
      loadGen++; if (run && !run.finished) quitToSelect();
      if (calibLoop) { cancelAnimationFrame(calibLoop); calibLoop = null; calibTiming = null; tapState = null; }
      revokeThumbs();
      panel.classList.remove('open'); window.UIMotion?.clear(panel); panelOpen = false;
      selector?.close();
      if (deps.captureKeyboard) deps.captureKeyboard(false);
      if (deps.resumeBgm) deps.resumeBgm();
      if (settings.gameMode === 'osu') { settings.gameMode = 'clicker'; if (deps.saveSettings) deps.saveSettings(); window.dispatchEvent(new CustomEvent('gamemodechange')); }
    }

    if (songlistEl && !selector) songlistEl.addEventListener('click', (e) => {
      const diff = e.target.closest('.osu-diff');
      if (diff) { const entry = library[Number(diff.getAttribute('data-i'))]; if (entry) loadAndPlay(entry); return; }
      const head = e.target.closest('.osu-group');
      if (!head) return;
      const g = currentGroups[Number(head.getAttribute('data-g'))]; if (!g) return;
      if (g.items.length === 1) { loadAndPlay(g.items[0].entry); return; }   // single diff → play directly
      expandedKey = (expandedKey === g.key) ? null : g.key;                  // accordion toggle
      renderSongList();
    });
    if (exitBtn) exitBtn.addEventListener('click', () => close());
    if (retryBtn) retryBtn.addEventListener('click', () => { if (run && run.entry) loadAndPlay(run.entry); else if (library[0]) loadAndPlay(library[0]); });
    if (backBtn) backBtn.addEventListener('click', quitToSelect);
    if (skipBtn) skipBtn.addEventListener('click', doSkip);
    if (importBtn) importBtn.addEventListener('click', () => importOsuFolder());
    if (importInput) importInput.addEventListener('change', () => handleImportFiles(importInput.files));
    const syncBtn = document.getElementById('osu-sync');
    if (syncBtn) syncBtn.addEventListener('click', () => syncSongs());
    const skinPickerEl = document.getElementById('osu-skin-picker');
    if (skinPickerEl) skinPickerEl.addEventListener('click', (e) => {
      const b = e.target.closest('.osu-skin-pick'); if (!b) return;
      const d = availableSkins[Number(b.getAttribute('data-si'))]; if (d) loadSkinDir(d);
    });
    if (oszBtn) oszBtn.addEventListener('click', () => { if (oszInput) { oszInput.value = ''; oszInput.click(); } });
    if (oszInput) oszInput.addEventListener('change', () => handleOszFiles(oszInput.files));
    if (skinBtn) skinBtn.addEventListener('click', () => { if (skinOskInput) { skinOskInput.value = ''; skinOskInput.click(); } });
    if (skinOskInput) skinOskInput.addEventListener('change', () => handleSkinOsk(skinOskInput.files[0]));
    const skinDirBtn = document.getElementById('osu-import-skin-dir');
    const skinDirInput = document.getElementById('osu-skin-dir-input');
    if (skinDirBtn && skinDirInput) {
      skinDirBtn.addEventListener('click', () => { skinDirInput.value = ''; skinDirInput.click(); });
      skinDirInput.addEventListener('change', () => handleSkinDir(skinDirInput.files));
    }
    if (skinClearBtn) skinClearBtn.addEventListener('click', () => clearSkin());
    const sortEl = document.getElementById('osu-sort');
    if (sortEl) {
      sortEl.value = settings.osuSortBy || 'title';
      sortEl.addEventListener('change', () => { settings.osuSortBy = sortEl.value; if (deps.saveSettings) deps.saveSettings(); renderSongList(); });
    }
    if (autoBtn) autoBtn.addEventListener('click', () => { autoplay = !autoplay; autoBtn.classList.toggle('on', autoplay); autoBtn.dataset.i18n = autoplay ? 'rhythm.auto_on' : 'rhythm.auto_off'; autoBtn.textContent = window.I18N.t(autoBtn.dataset.i18n); });
    if (hitsoundBtn) hitsoundBtn.addEventListener('click', () => { show('hitsound'); if (window.Hitsound) window.Hitsound.renderControls(hsControlsEl); });
    if (hitsoundDoneBtn) hitsoundDoneBtn.addEventListener('click', () => show('select'));
    function syncVisualControls() {
      if (cursorSizeEl) { cursorSizeEl.value = cursorScale(); if (cursorSizeVal) cursorSizeVal.textContent = cursorScale().toFixed(1) + '×'; }
      if (bgDimEl) { const d = isNaN(Number(settings.osuBgDim)) ? 80 : Number(settings.osuBgDim); bgDimEl.value = d; if (bgDimVal) bgDimVal.textContent = d + '%'; }
    }
    if (visualBtn) visualBtn.addEventListener('click', () => { syncVisualControls(); show('visual'); });
    if (visualDoneBtn) visualDoneBtn.addEventListener('click', () => show('select'));
    if (cursorSizeEl) cursorSizeEl.addEventListener('input', (e) => { settings.osuCursorScale = Number(e.target.value); if (cursorSizeVal) cursorSizeVal.textContent = Number(e.target.value).toFixed(1) + '×'; if (deps.saveSettings) deps.saveSettings(); });
    if (bgDimEl) bgDimEl.addEventListener('input', (e) => { settings.osuBgDim = Number(e.target.value); if (bgDimVal) bgDimVal.textContent = e.target.value + '%'; if (deps.saveSettings) deps.saveSettings(); });
    if (calibrateBtn) calibrateBtn.addEventListener('click', openCalibration);
    if (calibDoneBtn) calibDoneBtn.addEventListener('click', closeCalibration);
    if (tapBtn) tapBtn.addEventListener('click', (e) => onTapButton(e.timeStamp));
    if (calibSlider) calibSlider.addEventListener('input', (e) => {
      settings.osuCalibrationOffset = Number(e.target.value);
      if (calibValEl) calibValEl.textContent = settings.osuCalibrationOffset + ' ms';
      if (deps.saveSettings) deps.saveSettings();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ' && panelOpen && screens.calib && !screens.calib.hidden) { e.preventDefault(); onTapButton(e.timeStamp); return; }
      if (e.key !== 'Escape' || !panelOpen) return;
      if (run && !run.finished) return;
      if (screens.calib && !screens.calib.hidden) { closeCalibration(); return; }
      if (screens.hitsound && !screens.hitsound.hidden) { show('select'); return; }
      if (screens.visual && !screens.visual.hidden) { show('select'); return; }
      if (screens.results && !screens.results.hidden) { quitToSelect(); return; }
      close();
    });
    window.addEventListener('resize', () => { if (run && !run.finished) sizeCanvas(); });
    if (canvas) { canvas.setAttribute('tabindex', '0'); canvas.style.outline = 'none'; canvas.style.cursor = 'none'; canvas.addEventListener('contextmenu', (e) => e.preventDefault()); }
    if (panel) panel.addEventListener('pointerdown', () => { if (run && !run.finished && !run.paused) grabFocus(); });

    function reportMultiplayer(state) {
      if (!run || !run.multiplayer) return;
      const c = run.counts, callback = run.multiplayer.onScore;
      run.mpLastReport = performance.now();
      const stats = {score: 300*c.h300 + 100*c.h100 + 50*c.h50, combo: run.maxCombo, acc: accuracy(), state};
      if (state === 'forfeit') run.activityRun = null;
      if (state !== 'playing') run.multiplayer = null;
      try { callback(stats); } catch (_) { /* network failures never break single-player */ }
    }
    api.prepareMultiplayer = async function(hash) {
      if (!panelOpen || loading) throw new Error('game_busy');
      if (run && !run.finished) {
        if (run.multiplayer || !run.paused) throw new Error('game_busy');
        // Ready explicitly replaces a forfeited, paused local attempt for the next round.
        teardownRun(); show('select');
      }
      const ac = await ensureCtx();
      if (ac.state !== 'running') throw new Error('audio_suspended');
      selector?.stop();
      const rec = await api.getChartRecord(hash);
      if (!rec) throw new Error('missing_map');
      const chart = assembleChart(rec.osuText);
      const entry = makeEntry('osz', rec.osuText, chart, async () => rec.osuText,
        async () => rec.audio.slice().buffer, async () => rec.art ? new Blob([rec.art]) : null, async () => rec.samples || []);
      const [audioBuf, samples] = await Promise.all([ac.decodeAudioData(await entry.getAudio()), window.Hitsound.prepare(ac, rec.samples || [])]);
      return {entry, chart, audioBuf, samples};
    };
    api.startMultiplayer = function(prepared, options) {
      if (!panelOpen || !prepared || audioCtx.state !== 'running' || options.startAt - performance.now() < 100 || options.startAt - performance.now() > 15000) throw new Error('missed_start');
      loadGen++;
      startRun(prepared.entry, prepared.chart, prepared.audioBuf, options);
      run.samples = prepared.samples;
    };
    api.detachMultiplayer = function() { if (run) run.multiplayer = null; };

    api.open = open; api.close = close;
    // Cross-mode hooks (called by vsrg.js when a mania-side import finds standard
    // charts, or a skin to apply): store Mode-0 charts / load a .osk skin here.
    api.importForeignCharts = async function (records) {
      if (!records || !records.length) return 0;
      let n = 0;
      for (const r of records) {
        let chart; try { chart = assembleChart(r.osuText); } catch (e) { continue; }   // accept Mode-0 only
        const hash = await sha256(r.osuText);
        await idbPut('osz', hash, { title: chart.title, artist: chart.artist, diffName: chart.diffName, stars: chart.stars, length: chart.length, hash: hash, osuText: r.osuText, audio: r.audio, art: r.art || null, samples: r.samples || [], origin: r.origin || { type: 'imported' } });
        n++;
      }
      if (n && panelOpen) await refreshLibrary();
      return n;
    };
    api.hasChart = async function (hash) {
      return chartSources.has(hash) || !!(await idbGet('osz', hash));
    };
    api.getChartRecord = async function (hash) {
      // A live folder library also works when persistent browser storage is unavailable.
      let stored;try { stored = await idbGet('osz', hash); } catch (_) {}
      if (stored) return stored;
      const entry = chartSources.get(hash);
      if (!entry) return null;
      const osuText = await entry.getOsuText();
      if (await sha256(osuText) !== hash) throw new Error('map_changed');
      const [audio, art, samples] = await Promise.all([entry.getAudio(), entry.getArt?.(), entry.getSamples?.()]);
      return {hash, osuText, title:entry.title, artist:entry.artist, diffName:entry.diffName,
        stars:entry.stars, length:entry.length, audio:new Uint8Array(audio),
        art:art ? new Uint8Array(await art.arrayBuffer()) : null, samples:samples || []};
    };
    api.listCharts = async function () {
      await refreshLibrary();
      return [...chartSources].map(([hash,r]) => ({hash,title:r.title,artist:r.artist,diffName:r.diffName,stars:r.stars,length:r.length}));
    };
    api.importSkinFile = function (file) { return handleSkinOsk(file); };
    api.importSkinFromFolder = async function (fileList) {   // auto-load a skin from a picked folder
      const dirs = findSkinDirs(fileList);
      if (!dirs.length) return null;
      await loadSkinDir(dirs[0]);
      return skin ? skin.name : null;
    };
  }

  // ---- Minimal IndexedDB (osu!standard personal bests) ----------------------
  let _db = null;
  function idb() {
    if (_db) return _db;
    _db = new Promise((res, rej) => {
      const req = indexedDB.open('aobing-osustd', 4);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('osu-pb')) db.createObjectStore('osu-pb');   // personal bests
        if (!db.objectStoreNames.contains('osz')) db.createObjectStore('osz');          // imported .osz maps
        if (!db.objectStoreNames.contains('skin')) db.createObjectStore('skin');        // active custom skin
        if (!db.objectStoreNames.contains('fs')) db.createObjectStore('fs');            // persisted osu! folder handle (FS Access API)
      };
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });
    return _db;
  }
  function idbPut(store, key, val) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }
  function idbGet(store, key) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const r = tx.objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); }
  function idbGetAll(store) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const r = tx.objectStore(store).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); })); }
  function idbDelete(store, key) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }

  window.OsuStdGame = api;
  if (window.__osustdDeps) initBrowser(window.__osustdDeps);
}

})();
