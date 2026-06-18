'use strict';

/*
 * divaft.js — Project Diva (Future Tone / Mega Mix) style mode for aobing.
 *
 * Two halves, same shape as osustd.js / vsrg.js:
 *   1. A PURE engine (no DOM/audio): the note model, the faithful sine fly-in
 *      geometry, timing windows / accuracy / clear ranks, double-grouping and the
 *      input matcher. Unit-tested in divaft.test.js (Node).
 *   2. Browser wiring (panel/render/input/audio), guarded by `typeof document`,
 *      self-initialising from window.__divaftDeps.
 *
 * Diva is NOT aim-based: targets sit at fixed positions, an icon flies in along a
 * sine-curved trail, and you press the matching FACE BUTTON at the right time. So
 * judgement is timing + correct-button (mania-like); only the rendering borrows
 * osu's letterboxed coordinate transform (here at 16:9).
 */
(function () {

  // =========================================================================
  // PURE ENGINE
  // =========================================================================
  const BUTTONS = ['triangle', 'circle', 'cross', 'square', 'slideL', 'slideR', 'star'];
  const FACE = ['triangle', 'circle', 'cross', 'square'];
  // Diva-ish button colours.
  const BUTTON_COLOR = {
    triangle: '#46c8a0', circle: '#ff7eb6', cross: '#56a0ff', square: '#ffd166',
    slideL: '#ff5470', slideR: '#39d98a', star: '#b06bff',
  };

  // Timing windows (± ms around the note time) and accuracy weights. Tunable.
  const WINDOWS = { cool: 30, fine: 70, safe: 100, sad: 130 };
  const WEIGHTS = { cool: 100, fine: 80, safe: 50, sad: 30, worst: 0 };
  const DOUBLE_WINDOW = 40;   // ms tolerance for "simultaneous" presses of a multi note

  // Map an absolute timing error (ms) to a judgement tier.
  function tierFor(absMs) {
    if (absMs <= WINDOWS.cool) return 'cool';
    if (absMs <= WINDOWS.fine) return 'fine';
    if (absMs <= WINDOWS.safe) return 'safe';
    if (absMs <= WINDOWS.sad) return 'sad';
    return 'worst';
  }

  // Weighted accuracy % over a tier-count object.
  function accuracy(c) {
    const total = c.cool + c.fine + c.safe + c.sad + c.worst;
    if (!total) return 100;
    return Math.round(((c.cool * 100 + c.fine * 80 + c.safe * 50 + c.sad * 30) / total) * 100) / 100;
  }

  // Diva clear rank from final accuracy + miss count (no-fail: always clears).
  function clearRank(acc, miss) {
    if (acc >= 100 && miss === 0) return 'PERFECT';
    if (acc >= 95 && miss === 0) return 'EXCELLENT';
    if (acc >= 80) return 'GREAT';
    return 'STANDARD';
  }

  // Faithful sine fly-in: the icon travels from an entry point (target offset by
  // `distance` along `angle`) to the target, displaced perpendicular to the travel
  // direction by amplitude·sin(frequency·p·2π). p in [0,1], p=1 at the target.
  function trailPoint(n, p) {
    const a = (n.angle || 0) * Math.PI / 180;
    const ex = n.x + Math.cos(a) * (n.distance || 0);
    const ey = n.y + Math.sin(a) * (n.distance || 0);
    const bx = ex + (n.x - ex) * p, by = ey + (n.y - ey) * p;       // base lerp entry→target
    let dx = n.x - ex, dy = n.y - ey; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const off = (n.amplitude || 0) * Math.sin((n.frequency || 0) * p * 2 * Math.PI);
    return { x: bx + dy * off, y: by - dx * off };                  // perpendicular = (dy,-dx)
  }

  // Rough star estimate from note density (osu doesn't store one; nor does Diva for us).
  function estimateStars(notes) {
    if (!notes || notes.length < 2) return 0.5;
    let first = Infinity, last = -Infinity;
    for (const n of notes) { if (n.time < first) first = n.time; const e = n.holdEnd != null ? n.holdEnd : n.time; if (e > last) last = e; }
    const durSec = Math.max(1, (last - first) / 1000);
    const nps = notes.length / durSec;
    return Math.max(0.5, Math.min(12, Math.round((nps * 0.6 + 0.8) * 10) / 10));
  }

  // Group simultaneous notes (same time) into a shared groupId (a double/multi).
  function groupDoubles(notes) {
    const sorted = notes.slice().sort((a, b) => a.time - b.time);
    let gid = 0;
    for (let i = 0; i < sorted.length;) {
      let j = i; while (j < sorted.length && sorted[j].time === sorted[i].time) j++;
      if (j - i >= 2) { gid++; for (let k = i; k < j; k++) sorted[k].groupId = gid; }
      i = j;
    }
    return sorted;
  }

  // Normalize a raw note-model JSON chart into a playable chart.
  function assembleChart(raw) {
    const notes = (raw.notes || []).map((o) => {
      if (BUTTONS.indexOf(o.button) < 0) throw new Error('Unknown button: ' + o.button);
      return {
        button: o.button, time: o.time, x: o.x, y: o.y,
        flyTime: (o.flyTime != null) ? o.flyTime : 600,
        angle: o.angle || 0, distance: o.distance || 0, amplitude: o.amplitude || 0, frequency: o.frequency || 0,
        holdEnd: (o.holdEnd != null) ? o.holdEnd : null,
        groupId: (o.groupId != null) ? o.groupId : null,
        slideChain: (o.slideChain != null) ? o.slideChain : null,
      };
    });
    const grouped = groupDoubles(notes);   // keeps explicit groupId, adds same-time ones
    return {
      title: raw.title || '', artist: raw.artist || '', bpm: raw.bpm || 0,
      audioFile: raw.audioFile || '',
      stars: estimateStars(grouped),
      notes: grouped,
      chanceTimes: (raw.chanceTimes || []).slice(),
    };
  }

  // Nearest unhit, head-unjudged note of `button` within ±badWindow of st. -1 if none.
  function matchNote(objs, button, st, badWindow) {
    let best = -1, bestErr = Infinity;
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (o.headJudged) continue;
      if (o.n.button !== button) continue;
      const err = Math.abs(st - o.n.time);
      if (err <= badWindow && err < bestErr) { bestErr = err; best = i; }
    }
    return best;
  }

  function inChanceTime(chanceTimes, st) {
    for (const r of (chanceTimes || [])) if (st >= r.start && st <= r.end) return true;
    return false;
  }

  const ENGINE = {
    DIVA_ENGINE: true,
    BUTTONS: BUTTONS, FACE: FACE, BUTTON_COLOR: BUTTON_COLOR,
    WINDOWS: WINDOWS, WEIGHTS: WEIGHTS, DOUBLE_WINDOW: DOUBLE_WINDOW,
    tierFor: tierFor, accuracy: accuracy, clearRank: clearRank,
    trailPoint: trailPoint, estimateStars: estimateStars,
    groupDoubles: groupDoubles, assembleChart: assembleChart,
    matchNote: matchNote, inChanceTime: inChanceTime,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  if (typeof window !== 'undefined') window.DivaEngine = ENGINE;

  // =========================================================================
  // Browser wiring lands in a later task (guarded).
  // =========================================================================
  if (typeof document === 'undefined') return;

})();
