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
    if (type & 1) {
      out.push({ kind: 'circle', x: x, y: y, time: time });
    } else if (type & 2) {
      const seg = String(p[5] || '').split('|');
      const curveType = seg[0] || 'L';
      const points = [{ x: x, y: y }];
      for (let i = 1; i < seg.length; i++) {
        const xy = seg[i].split(':');
        points.push({ x: parseFloat(xy[0]), y: parseFloat(xy[1]) });
      }
      out.push({
        kind: 'slider', x: x, y: y, time: time,
        curveType: curveType, points: points,
        slides: parseInt(p[6], 10) || 1, length: parseFloat(p[7]) || 0,
      });
    } else if (type & 8) {
      out.push({ kind: 'spinner', time: time, endTime: parseInt(p[5], 10) });
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
// Browser wiring (playfield, cursor, audio) — added in Phase 2.
// =========================================================================
if (typeof document !== 'undefined') {
  // Intentionally empty until the playfield runtime lands.
}

})();
