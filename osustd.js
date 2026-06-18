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
  const od = parseFloat(d.OverallDifficulty);
  const arRaw = d.ApproachRate;
  return {
    audioFile: g.AudioFilename || '',
    mode: parseInt(g.Mode, 10),
    title: m.Title || '', artist: m.Artist || '', diffName: m.Version || '',
    cs: parseFloat(d.CircleSize),
    od: od,
    ar: (arRaw == null || arRaw === '') ? od : parseFloat(arRaw),
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
    if (type & 1) {
      out.push({ kind: 'circle', x: x, y: y, time: time, newCombo: newCombo });
    } else if (type & 2) {
      const seg = String(p[5] || '').split('|');
      const curveType = seg[0] || 'L';
      const points = [{ x: x, y: y }];
      for (let i = 1; i < seg.length; i++) {
        const xy = seg[i].split(':');
        points.push({ x: parseFloat(xy[0]), y: parseFloat(xy[1]) });
      }
      out.push({
        kind: 'slider', x: x, y: y, time: time, newCombo: newCombo,
        curveType: curveType, points: points,
        slides: parseInt(p[6], 10) || 1, length: parseFloat(p[7]) || 0,
      });
    } else if (type & 8) {
      out.push({ kind: 'spinner', time: time, endTime: parseInt(p[5], 10), newCombo: newCombo });
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
  return arcResample(densePath(curveType, points), length, spacing || 5);
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
  const objects = raw.map((o) => {
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
  return {
    audioFile: meta.audioFile, title: meta.title, artist: meta.artist, diffName: meta.diffName,
    cs: meta.cs, od: meta.od, ar: meta.ar,
    sliderMultiplier: meta.sliderMultiplier, sliderTickRate: meta.sliderTickRate,
    backgroundFile: parseBackground((s.Events || []).join('\n')),
    timingPoints: timing,
    objects: objects,
  };
}

// =========================================================================
// Exports
// =========================================================================
const ENGINE = {
  OSUSTD_ENGINE: true,
  splitSections: splitSections,
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
};

if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
if (typeof window !== 'undefined') window.OsuStdEngine = ENGINE;

// =========================================================================
// Browser wiring — window.OsuStdGame.init(deps). Playfield + cursor + circles.
// Sliders/spinners are parsed and drawn as simple placeholders here (Phase 2);
// full slider/spinner judgement lands in later phases.
// =========================================================================
if (typeof document !== 'undefined') {
  const api = { init: initBrowser };
  const COMBO_COLORS = ['#ffd166', '#56a0ff', '#39d98a', '#ff7eb6', '#b06bff'];
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
    };
    const songlistEl = document.getElementById('osu-songlist');
    const keybindsEl = document.getElementById('osu-keybinds');
    const hitsoundBtn = document.getElementById('osu-hitsound-btn');
    const hitsoundDoneBtn = document.getElementById('osu-hitsound-done');
    const hsControlsEl = document.getElementById('osu-hs-controls');
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
    const resultsBody = document.getElementById('osu-results-body');
    const retryBtn = document.getElementById('osu-retry');
    const backBtn = document.getElementById('osu-back');

    let audioCtx = null, panelOpen = false, library = [], run = null, loading = false, loadGen = 0;
    let fpsFrames = 0, fpsLast = 0, fpsPrev = 0, fpsMaxDt = 0;   // FPS + frametime accumulators (rhythm runs as fast as rAF allows)
    let currentGroups = [], expandedKey = null;       // song-select accordion (one open group at a time)
    let cursor = { x: PLAY_W / 2, y: PLAY_H / 2 };   // in osu!px
    let trail = [];                                   // recent cursor positions (osu!px) for a trail
    let bursts = [];                                  // hit feedback at the circle: { x, y, result, t }
    let errTicks = [];                                // recent signed hit errors for the live error bar
    let localEntries = [];                            // maps imported this session (folder; not persisted)
    let skin = null;                                  // active custom osu! skin (null = built-in look)
    const tintCache = new Map();                      // memoised combo-colour-tinted sprites

    function calOffset() { return Number(settings.osuCalibrationOffset) || 0; }   // osu!standard's own offset
    // Unstable rate = stdev of signed hit errors × 10 (osu definition); the error
    // bar + UR readout mirror osu!mania's. recordError feeds both.
    function unstableRate(errs) {
      if (!errs || errs.length < 2) return 0;
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      const v = errs.reduce((s, e) => s + (e - mean) * (e - mean), 0) / errs.length;
      return Math.sqrt(v) * 10;
    }
    function recordError(errMs, result) {
      if (run) run.errors.push(errMs);
      errTicks.push({ err: errMs, result: result, t: performance.now() });
      if (errTicks.length > 64) errTicks.shift();
    }
    function playHitsound() { if (window.Hitsound && audioCtx) window.Hitsound.play(audioCtx); }   // shared engine (hitsound.js)
    // Combo colours come from the loaded skin's skin.ini [Colours] when present,
    // otherwise the built-in palette (matches osu's per-combo colour cycling).
    function comboColors() { return (skin && skin.colors && skin.colors.length) ? skin.colors : COMBO_COLORS; }
    function show(name) { for (const k in screens) if (screens[k]) screens[k].hidden = (k !== name); }
    function grabFocus() { try { window.focus(); } catch (e) {} try { canvas.focus({ preventScroll: true }); } catch (e) {} }

    function ensureCtx() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
            id: 'bundled:' + m.id, title: chart.title, artist: chart.artist, diffName: chart.diffName,
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
      return Array.from(map.values());
    }
    function renderSongList() {
      if (!songlistEl) return;
      if (!library.length) { songlistEl.innerHTML = '<div class="osu-empty">No songs yet.</div>'; return; }
      currentGroups = buildGroups();
      if (expandedKey && !currentGroups.some((g) => g.key === expandedKey)) expandedKey = null;
      songlistEl.innerHTML = currentGroups.map((g, gi) => {
        const single = g.items.length === 1;
        const open = !single && g.key === expandedKey;
        const caret = single ? '▸' : (open ? '▾' : '▸');
        const head =
          '<button class="osu-group' + (open ? ' open' : '') + '" data-g="' + gi + '">' +
            '<span class="osu-group-caret">' + caret + '</span>' +
            '<span class="osu-group-info"><span class="osu-song-title">' + escapeH(g.title) + '</span>' +
            '<span class="osu-song-meta">' + escapeH(g.artist || '(unknown)') + ' · ' +
              g.items.length + ' ' + (single ? 'difficulty' : 'difficulties') + '</span></span>' +
          '</button>';
        const diffs = open
          ? '<div class="osu-group-diffs">' + g.items.map((it) =>
              '<button class="osu-song osu-diff" data-i="' + it.i + '">' + escapeH(it.entry.diffName || '(difficulty)') + '</button>'
            ).join('') + '</div>'
          : '';
        return '<div class="osu-group-wrap">' + head + diffs + '</div>';
      }).join('');
    }
    async function refreshLibrary() {
      const bundled = await loadBundled();
      let cached = [];
      try { cached = await loadCachedOsz(); } catch (e) {}
      library = bundled.concat(cached).concat(localEntries);
      renderSongList();
    }

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

    function importFolder() {
      if (!importInput) { setImportStatus('Folder import unavailable in this browser.'); return; }
      importInput.value = ''; importInput.click();
    }
    async function handleImportFiles(fileList) {
      if (!fileList || !fileList.length) return;
      try {
        setImportStatus('Scanning…');
        const res = await scanFileList(fileList, (n) => setImportStatus('Scanning… ' + n + ' .osu seen'));
        localEntries = res.entries;
        const mania = await routeForeign(res.foreign);   // mania charts → the Mania library
        await refreshLibrary();
        const maniaNote = mania ? ' · ' + mania + ' mania → Mania' : '';
        setImportStatus(res.entries.length
          ? ('Imported ' + res.entries.length + ' standard map(s)' + maniaNote + ' from ' + res.scanned + ' .osu scanned (re-import after reload).')
          : ((mania ? mania + ' mania map(s) → Mania' : 'No osu! maps') + ' in ' + res.scanned + ' .osu scanned.'));
        // The same folder may also contain skins (e.g. an osu! install's Skins/).
        // Auto-load the most complete one; note any others.
        const skinDirs = findSkinDirs(fileList);
        if (skinDirs.length) {
          await loadSkinDir(skinDirs[0]);
          if (skin && skinDirs.length > 1 && skinStatusEl) setSkinStatus(skinStatusEl.textContent + ' (+' + (skinDirs.length - 1) + ' more skin folder(s) found)');
        }
      } catch (e) { setImportStatus('Import failed: ' + ((e && e.message) || e)); }
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
    async function buildForeign(osuText, getU8) {
      const meta = parseStdMeta(osuText);
      const audio = await getU8(String(meta.audioFile).toLowerCase());
      if (!audio) return null;
      const bg = parseBackground((splitSections(osuText).Events || []).join('\n'));
      const art = bg ? await getU8(bg.toLowerCase()) : null;
      return { osuText: osuText, audio: audio, art: art || null };
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
        const getU8 = async (nm) => { const f = files.get(nm); return f ? new Uint8Array(await f.arrayBuffer()) : null; };
        for (const [name, f] of files) {
          if (!name.endsWith('.osu')) continue;
          scanned++; if (onProgress && scanned % 40 === 0) onProgress(scanned);
          let osuText; try { osuText = await f.text(); } catch (e) { continue; }
          let chart;
          try { chart = assembleChart(osuText); }
          catch (e) {   // not osu!standard — collect for mania routing instead of dropping it
            try { const rec = await buildForeign(osuText, getU8); if (rec) foreign.push(rec); } catch (_) {}
            continue;
          }
          const audio = files.get(String(chart.audioFile).toLowerCase()); if (!audio) continue;
          const art = chart.backgroundFile ? (files.get(chart.backgroundFile.toLowerCase()) || null) : null;
          out.push(makeEntry('local', osuText, chart, () => f.text(), () => audio.arrayBuffer(), () => Promise.resolve(art)));
        }
      }
      return { entries: out, scanned: scanned, foreign: foreign };
    }
    function makeEntry(source, osuText, chart, getOsuText, getAudio, getArt) {
      return { id: source + ':' + chart.title + ':' + chart.diffName, source: source,
        title: chart.title, artist: chart.artist, diffName: chart.diffName,
        getOsuText: getOsuText, getAudio: getAudio, getArt: getArt };
    }

    async function handleOszFiles(fileList) {
      if (!fileList || !fileList.length) return;
      let imported = 0, scanned = 0; const foreign = [];
      try {
        for (const file of fileList) {
          setImportStatus('Reading ' + file.name + '…');
          let entries; try { entries = await unzip(await file.arrayBuffer()); } catch (e) { continue; }
          const byName = new Map();
          for (const [nm, bytes] of entries) byName.set(nm.toLowerCase().split('/').pop(), bytes);
          const getU8 = (nm) => byName.get(nm) || null;
          for (const [nm, bytes] of entries) {
            if (!nm.toLowerCase().endsWith('.osu')) continue;
            scanned++;
            const osuText = new TextDecoder().decode(bytes); let chart;
            try { chart = assembleChart(osuText); }
            catch (e) {   // not osu!standard — collect for mania routing instead of dropping it
              try { const rec = await buildForeign(osuText, getU8); if (rec) foreign.push(rec); } catch (_) {}
              continue;
            }
            const audio = byName.get(String(chart.audioFile).toLowerCase()); if (!audio) continue;
            const art = chart.backgroundFile ? (byName.get(chart.backgroundFile.toLowerCase()) || null) : null;
            const hash = await sha256(osuText);
            await idbPut('osz', hash, { title: chart.title, artist: chart.artist, diffName: chart.diffName, hash: hash, osuText: osuText, audio: audio, art: art });
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
        () => Promise.resolve(s.audio.slice().buffer), () => Promise.resolve(s.art ? new Blob([s.art]) : null)));
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
      renderSkinStatus();
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
      const ck = key + '|' + color;
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
    function drawSkinNumber(sc, number, rad) {
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
      run.finished = true;
      cancelAnimationFrame(run.rafId);
      bindInput(false);
      try { run.src.stop(); } catch (e) {}
      run = null;
      if (fpsEl) fpsEl.textContent = '';
    }
    async function loadAndPlay(entry) {
      if (loading) return;
      loading = true; const gen = ++loadGen; teardownRun(); run = null;
      try {
        const osuText = await entry.getOsuText();
        const chart = assembleChart(osuText);
        const ac = await ensureCtx();
        const audioBuf = await ac.decodeAudioData(await entry.getAudio());
        if (gen !== loadGen || !panelOpen) return;
        startRun(entry, chart, audioBuf);
      } catch (e) { try { console.error('[osustd] load', e); } catch (_) {} }
      finally { loading = false; }
    }

    function startRun(entry, chart, audioBuf) {
      teardownRun();
      if (deps.pauseBgm) deps.pauseBgm();
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
          st.headJudged = false; st.headResult = null; st.checkpoints = buildSliderCheckpoints(o, chart);
        }
        if (o.kind === 'spinner') {
          const dur = o.endTime - o.time;
          const rps = 2 + (chart.od || 5) * 0.2;          // required spins/sec scales with OD
          st.requiredRad = (dur / 1000) * rps * 2 * Math.PI;
          st.rot = 0; st.lastAngle = null;
        }
        return st;
      });
      const startCtx = ac.currentTime + LEAD_IN_MS / 1000;
      const src = ac.createBufferSource();
      const gain = ac.createGain();
      gain.gain.value = Math.max(0, Math.min(1, (Number(settings.musicVol) || 0) / 100)) || 0.6;
      src.buffer = audioBuf; src.connect(gain).connect(ac.destination); src.start(startCtx);
      const lastTime = chart.objects.reduce((m, o) => Math.max(m, o.endTime || o.time), 0);
      run = {
        entry: entry, chart: chart, objs: objs, src: src, gain: gain, startCtx: startCtx,
        t0perf: performance.now(), t0ctx: ac.currentTime,
        preempt: preempt, fadeIn: fadeIn, radius: radius, windows: windows,
        counts: { h300: 0, h100: 0, h50: 0, miss: 0 }, combo: 0, maxCombo: 0,
        lastTime: lastTime, finished: false, rafId: 0, artImg: null, pressed: {},
        errors: [],   // signed hit-timing errors (ms, +late/-early) for UR + the error bar
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
      bindInput(true);
      run.rafId = requestAnimationFrame(loop);
      updateHud();
    }

    // Both the rendered song time and the judged tap time are measured against the
    // audio the user actually HEARS, i.e. shifted back by the output latency. This
    // makes the default feel right across devices; calOffset is then a small
    // personal fine-tune rather than a per-device latency band-aid.
    function songTimeNow() { return (audioCtx.currentTime - run.startCtx - audioLatency()) * 1000; }
    function inputSongTime(perfTs) {
      const ctxAtInput = run.t0ctx + (perfTs - run.t0perf) / 1000;
      return (ctxAtInput - run.startCtx - audioLatency()) * 1000 - calOffset();
    }

    function loop() {
      if (!run || run.finished) return;
      const st = songTimeNow();
      updateSliders(st);
      updateSpinners(st);
      sweepMisses(st);
      render(st);
      tickFps();
      if (st > run.lastTime + END_PAD_MS) { finishRun(); return; }
      run.rafId = requestAnimationFrame(loop);
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
        if (st >= o.time && st <= o.endTime) {
          const ang = Math.atan2(cursor.y - PLAY_H / 2, cursor.x - PLAY_W / 2);
          if (s.lastAngle !== null) {
            let d = ang - s.lastAngle;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            s.rot += Math.abs(d);
          }
          s.lastAngle = ang;
        }
        if (st > o.endTime) {
          const p = s.requiredRad > 0 ? s.rot / s.requiredRad : 1;
          const result = p >= 1 ? 'h300' : p >= 0.9 ? 'h100' : p >= 0.5 ? 'h50' : 'miss';
          s.judged = true; s.result = result;
          const c = run.counts;
          if (result === 'miss') { c.miss++; run.combo = 0; }
          else { c[result]++; run.combo++; run.maxCombo = Math.max(run.maxCombo, run.combo); }
          bursts.push({ x: PLAY_W / 2, y: PLAY_H / 2, result: result, t: performance.now() });
          flashJudge(result); updateHud();
        }
      }
    }

    // ---- Sliders -------------------------------------------------------------
    function buildSliderCheckpoints(o, chart) {
      const tm = timingAt(chart.timingPoints, o.time);
      const tickSpacing = Math.max(60, tm.beatLength / (chart.sliderTickRate || 1));
      const pts = [];
      for (let span = 0; span < o.slides; span++) {
        const spanStart = o.time + span * o.spanDuration;
        const reverse = (span % 2) === 1;
        for (let t = tickSpacing; t < o.spanDuration - 10; t += tickSpacing) {
          const fr = reverse ? 1 - t / o.spanDuration : t / o.spanDuration;
          pts.push({ time: spanStart + t, frac: fr, kind: 'tick', hit: false, ev: false });
        }
        pts.push({ time: spanStart + o.spanDuration, frac: reverse ? 0 : 1,
          kind: span === o.slides - 1 ? 'tail' : 'repeat', hit: false, ev: false });
      }
      return pts;
    }
    function pointAtFrac(path, frac) {
      if (!path.length) return { x: 0, y: 0 };
      const f = Math.max(0, Math.min(1, frac)) * (path.length - 1);
      const i = Math.floor(f), t = f - i;
      const a = path[i], b = path[Math.min(path.length - 1, i + 1)];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    function sliderBallPos(o, st) {
      let local = st - o.time; if (local < 0) local = 0;
      let span = Math.floor(local / o.spanDuration);
      if (span >= o.slides) span = o.slides - 1;
      let fr = (local - span * o.spanDuration) / o.spanDuration;
      if ((span % 2) === 1) fr = 1 - fr;
      return pointAtFrac(o.path, fr);
    }
    function heldAny() { return !!(run.pressed.z || run.pressed.x || run.pressed.mouse); }

    function updateSliders(st) {
      const followR = run.radius * 2.4;
      for (const s of run.objs) {
        if (s.o.kind !== 'slider' || s.judged) continue;
        const o = s.o;
        if (!s.headJudged && st > o.time + run.windows.h50) { s.headJudged = true; s.headResult = 'miss'; run.combo = 0; updateHud(); }
        if (st >= o.time && st <= o.endTime + 30) {
          const ball = sliderBallPos(o, st);
          s.following = heldAny() && dist(cursor, ball) <= followR;
          for (const cp of s.checkpoints) if (!cp.ev && st >= cp.time) { cp.ev = true; cp.hit = s.following; }
        }
        if (st > o.endTime + 30) {
          for (const cp of s.checkpoints) if (!cp.ev) { cp.ev = true; cp.hit = false; }
          finalizeSlider(s);
        }
      }
    }
    function finalizeSlider(s) {
      const headOk = (s.headJudged && s.headResult !== 'miss') ? 1 : 0;
      const collected = headOk + s.checkpoints.filter((c) => c.hit).length;
      const total = 1 + s.checkpoints.length;
      const frac = total ? collected / total : 0;
      const result = frac >= 1 ? 'h300' : frac >= 0.5 ? 'h100' : frac > 0 ? 'h50' : 'miss';
      s.judged = true; s.result = result;
      const c = run.counts;
      if (result === 'miss') { c.miss++; run.combo = 0; }
      else { c[result]++; run.combo++; run.maxCombo = Math.max(run.maxCombo, run.combo); }
      bursts.push({ x: s.o.x, y: s.o.y, result: result, t: performance.now() });
      flashJudge(result); updateHud();
    }

    function judgeResult(s, result) {
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
      if (!run || run.finished) return;
      const st = inputSongTime(perfTs);
      // earliest object whose head is still unhit, within the catchable window
      let best = null;
      for (const s of run.objs) {
        const o = s.o;
        if (o.kind === 'spinner') continue;
        const headDone = o.kind === 'circle' ? s.judged : s.headJudged;
        if (headDone) continue;
        if (st < o.time - run.windows.h50) break;            // next ones are later — too early
        if (st <= o.time + run.windows.h50) { best = s; break; }
      }
      if (!best) return;
      // cursor must be over the head
      if (dist(cursor, { x: best.o.x, y: best.o.y }) > run.radius) return;   // missed aim
      const signed = st - best.o.time;                     // +late / -early
      const err = Math.abs(signed);
      const w = run.windows;
      const result = err <= w.h300 ? 'h300' : err <= w.h100 ? 'h100' : 'h50';
      recordError(signed, result);                         // feeds the UR + error bar (heads only, like osu)
      playHitsound();
      if (best.o.kind === 'slider') { best.headJudged = true; best.headResult = result; }  // body/tail scored later
      else judgeResult(best, result);
    }
    function bindInput(on) {
      const fn = on ? 'addEventListener' : 'removeEventListener';
      canvas[fn]('pointermove', onPointerMove);
      canvas[fn]('pointerdown', onPointerDown);
      canvas[fn]('pointerup', onPointerUp);
      canvas[fn]('pointercancel', onPointerUp);
      window[fn]('keydown', onKeyDown);
    }
    function onPointerMove(e) { updateCursorFromEvent(e); }
    function onPointerDown(e) { e.preventDefault(); grabFocus(); updateCursorFromEvent(e); if (run) run.pressed.mouse = true; onTap(e.timeStamp); }
    function onPointerUp(e) { if (run) run.pressed.mouse = false; }
    function tapKeys() {
      const k = settings.osuKeys;
      return (Array.isArray(k) && k.length) ? k.map((x) => String(x).toLowerCase()) : ['z', 'x'];
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
    function onKeyDown(e) {
      if (!run || run.finished) return;
      if (e.key === 'Escape') { quitToSelect(); return; }
      const k = e.key.toLowerCase();
      if (tapKeys().indexOf(k) >= 0) { if (run.pressed[k]) return; run.pressed[k] = true; e.preventDefault(); onTap(e.timeStamp); }
    }
    window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); if (run) run.pressed[k] = false; });

    // ---- Render --------------------------------------------------------------
    function accuracy() {
      const c = run.counts, total = c.h300 + c.h100 + c.h50 + c.miss;
      if (!total) return 100;
      return Math.round(((300 * c.h300 + 100 * c.h100 + 50 * c.h50) / (300 * total)) * 10000) / 100;
    }
    function render(st) {
      const W = canvas.width, H = canvas.height, dpr = window.devicePixelRatio || 1;
      const tf = transform();
      g.clearRect(0, 0, W, H); g.fillStyle = '#0b0c10'; g.fillRect(0, 0, W, H);
      if (run.artImg) {
        const iw = run.artImg.naturalWidth, ih = run.artImg.naturalHeight;
        if (iw && ih) { const s = Math.max(W / iw, H / ih); g.globalAlpha = 0.18; g.drawImage(run.artImg, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s); g.globalAlpha = 1; }
      }
      // playfield border
      const p0 = osuToScreen(0, 0, tf), p1 = osuToScreen(PLAY_W, PLAY_H, tf);
      g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1 * dpr; g.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      const rad = run.radius * tf.scale;
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
          g.font = (28 * dpr) + 'px system-ui'; g.fillText(prog >= 1 ? 'CLEAR!' : 'SPIN!', ctr.x, ctr.y);
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
          g.strokeStyle = s.color + '99'; g.lineWidth = rad * 1.6; g.stroke();
          // ticks
          for (const cp of s.checkpoints) {
            if (cp.kind !== 'tick' || cp.ev) continue;
            const tp = osuToScreen(pointAtFrac(o.path, cp.frac).x, pointAtFrac(o.path, cp.frac).y, tf);
            g.fillStyle = '#fff'; g.beginPath(); g.arc(tp.x, tp.y, 3 * dpr, 0, Math.PI * 2); g.fill();
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
          if (skin.images.digits.length) drawSkinNumber(sc, s.number, rad);
          else { g.fillStyle = '#fff'; g.font = (rad * 0.9) + 'px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(s.number || ''), sc.x, sc.y); }
          if (ap > 0) {
            const ar = rad * (1 + ap * 3);
            if (skin.images.approachcircle) g.drawImage(tintImage('ac', skin.images.approachcircle, s.color), sc.x - ar, sc.y - ar, ar * 2, ar * 2);
            else { g.strokeStyle = s.color; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(sc.x, sc.y, ar, 0, Math.PI * 2); g.stroke(); }
          }
        } else {
          g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.arc(sc.x, sc.y, rad, 0, Math.PI * 2); g.fill();
          g.strokeStyle = s.color; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(sc.x, sc.y, rad - 2 * dpr, 0, Math.PI * 2); g.stroke();
          g.fillStyle = '#fff'; g.font = (rad * 0.9) + 'px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(s.number || ''), sc.x, sc.y);
          if (ap > 0) { g.strokeStyle = s.color; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(sc.x, sc.y, rad * (1 + ap * 3), 0, Math.PI * 2); g.stroke(); }
        }
        g.globalAlpha = 1;
      }
      // hit-feedback bursts at the circle position (expanding ring + judgement)
      const nowB = performance.now();
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i]; const age = nowB - b.t;
        if (age > 350) { bursts.splice(i, 1); continue; }
        const k = age / 350, sc = osuToScreen(b.x, b.y, tf), col = JUDGE_COLORS[b.result] || '#fff';
        g.globalAlpha = 1 - k; g.strokeStyle = col; g.lineWidth = 3 * dpr;
        g.beginPath(); g.arc(sc.x, sc.y, rad * (1 + k * 0.8), 0, Math.PI * 2); g.stroke();
        if (b.result !== 'miss') { g.globalAlpha = (1 - k) * 0.9; g.fillStyle = col; g.font = (rad * 0.7) + 'px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(JUDGE_LABELS[b.result], sc.x, sc.y - rad * 1.4); }
        g.globalAlpha = 1;
      }
      // cursor trail — skin sprite if provided, else the built-in glow line
      const nowC = performance.now();
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
      // cursor — skin sprite if provided, else the built-in glowing dot
      const cs = osuToScreen(cursor.x, cursor.y, tf);
      if (skin && skin.images.cursor) {
        const im = skin.images.cursor, csz = (44 * dpr) / Math.max(im.width, im.height), cw = im.width * csz, ch = im.height * csz;
        g.drawImage(im, cs.x - cw / 2, cs.y - ch / 2, cw, ch);
      } else {
        g.save();
        g.shadowColor = '#2b6cff'; g.shadowBlur = 14 * dpr;
        g.fillStyle = '#fff'; g.beginPath(); g.arc(cs.x, cs.y, 8 * dpr, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0; g.strokeStyle = '#2b6cff'; g.lineWidth = 3 * dpr;
        g.beginPath(); g.arc(cs.x, cs.y, 12 * dpr, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
      drawErrorBar(W, H, dpr);
    }

    // Hit-error bar near the bottom: ticks left of centre = early, right = late.
    // Background zones show the 300/100/50 windows; a marker tracks the running
    // mean. Ticks fade over ~2.5s. Mirrors osu!mania's bar.
    function drawErrorBar(W, H, dpr) {
      const w = run.windows;
      const cx = W / 2, y = H - 30 * dpr, half = W * 0.22;
      const pxPerMs = half / (w.h50 || 100);            // full bar = ±50 (widest) window
      const zone = (ms, color) => { g.fillStyle = color; g.fillRect(cx - ms * pxPerMs, y - 5 * dpr, ms * pxPerMs * 2, 10 * dpr); };
      zone(w.h50, 'rgba(255,209,102,0.20)');
      zone(w.h100, 'rgba(57,217,138,0.24)');
      zone(w.h300, 'rgba(86,160,255,0.30)');
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(cx - dpr, y - 9 * dpr, 2 * dpr, 18 * dpr);   // centre line
      const nowP = performance.now();
      for (let i = errTicks.length - 1; i >= 0; i--) {
        const e = errTicks[i], age = nowP - e.t;
        if (age > 2500) { errTicks.splice(i, 1); continue; }
        const x = cx + Math.max(-half, Math.min(half, e.err * pxPerMs));
        g.globalAlpha = 1 - age / 2500; g.fillStyle = JUDGE_COLORS[e.result] || '#fff';
        g.fillRect(x - dpr, y - 8 * dpr, 2 * dpr, 16 * dpr); g.globalAlpha = 1;
      }
      if (run.errors.length >= 3) {                     // running-mean marker (small triangle under the bar)
        const mean = run.errors.reduce((a, b) => a + b, 0) / run.errors.length;
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
        const ur = unstableRate(run.errors);
        accEl.textContent = accuracy().toFixed(2) + '%' + (ur ? '  ·  UR ' + Math.round(ur) : '');
      }
    }

    // ---- Results / PB --------------------------------------------------------
    async function finishRun() {
      if (!run || run.finished) return;
      run.finished = true; cancelAnimationFrame(run.rafId); bindInput(false);
      try { run.src.stop(); } catch (e) {}
      const acc = accuracy(), hash = await sha256(await run.entry.getOsuText());
      const prev = await idbGet('osu-pb', hash);
      const improved = !prev || acc > prev.accuracy;
      if (improved) await idbPut('osu-pb', hash, { accuracy: acc, maxCombo: run.maxCombo, date: new Date().toISOString() });
      const c = run.counts;
      const total = c.h300 + c.h100 + c.h50 + c.miss;
      const grade = c.miss === 0 && acc === 100 ? 'SS' : acc >= 95 && c.miss === 0 ? 'S' : acc >= 90 ? 'A' : acc >= 80 ? 'B' : acc >= 70 ? 'C' : 'D';
      const gradeColor = { SS: '#ffd166', S: '#ffd166', A: '#39d98a', B: '#56a0ff', C: '#b06bff', D: '#ff5470' }[grade];
      const fc = c.miss === 0 ? '<span class="osu-res-fc">Full Combo!</span>' : '';
      const cell = (label, val, col) => '<div class="osu-res-cell"><div class="osu-res-cn" style="color:' + col + '">' + val + '</div><div class="osu-res-cl">' + label + '</div></div>';
      resultsBody.innerHTML =
        '<div class="osu-res-title">' + escapeH(run.entry.title) + ' · ' + escapeH(run.entry.diffName) + '</div>' +
        '<div class="osu-res-grade" style="color:' + gradeColor + '">' + grade + '</div>' +
        '<div class="osu-res-acc">' + acc.toFixed(2) + '%</div>' +
        '<div class="osu-res-grid">' +
          cell('300', c.h300, '#56a0ff') + cell('100', c.h100, '#39d98a') +
          cell('50', c.h50, '#ffd166') + cell('Miss', c.miss, '#ff5470') +
        '</div>' +
        '<div class="osu-res-combo">Max combo ' + run.maxCombo + 'x &nbsp;·&nbsp; ' + total + ' objects &nbsp;·&nbsp; UR ' + Math.round(unstableRate(run.errors)) + ' ' + fc + '</div>' +
        (prev ? '<div class="osu-res-pb">Previous best: ' + prev.accuracy.toFixed(2) + '%' + (improved ? ' — <b>new best!</b>' : '') + '</div>'
              : '<div class="osu-res-pb">First clear — saved as your best.</div>');
      show('results');
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
      const tapCtx = tapState.tc0 + (perfTs - tapState.tp0) / 1000;
      const k = Math.round((tapCtx - tapState.baseTick) / tapState.period);
      if (k < 0) return;                                   // before the first beat
      const beat = tapState.baseTick + k * tapState.period;
      const errMs = (tapCtx - beat - audioLatency()) * 1000;       // vs the HEARD beep (same shift as gameplay)
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
            const rel = ac.currentTime - baseTick - audioLatency() - calOffset() / 1000;
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
      show('select'); refreshLibrary(); renderKeybinds();
      if (!skin) loadCachedSkin(); else renderSkinStatus();
    }
    function close() {
      loadGen++; if (run && !run.finished) quitToSelect();
      if (calibLoop) { cancelAnimationFrame(calibLoop); calibLoop = null; calibTiming = null; tapState = null; }
      panel.classList.remove('open'); panelOpen = false;
      if (deps.captureKeyboard) deps.captureKeyboard(false);
      if (deps.resumeBgm) deps.resumeBgm();
      if (settings.gameMode === 'osu') { settings.gameMode = 'clicker'; if (deps.saveSettings) deps.saveSettings(); window.dispatchEvent(new CustomEvent('gamemodechange')); }
    }

    if (songlistEl) songlistEl.addEventListener('click', (e) => {
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
    if (importBtn) importBtn.addEventListener('click', () => importFolder());
    if (importInput) importInput.addEventListener('change', () => handleImportFiles(importInput.files));
    if (oszBtn) oszBtn.addEventListener('click', () => { if (oszInput) { oszInput.value = ''; oszInput.click(); } });
    if (oszInput) oszInput.addEventListener('change', () => handleOszFiles(oszInput.files));
    if (skinBtn) skinBtn.addEventListener('click', () => { if (skinOskInput) { skinOskInput.value = ''; skinOskInput.click(); } });
    if (skinOskInput) skinOskInput.addEventListener('change', () => handleSkinOsk(skinOskInput.files[0]));
    if (skinClearBtn) skinClearBtn.addEventListener('click', () => clearSkin());
    if (hitsoundBtn) hitsoundBtn.addEventListener('click', () => { show('hitsound'); if (window.Hitsound) window.Hitsound.renderControls(hsControlsEl); });
    if (hitsoundDoneBtn) hitsoundDoneBtn.addEventListener('click', () => show('select'));
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
      if (screens.results && !screens.results.hidden) { quitToSelect(); return; }
      close();
    });
    window.addEventListener('resize', () => { if (run && !run.finished) sizeCanvas(); });
    if (canvas) { canvas.setAttribute('tabindex', '0'); canvas.style.outline = 'none'; canvas.style.cursor = 'none'; }
    if (panel) panel.addEventListener('pointerdown', grabFocus);

    api.open = open; api.close = close;
    // Cross-mode hooks (called by vsrg.js when a mania-side import finds standard
    // charts, or a skin to apply): store Mode-0 charts / load a .osk skin here.
    api.importForeignCharts = async function (records) {
      if (!records || !records.length) return 0;
      let n = 0;
      for (const r of records) {
        let chart; try { chart = assembleChart(r.osuText); } catch (e) { continue; }   // accept Mode-0 only
        const hash = await sha256(r.osuText);
        await idbPut('osz', hash, { title: chart.title, artist: chart.artist, diffName: chart.diffName, hash: hash, osuText: r.osuText, audio: r.audio, art: r.art || null });
        n++;
      }
      if (n && panelOpen) await refreshLibrary();
      return n;
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
      const req = indexedDB.open('aobing-osustd', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('osu-pb')) db.createObjectStore('osu-pb');   // personal bests
        if (!db.objectStoreNames.contains('osz')) db.createObjectStore('osz');          // imported .osz maps
        if (!db.objectStoreNames.contains('skin')) db.createObjectStore('skin');        // active custom skin
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
