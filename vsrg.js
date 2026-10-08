'use strict';

/*
 * vsrg.js — Vertical Scrolling Rhythm Game mode for aobing.
 *
 * Two halves (same shape as typing.js):
 *   1. A PURE engine (no DOM, no audio) — .osu parser + judgement/scoring.
 *      Unit-tested in vsrg.test.js.
 *   2. Browser wiring (Web Audio, Canvas, input) guarded by `typeof document`.
 *      The host (app.js) injects every dependency via window.VsrgGame.init(deps).
 *
 * The engine is exported via module.exports for Node tests and attached to
 * window.VsrgEngine in the browser.
 *
 * The whole file is wrapped in an IIFE: it loads as a classic <script>
 * alongside typing.js, which shares the global lexical scope, so unscoped
 * top-level `const`s (ENGINE, COMBO_TIERS, ...) would collide. The IIFE keeps
 * them private; only window.VsrgEngine / window.VsrgGame / module.exports leak.
 */

(function () {
const R = typeof module !== 'undefined' && module.exports ? require('./rhythm-core.js') : window.RhythmCore;
const M = typeof module !== 'undefined' && module.exports ? require('./rhythm-mania.js') : window.RhythmMania;

// =========================================================================
// .osu parser
// =========================================================================

// Split raw .osu text into { sectionName: [line, ...] }. Blank lines dropped.
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

// Parse `key:value` lines of a section into a plain object (first colon splits).
function keyValues(lines) {
  const obj = {};
  for (const line of lines || []) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return obj;
}

// Extract chart metadata from [General], [Metadata], [Difficulty].
function parseMeta(text) {
  const s = splitSections(text);
  const general = keyValues(s.General);
  const meta = keyValues(s.Metadata);
  const diff = keyValues(s.Difficulty);
  return {
    audioFile: general.AudioFilename || '',
    mode: parseInt(general.Mode, 10),
    title: meta.Title || '',
    artist: meta.Artist || '',
    diffName: meta.Version || '',
    keyCount: parseInt(diff.CircleSize, 10),
    overallDifficulty: Number.isFinite(parseFloat(diff.OverallDifficulty)) ? parseFloat(diff.OverallDifficulty) : 5,
  };
}

// Parse a [HitObjects] block (string of lines) into sorted note objects.
// Each note: { time, lane, endTime|null }. Hold notes (type & 128) carry endTime.
function parseHitObjects(text, keyCount) {
  const notes = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split(',');
    if (p.length < 4) continue;
    const x = parseInt(p[0], 10);
    const time = parseInt(p[2], 10);
    const type = parseInt(p[3], 10);
    const lane = Math.max(0, Math.min(keyCount - 1, Math.floor((x * keyCount) / 512)));
    let endTime = null;
    if (type & 128) {
      // Hold: extra params live in p[5] as "endTime:hitSample..."
      endTime = parseInt(String(p[5] || '').split(':')[0], 10);
      if (!Number.isFinite(endTime)) endTime = null;
    }
    if (!Number.isFinite(time) || !Number.isFinite(lane)) continue;
    if (endTime != null && endTime <= time) endTime = null;
    notes.push({ time: time, lane: lane, endTime: endTime, hitSound: Number(p[4]) || 0, sample: R.sample(endTime != null ? String(p[5]).split(':').slice(1).join(':') : p[5]) });
  }
  notes.sort((a, b) => a.time - b.time);
  return notes;
}

// Read the first uninherited timing point for BPM/offset (display only in v1;
// note timing is absolute). Returns { bpm, offset } with null when absent.
function parseTiming(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split(',');
    if (p.length < 2) continue;
    const beatLength = parseFloat(p[1]);
    const uninherited = p.length >= 7 ? p[6].trim() === '1' : beatLength > 0;
    if (uninherited && beatLength > 0) {
      return { bpm: Math.round(60000 / beatLength), offset: parseInt(p[0], 10) };
    }
  }
  return { bpm: null, offset: null };
}

// Read the background image filename from an [Events] block. Background events
// look like `0,0,"bg.jpg",0,0` (type 0 = background). Returns '' if none.
function parseBackground(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.charAt(0) === '/') continue;          // skip comments
    const p = t.split(',');
    if ((p[0] === '0' || p[0] === 'Background') && p[2]) {
      return p[2].trim().replace(/^"|"$/g, '');
    }
  }
  return '';
}

// Top-level parse: raw .osu text -> validated chart object. Throws on charts
// this engine cannot play (non-mania, or empty).
function parseOsu(text) {
  const meta = parseMeta(text);
  if (meta.mode !== 3) {
    throw new Error('Unsupported chart: only osu!mania (Mode 3) is supported');
  }
  if (!(meta.keyCount >= 1)) {
    throw new Error('Unsupported chart: missing/invalid key count (CircleSize)');
  }
  const sections = splitSections(text);
  const notes = parseHitObjects((sections.HitObjects || []).join('\n'), meta.keyCount);
  if (notes.length === 0) {
    throw new Error('Unsupported chart: no notes in [HitObjects]');
  }
  const timing = parseTiming((sections.TimingPoints || []).join('\n'));
  return {
    audioFile: meta.audioFile,
    backgroundFile: parseBackground((sections.Events || []).join('\n')),
    title: meta.title,
    artist: meta.artist,
    diffName: meta.diffName,
    keyCount: meta.keyCount,
    overallDifficulty: meta.overallDifficulty,
    bpm: timing.bpm,
    offset: timing.offset,
    notes: notes,
    sampleSet: ({Normal:1,Soft:2,Drum:3})[keyValues(sections.General).SampleSet] || 1,
    samplePoints: R.timingPoints(sections.TimingPoints || []),
    scroll: R.scrollTimeline(R.timingPoints(sections.TimingPoints || []), notes.reduce((m,n) => Math.max(m,n.endTime || n.time),0)),
  };
}

// Rough difficulty estimate (osu does NOT store a star rating in the .osu file,
// so this is a density-based approximation — shown with a leading '~'). Driven by
// notes-per-second over the chart, nudged slightly by OverallDifficulty.
function difficultyStars(chart) {
  const notes = (chart && chart.notes) || [];
  if (notes.length < 2) return 0.5;
  let first = Infinity, last = -Infinity;
  for (const n of notes) {
    if (n.time < first) first = n.time;
    const end = n.endTime != null ? n.endTime : n.time;
    if (end > last) last = end;
  }
  const durationSec = Math.max(1, (last - first) / 1000);
  const nps = notes.length / durationSec;
  const od = Number(chart.overallDifficulty);
  const odFactor = 1 + (((od >= 0 && od <= 10) ? od : 5) - 5) * 0.02;
  const stars = (nps * 0.55 + 0.8) * odFactor;
  return Math.max(0.5, Math.min(12, Math.round(stars * 10) / 10));
}

// =========================================================================
// Judgement & scoring
// =========================================================================

// osu!mania timing windows (half-windows, ms) for a given OverallDifficulty.
// A hit within ±window[tier] of the note time earns that tier. Beyond `bad`
// it is a MISS. MARVELOUS is fixed; the rest tighten by 3ms per OD point.
function windowsForOD(od) { return M.windows(od); }

// Judge a hit against a note time. Returns { tier, errorMs } where errorMs is
// signed (hit - note): negative = early, positive = late. `tier` is one of
// marvelous|perfect|great|good|bad|miss.
function judge(noteTimeMs, hitTimeMs, windows) {
  return {tier:M.tapTier(hitTimeMs-noteTimeMs,windows),errorMs:hitTimeMs-noteTimeMs};
}

// osu!mania accuracy %: weighted hit value over the max possible (300 each).
// marvelous and perfect both score 300; great 200; good 100; bad 50; miss 0.
function accuracy(counts) {
  const c = counts || {};
  const total = (c.marvelous || 0) + (c.perfect || 0) + (c.great || 0) +
                (c.good || 0) + (c.bad || 0) + (c.miss || 0);
  if (total === 0) return 0;
  const points = 300 * ((c.marvelous || 0) + (c.perfect || 0)) +
                 200 * (c.great || 0) + 100 * (c.good || 0) + 50 * (c.bad || 0);
  return Math.round((points / (300 * total)) * 10000) / 100; // 2 dp
}

// =========================================================================
// Run state — pure reducer over judgements
// =========================================================================

// Every successful tap, including a 50, continues a classic combo.
const COMBO_TIERS = { marvelous: true, perfect: true, great: true, good: true, bad: true };

function createRunState(chart) {
  return {
    totalNotes: chart.notes.length,
    combo: 0,
    maxCombo: 0,
    counts: { marvelous: 0, perfect: 0, great: 0, good: 0, bad: 0, miss: 0 },
  };
}

// Apply one judgement tier, returning a NEW state (does not mutate input).
function applyJudgement(state, tier) {
  const counts = Object.assign({}, state.counts);
  counts[tier] = (counts[tier] || 0) + 1;
  const combo = COMBO_TIERS[tier] ? state.combo + 1 : 0;
  const maxCombo = Math.max(state.maxCombo, combo);
  return {
    totalNotes: state.totalNotes,
    combo: combo,
    maxCombo: maxCombo,
    counts: counts,
  };
}

// =========================================================================
// Exports
// =========================================================================
const ENGINE = {
  VSRG_ENGINE: true,
  createSession: M.createSession,
  splitSections: splitSections,
  parseMeta: parseMeta,
  parseHitObjects: parseHitObjects,
  parseTiming: parseTiming,
  parseOsu: parseOsu,
  difficultyStars: difficultyStars,
  windowsForOD: windowsForOD,
  judge: judge,
  accuracy: accuracy,
  createRunState: createRunState,
  applyJudgement: applyJudgement,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ENGINE;
}
if (typeof window !== 'undefined') {
  window.VsrgEngine = ENGINE;
}

// =========================================================================
// Browser wiring — window.VsrgGame.init(deps).
// All DOM / Web Audio / IndexedDB lives here, guarded by `typeof document`.
// The host (app.js) injects every dependency via window.__vsrgDeps; this half
// never reaches into app.js's closure directly.
// =========================================================================
if (typeof document !== 'undefined') {
  const api = { init: initBrowser };

  // Keyboard layouts per key count (lowercase). Index = lane.
  const KEY_MAPS = {
    4: ['d', 'f', 'j', 'k'],
    5: ['d', 'f', ' ', 'j', 'k'],
    6: ['s', 'd', 'f', 'j', 'k', 'l'],
    7: ['s', 'd', 'f', ' ', 'j', 'k', 'l'],
  };
  const LANE_COLORS = ['#2b6cff', '#ff5470', '#39d98a', '#ffd166', '#b06bff', '#22d3ee', '#f59e0b'];
  // Lane-colour presets (indexed by lane). 'osu' is the blue/pink mirror layout
  // (4K: outer lanes blue, inner pink) that matches the common osu!mania circle skin.
  const COLOR_PRESETS = {
    default: ['#2b6cff', '#ff5470', '#39d98a', '#ffd166', '#b06bff', '#22d3ee', '#f59e0b'],
    osu:     ['#56a0ff', '#ff7eb6', '#ff7eb6', '#56a0ff', '#ffd166', '#ff7eb6', '#56a0ff'],
    mono:    ['#5b8cff', '#5b8cff', '#5b8cff', '#5b8cff', '#5b8cff', '#5b8cff', '#5b8cff'],
    pastel:  ['#8fb3ff', '#ffb3c1', '#a8e6cf', '#ffe5a8', '#d2b3ff', '#a8e6ff', '#ffd6a8'],
  };
  const ARROW_DIRS = ['left', 'down', 'up', 'right'];
  const TIER_COLORS = { marvelous: '#9be7ff', perfect: '#39d98a', great: '#ffd166', good: '#f59e0b', bad: '#ff8c5a', miss: '#ff5470' };
  const APPROACH_MS = 1600;   // base approach time (1.0x speed); scaled by scroll-speed setting
  const LEAD_IN_MS = 2000;    // silence/scroll before the song's audio starts
  const END_PAD_MS = 2000;    // wait after the last note before results

  function initBrowser(deps) {
    const t = deps.t || ((k) => k);
    const settings = deps.settings || {};

    // ---- DOM refs ----------------------------------------------------------
    const panel = document.getElementById('vsrg-panel');
    if (!panel) return;                       // panel not in DOM — inert
    const screens = {
      select:  document.getElementById('vsrg-select'),
      game:    document.getElementById('vsrg-game'),
      results: document.getElementById('vsrg-results'),
      calib:   document.getElementById('vsrg-calib'),
      appearance: document.getElementById('vsrg-appearance'),
      hitsound: document.getElementById('vsrg-hitsound'),
    };
    const hitsoundBtn = document.getElementById('vsrg-hitsound-btn');
    const hitsoundDoneBtn = document.getElementById('vsrg-hitsound-done');
    const hsControlsEl = document.getElementById('vsrg-hs-controls');
    const songlistEl = document.getElementById('vsrg-songlist');
    const importBtn = document.getElementById('vsrg-import');
    const importInput = document.getElementById('vsrg-import-input');
    const importStatusEl = document.getElementById('vsrg-import-status');
    const keyFilterEl = document.getElementById('vsrg-keyfilter');
    const calibrateBtn = document.getElementById('vsrg-calibrate');
    const oszBtn = document.getElementById('vsrg-import-osz');
    const oszInput = document.getElementById('vsrg-osz-input');
    const oszStatusEl = document.getElementById('vsrg-osz-status');
    const skinBtn = document.getElementById('vsrg-import-skin');
    const skinOskInput = document.getElementById('vsrg-skin-osk-input');
    const speedDownBtn = document.getElementById('vsrg-speed-down');
    const speedUpBtn = document.getElementById('vsrg-speed-up');
    const speedValEl = document.getElementById('vsrg-speed-val');
    const speedPreview = document.getElementById('vsrg-speed-preview');
    const appearanceBtn = document.getElementById('vsrg-appearance-btn');
    const stylePickEl = document.getElementById('vsrg-style-pick');
    const presetPickEl = document.getElementById('vsrg-preset-pick');
    const sizeSlider = document.getElementById('vsrg-size');
    const sizeValEl = document.getElementById('vsrg-size-val');
    const laneColorsEl = document.getElementById('vsrg-lane-colors');
    const keybindsEl = document.getElementById('vsrg-keybinds');
    const appearPreview = document.getElementById('vsrg-appear-preview');
    const appearResetBtn = document.getElementById('vsrg-appear-reset');
    const appearDoneBtn = document.getElementById('vsrg-appear-done');
    const tapBtn = document.getElementById('vsrg-tap');
    const tapResultEl = document.getElementById('vsrg-tap-result');
    const canvas = document.getElementById('vsrg-canvas');
    const ctx2d = canvas.getContext('2d');
    const comboEl = document.getElementById('vsrg-combo');
    const accEl = document.getElementById('vsrg-acc');
    const judgeEl = document.getElementById('vsrg-judge');
    const infoEl = document.getElementById('vsrg-info');
    const fpsEl = document.getElementById('vsrg-fps');
    const skipBtn = document.getElementById('vsrg-skip');
    const autoBtn = document.getElementById('vsrg-auto');
    const resultsBody = document.getElementById('vsrg-results-body');
    const retryBtn = document.getElementById('vsrg-retry');
    const backBtn = document.getElementById('vsrg-back');
    const calibSlider = document.getElementById('vsrg-calib-slider');
    const calibValEl = document.getElementById('vsrg-calib-val');
    const calibDoneBtn = document.getElementById('vsrg-calib-done');
    const calibCanvas = document.getElementById('vsrg-calib-canvas');

    // ---- State -------------------------------------------------------------
    let audioCtx = null;
    let panelOpen = false;
    let fpsFrames = 0, fpsLast = 0, fpsPrev = 0, fpsMaxDt = 0;   // FPS + frametime accumulators (loop is bare rAF = display refresh)
    let autoplay = false;                             // Auto preview mod: the chart plays itself, no score saved
    let library = [];          // [{ id, source, title, artist, diffName, keyCount, od, hash, getOsuText, getAudio }]
    let localEntries = [];     // maps imported this session (webkitdirectory; not persisted)
    let keyFilter = 'all';
    let lastSong = null;       // remember for Retry
    let loading = false;       // guards against re-entrant loadAndPlay
    let loadGen = 0;           // bumped to cancel an in-flight async load

    // Active run (null when not playing)
    let run = null;

    const pauseUI = window.RhythmUI.pausePanel(panel, resumeRun, () => { if (run) loadAndPlay(run.entry); }, quitToSelect);
    function pauseRun(present = true) {
      if (!run || run.finished) return;
      if (run.paused) { if (present) pauseUI.cancelCountdown(); else pauseUI.hide(); return; }
      run.pauseRaw = run.clock.pause();
      run.engine.advance(run.pauseRaw - calOffset()); flushEngine();
      run.paused = true; run.pressed = {};
      cancelAnimationFrame(run.rafId);
      try { run.src.stop(); } catch (_) {}
      run.engine.held.clear();
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
      for (const n of run.notes) if (n.holding && !heldLanes()[n.lane]) {
        n.holding = false; n.broken = true; run.state.combo = 0;
      }
      for (const lane of Object.keys(heldLanes())) run.engine.held.add(Number(lane));
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

    window.RhythmUI.controls(document.querySelector('#vsrg-appearance .vsrg-appear-controls'),settings,deps.saveSettings,[
      {key:'vsrgLaneWidth',label:'rhythm.lane_width',min:32,max:110,value:72,format:v=>v+' px'},
      {key:'vsrgReceptorPosition',label:'rhythm.receptor',min:0.6,max:0.92,step:0.01,value:0.85,format:v=>Math.round(v*100)+'%'},
      {key:'vsrgUpscroll',label:'rhythm.upscroll',type:'checkbox',value:false},
      {key:'vsrgConstantScroll',label:'rhythm.constant_scroll',type:'checkbox',value:false},
      {key:'vsrgVisualOffset',label:'rhythm.visual_offset',min:-200,max:200,value:0,format:v=>v+' ms'}
    ]);

    const selector = window.RhythmSelect?.create({mode:'vsrg', settings, save:deps.saveSettings, ensureCtx, pauseBgm:deps.pauseBgm, resumeBgm:deps.resumeBgm, play:loadAndPlay});
    const stageHud = window.RhythmSelect?.hud('vsrg', pauseRun);

    function calOffset() { return Number(settings.vsrgCalibrationOffset) || 0; }
    // Scroll speed: higher multiplier -> shorter approach time -> faster notes.
    // Uncapped on top (some players want 10x+); floored at 0.5 to stay sane.
    function scrollSpeed() { return Math.max(0.5, Number(settings.vsrgScrollSpeed) || 1); }
    function approachMs() { return APPROACH_MS / scrollSpeed(); }
    // Apply a new scroll speed everywhere (live: also updates the active run).
    // Rounds to 2 decimals so typed values like 3.2 or 5.55 are preserved.
    function setScrollSpeed(v) {
      settings.vsrgScrollSpeed = Math.max(0.5, Math.round(v * 100) / 100);
      if (deps.saveSettings) deps.saveSettings();
      if (run) run.approachMs = approachMs();
      if (speedValEl) speedValEl.value = String(settings.vsrgScrollSpeed);
    }

    // ---- Skin: note style, size, lane colours (read live from settings) ------
    function noteStyle() {
      const s = settings.vsrgNoteStyle;
      return (s === 'circle' || s === 'arrow') ? s : 'bar';
    }
    function noteScale() { return Math.max(0.6, Math.min(1.8, Number(settings.vsrgNoteScale) || 1)); }
    function presetColors() { return COLOR_PRESETS[settings.vsrgColorPreset] || COLOR_PRESETS.default; }
    function laneColor(i) {
      const ov = settings.vsrgLaneColors && settings.vsrgLaneColors[i];
      if (ov) return ov;
      const p = presetColors();
      return p[i % p.length];
    }
    function arrowDir(lane) { return ARROW_DIRS[lane % ARROW_DIRS.length]; }

    // Draw a single tap note (or hold cap) centred at (laneX+laneW/2, cy).
    function drawTap(g, style, color, laneX, laneW, cy, scale, dpr, dir) {
      const cx = laneX + laneW / 2;
      if (style === 'circle') {
        const r = (laneW / 2 - 4 * dpr) * Math.min(1.15, scale);
        g.fillStyle = color; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        g.lineWidth = 2.5 * dpr; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.stroke();
      } else if (style === 'arrow') {
        const s = laneW * 0.34 * Math.min(1.4, scale);
        const ang = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[dir] || -Math.PI / 2;
        g.save(); g.translate(cx, cy); g.rotate(ang);
        g.fillStyle = color; g.beginPath();
        g.moveTo(s, 0); g.lineTo(-s * 0.5, -s); g.lineTo(-s * 0.12, 0); g.lineTo(-s * 0.5, s); g.closePath();
        g.fill(); g.lineWidth = 2 * dpr; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.stroke();
        g.restore();
      } else { // bar
        const h = 18 * dpr * scale;
        g.fillStyle = color; g.beginPath();
        g.roundRect(laneX + 5 * dpr, cy - h / 2, laneW - 10 * dpr, h, 5 * dpr); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(laneX + 5 * dpr, cy - h / 2, laneW - 10 * dpr, 3 * dpr);
      }
    }

    // Draw a hold: connecting body (tail->head, or tail->line while held) + tail cap.
    function drawHold(g, style, color, laneX, laneW, yHeadC, yTailC, holding, hitY, scale, dpr, dir) {
      const top = holding ? yTailC : Math.min(yHeadC, yTailC);
      const bot = holding ? hitY : Math.max(yHeadC, yTailC);
      if (bot > top) {
        const bw = (style === 'bar') ? (laneW - 10 * dpr) : (laneW * 0.46);
        const bx = laneX + (laneW - bw) / 2;
        g.save();
        const grad = g.createLinearGradient(0, top, 0, bot);
        grad.addColorStop(0, color); grad.addColorStop(1, color + '66');
        g.fillStyle = grad;
        if (holding) { g.shadowColor = color; g.shadowBlur = 16 * dpr; }
        g.beginPath(); g.roundRect(bx, top, bw, bot - top, Math.min(bw / 2, 8 * dpr)); g.fill();
        g.lineWidth = 2 * dpr; g.strokeStyle = 'rgba(255,255,255,0.7)'; g.stroke();
        g.restore();
      }
      if (yTailC <= hitY + 24 * dpr) drawTap(g, style, color, laneX, laneW, yTailC, scale, dpr, dir);
    }

    // Draw a lane receptor at the judgement line, matching the note style.
    function drawReceptor(g, style, color, laneX, laneW, hitY, recH, dpr, dir, glow) {
      const cx = laneX + laneW / 2, cy = hitY;
      g.save();
      if (glow) { g.shadowColor = color; g.shadowBlur = 20 * dpr; g.globalAlpha = 0.9; g.fillStyle = color; }
      else { g.globalAlpha = 1; g.strokeStyle = color; g.lineWidth = 2 * dpr; g.fillStyle = 'transparent'; }
      if (style === 'circle') {
        const r = laneW / 2 - 4 * dpr;
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
        if (glow) g.fill(); else g.stroke();
      } else if (style === 'arrow') {
        if (glow) drawTap(g, 'arrow', color, laneX, laneW, cy, 1, dpr, dir);
        else { g.globalAlpha = 0.5; drawTapOutlineArrow(g, color, laneX, laneW, cy, dpr, dir); }
      } else {
        const x = laneX + 4 * dpr, w = laneW - 8 * dpr;
        if (glow) g.fillRect(x, hitY - recH / 2, w, recH); else g.strokeRect(x, hitY - recH / 2, w, recH);
      }
      g.restore();
    }
    function drawTapOutlineArrow(g, color, laneX, laneW, cy, dpr, dir) {
      const cx = laneX + laneW / 2, s = laneW * 0.34;
      const ang = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[dir] || -Math.PI / 2;
      g.save(); g.translate(cx, cy); g.rotate(ang);
      g.strokeStyle = color; g.lineWidth = 2 * dpr; g.beginPath();
      g.moveTo(s, 0); g.lineTo(-s * 0.5, -s); g.lineTo(-s * 0.12, 0); g.lineTo(-s * 0.5, s); g.closePath();
      g.stroke(); g.restore();
    }

    // ---- Screen management -------------------------------------------------
    function show(name) {
      selector?.screen(name);
      if (window.UIMotion) window.UIMotion.showScreen(panel, screens, name);
      else for (const k in screens) if (screens[k]) screens[k].hidden = (k !== name);
      panel.querySelectorAll('[data-rhythm-setting]').forEach(el => el.rhythmRefresh());
    }

    // Pull keyboard focus into this window/iframe. In the Discord Activity the
    // game runs in an iframe; clicking Discord's chat steals focus, so we must
    // re-grab it (window.focus + a focusable canvas) when the user clicks back in.
    function grabFocus() {
      try { window.focus(); } catch (e) {}
      try { if (canvas && canvas.focus) canvas.focus({ preventScroll: true }); } catch (e) {}
    }

    // ---- Audio -------------------------------------------------------------
    function ensureCtx() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({latencyHint:'interactive'});
      if (audioCtx.state !== 'running') return audioCtx.resume().then(() => audioCtx);
      return Promise.resolve(audioCtx);
    }
    // Audio output latency (seconds) — how long after currentTime the sound is
    // actually HEARD. Device-dependent (Bluetooth/HDMI/onboard buffers); osu
    // compensates for it, so we do too, otherwise taps feel late by this amount.
    function audioLatency() {
      if (!audioCtx) return 0;
      const l = (typeof audioCtx.outputLatency === 'number' && audioCtx.outputLatency) || audioCtx.baseLatency || 0;
      return Math.min(l || 0, 0.4);
    }

    // ---- Library / song select --------------------------------------------
    async function loadBundled() {
      const entries = [];
      try {
        const manifest = await fetch('assets/vsrg/bundled.json').then((r) => r.json());
        for (const m of manifest) {
          const base = m.dir.replace(/\/$/, '');
          const osuText = await fetch(base + '/' + m.osu).then((r) => r.text());
          let chart;
          try { chart = parseOsu(osuText); } catch (e) { continue; }
          if (!KEY_MAPS[chart.keyCount]) continue;     // no keymap for this key count
          const hash = await sha256(osuText);
          entries.push({
            id: 'bundled:' + m.id,
            source: 'bundled',
            title: chart.title, artist: chart.artist, diffName: chart.diffName,
            keyCount: chart.keyCount, od: chart.overallDifficulty, hash: hash,
            stars: difficultyStars(chart),
            getOsuText: () => Promise.resolve(osuText),
            getAudio: () => fetch(base + '/' + m.audio).then((r) => r.arrayBuffer()),
            getArt: () => m.bg ? fetch(base + '/' + m.bg).then((r) => r.blob()).catch(() => null) : Promise.resolve(null),
          });
        }
      } catch (e) { /* no bundled maps — fine */ }
      return entries;
    }

    function passesFilter(entry) {
      if (keyFilter === 'all') return true;
      return String(entry.keyCount) === String(keyFilter);
    }

    function renderSongList() {
      if (selector) { selector.setEntries(library.filter(passesFilter)); return; }
      if (!songlistEl) return;
      const items = library.filter(passesFilter);
      if (items.length === 0) {
        songlistEl.innerHTML = '<div class="vsrg-empty">' +
          escapeH(t('mp.library_empty') || 'No songs. Import your osu! Songs folder to add maps.') + '</div>';
        return;
      }
      songlistEl.innerHTML = items.map((e, i) =>
        '<button class="vsrg-song" data-i="' + library.indexOf(e) + '">' +
          '<span class="vsrg-song-title">' + escapeH(e.title || '(untitled)') + '</span>' +
          '<span class="vsrg-song-meta">' + escapeH(e.artist || '') +
            ' · ' + escapeH(e.diffName || '') + ' · ' + e.keyCount + 'K' +
            (e.stars ? ' · ~' + e.stars.toFixed(1) + '★' : '') + '</span>' +
        '</button>'
      ).join('');
    }

    function escapeH(s) { return deps.escapeHtml ? deps.escapeHtml(String(s)) : String(s); }

    async function refreshLibrary() {
      const bundled = await loadBundled();
      let cached = [];
      try { cached = await loadCachedOsz(); } catch (e) { /* none */ }
      // cached .osz (persisted) + this session's folder import + bundled
      library = bundled.concat(cached).concat(localEntries);
      renderSongList();
    }

    // ---- Folder import --------------------------------------------------------
    // Uses <input webkitdirectory>, NOT the File System Access API: osu! stable
    // installs to %LOCALAPPDATA%\osu!\Songs, which Chrome's File System Access
    // blocklist refuses to open ("this folder contains system files").
    // webkitdirectory has no such blocklist. Tradeoff: no cross-session
    // persistence — the folder is re-picked each visit (PBs still persist, keyed
    // by chart hash).
    function importFolder() {
      if (!importInput) {
        setImportStatus('Folder import is unavailable in this browser. Bundled songs still work.');
        return;
      }
      importInput.value = '';     // allow re-picking the same folder
      importInput.click();
    }

    async function handleImportFiles(fileList) {
      if (!fileList || !fileList.length) return;
      try {
        setImportStatus('Scanning… (a full osu! Songs folder can take a while)');
        const res = await scanFileList(fileList, function (n) {
          setImportStatus('Scanning… ' + n + ' .osu files seen');
        });
        localEntries = res.entries;
        const std = await routeForeign(res.foreign);   // standard charts → the Standard library
        let skinName = null;                            // a skin folder in the tree → Standard's skin
        if (window.OsuStdGame && window.OsuStdGame.importSkinFromFolder) {
          try { skinName = await window.OsuStdGame.importSkinFromFolder(fileList); } catch (e) {}
        }
        await refreshLibrary();
        const s = res.stats;
        const stdNote = (std ? ' · ' + std + ' standard → Standard' : '') + (skinName ? ' · skin “' + skinName + '” → Standard' : '');
        if (res.entries.length === 0) {
          setImportStatus(
            (std ? std + ' standard map(s) routed to Standard. ' : '') +
            (skinName ? 'Skin “' + skinName + '” → Standard. ' : '') +
            'No osu!mania maps in ' + s.scanned + ' .osu file(s): ' +
            s.skippedNonMania + ' not osu!mania, ' + s.skippedKeys + ' unsupported key count, ' +
            s.skippedNoAudio + ' missing audio.'
          );
        } else {
          setImportStatus('Imported ' + res.entries.length + ' mania map(s)' + stdNote + ' from ' + s.scanned +
            ' .osu file(s). Mania maps stay for this session — re-import after reloading.');
        }
      } catch (e) {
        setImportStatus('Import failed: ' + ((e && e.message) || e));
        try { console.error('[vsrg] import error', e); } catch (_) {}
      }
    }

    function setImportStatus(msg) { if (importStatusEl) importStatusEl.textContent = msg; }

    // Scan a webkitdirectory FileList: group files by their parent directory (via
    // webkitRelativePath) so each .osu resolves its audio sibling, then parse and
    // filter exactly like a beatmapset folder. Returns { entries, stats } so the
    // caller can explain skips (osu! libraries are mostly osu!standard, unplayable
    // here). onProgress(scannedCount) fires periodically for large folders.
    async function scanFileList(fileList, onProgress) {
      const byDir = new Map();
      for (const f of fileList) {
        const rel = f.webkitRelativePath || f.name;
        const slash = rel.lastIndexOf('/');
        const dir = slash >= 0 ? rel.slice(0, slash) : '';
        let m = byDir.get(dir);
        if (!m) { m = new Map(); byDir.set(dir, m); }
        m.set(f.name.toLowerCase(), f);   // lower-cased for case-insensitive audio match
      }
      const out = [], foreign = [];
      const stats = { scanned: 0, skippedNonMania: 0, skippedKeys: 0, skippedNoAudio: 0 };
      for (const files of byDir.values()) {
        const sampleNames = [...files.keys()];
        const getU8 = async (nm) => { const ff = files.get(nm); return ff ? new Uint8Array(await ff.arrayBuffer()) : null; };
        for (const [name, f] of files) {
          if (!name.endsWith('.osu')) continue;
          stats.scanned++;
          if (onProgress && stats.scanned % 50 === 0) onProgress(stats.scanned);
          let osuText;
          try { osuText = await f.text(); } catch (e) { continue; }
          let chart;
          try { chart = parseOsu(osuText); }
          catch (e) {   // not osu!mania — collect for standard routing instead of dropping it
            stats.skippedNonMania++;
            try { const rec = await buildForeign(osuText, getU8, sampleNames); if (rec) foreign.push(rec); } catch (_) {}
            continue;
          }
          if (!KEY_MAPS[chart.keyCount]) { stats.skippedKeys++; continue; }
          const audio = files.get(String(chart.audioFile).toLowerCase()) || null;
          if (!audio) { stats.skippedNoAudio++; continue; }
          const art = chart.backgroundFile ? (files.get(chart.backgroundFile.toLowerCase()) || null) : null;
          const hash = await sha256(osuText);
          out.push({
            id: 'local:' + hash,
            source: 'local',
            title: chart.title, artist: chart.artist, diffName: chart.diffName,
            keyCount: chart.keyCount, od: chart.overallDifficulty, hash: hash,
            stars: difficultyStars(chart),
            getOsuText: () => f.text(),
            getAudio: () => audio.arrayBuffer(),
            getSamples: () => R.collectSamples(sampleNames,getU8,chart.audioFile),
            getArt: () => Promise.resolve(art),    // File (Blob) or null
          });
        }
      }
      return { entries: out, stats: stats, foreign: foreign };
    }
    // Build a portable record of a chart this mode can't play, so the OTHER mode
    // (osu!standard) can store it — getU8(name) returns the file's bytes (Uint8Array).
    async function buildForeign(osuText, getU8, sampleNames) {
      const meta = parseMeta(osuText);
      const audio = await getU8(String(meta.audioFile).toLowerCase());
      if (!audio) return null;
      const bg = parseBackground((splitSections(osuText).Events || []).join('\n'));
      const art = bg ? await getU8(bg.toLowerCase()) : null;
      return { osuText: osuText, audio: audio, art: art || null, samples: await R.collectSamples(sampleNames, getU8, meta.audioFile) };
    }
    // Hand collected non-mania charts to osu!standard; returns how many it accepted.
    async function routeForeign(list) {
      if (!list.length || !window.OsuStdGame || !window.OsuStdGame.importForeignCharts) return 0;
      try { return (await window.OsuStdGame.importForeignCharts(list)) || 0; } catch (e) { return 0; }
    }

    // ---- .osz import (unzip in-browser, cache so it persists) ----------------
    function setOszStatus(msg) { if (oszStatusEl) oszStatusEl.textContent = msg; }

    async function handleOszFiles(fileList) {
      if (!fileList || !fileList.length) return;
      let imported = 0, scanned = 0, skipped = 0, failed = 0; const foreign = [];
      try {
        for (const file of fileList) {
          setOszStatus('Reading ' + file.name + '…');
          let entries;
          try { entries = await unzip(await file.arrayBuffer()); }
          catch (e) { failed++; setOszStatus('Could not read ' + file.name + ': ' + ((e && e.message) || e)); continue; }
          // index entry files by base filename (lower-cased) for sibling lookup
          let byName = new Map(), sampleNames = [];
          const getU8 = (nm) => byName.get(nm) || null;
          for (const [nm, bytes] of entries) {
            if (!nm.toLowerCase().endsWith('.osu')) continue;
            byName = R.archiveFiles(entries,nm); sampleNames = [...byName.keys()];
            scanned++;
            const osuText = new TextDecoder().decode(bytes);
            let chart;
            try { chart = parseOsu(osuText); }
            catch (e) {   // not osu!mania — collect for standard routing instead of counting it skipped
              try { const rec = await buildForeign(osuText, getU8, sampleNames); if (rec) foreign.push(rec); } catch (_) {}
              continue;
            }
            if (!KEY_MAPS[chart.keyCount]) { skipped++; continue; }
            const audio = byName.get(String(chart.audioFile).toLowerCase());
            if (!audio) { skipped++; continue; }
            const art = chart.backgroundFile ? (byName.get(chart.backgroundFile.toLowerCase()) || null) : null;
            const hash = await sha256(osuText);
            await idbPut('osz', hash, {
              title: chart.title, artist: chart.artist, diffName: chart.diffName,
              keyCount: chart.keyCount, od: chart.overallDifficulty, hash: hash,
              stars: difficultyStars(chart),
              osuText: osuText, audio: audio, art: art, samples: await R.collectSamples(sampleNames,getU8,chart.audioFile),    // Uint8Arrays (structured-cloned)
            });
            imported++;
          }
        }
        const std = await routeForeign(foreign);   // standard charts in the .osz → the Standard library
        skipped += (foreign.length - std);          // non-mania charts standard couldn't take either
        await refreshLibrary();
        setOszStatus('Imported ' + imported + ' mania map(s)' +
          (std ? ' · ' + std + ' standard → Standard' : '') +
          (skipped ? ' · ' + skipped + ' skipped (unsupported / no audio)' : '') +
          (failed ? ' · ' + failed + ' file(s) unreadable' : '') + '. Saved — they persist across reloads.');
      } catch (e) {
        setOszStatus('Import failed: ' + ((e && e.message) || e));
        try { console.error('[vsrg] osz import error', e); } catch (_) {}
      }
    }

    async function loadCachedOsz() {
      const all = await idbGetAll('osz');
      return (all || []).filter((s) => KEY_MAPS[s.keyCount]).map((s) => ({
        id: 'osz:' + s.hash, source: 'osz',
        title: s.title, artist: s.artist, diffName: s.diffName,
        keyCount: s.keyCount, od: s.od, hash: s.hash,
        stars: (typeof s.stars === 'number') ? s.stars : difficultyStars(parseOsu(s.osuText)),
        getOsuText: () => Promise.resolve(s.osuText),
        getSamples: () => Promise.resolve(s.samples || []),
        getAudio: () => Promise.resolve(s.audio.slice().buffer),     // fresh copy each play
        getArt: () => Promise.resolve(s.art ? new Blob([s.art]) : null),
      }));
    }

    // Minimal ZIP reader: parse the central directory and inflate each entry with
    // DecompressionStream('deflate-raw'). Sizes come from the central directory so
    // entries written with a data descriptor still work. Returns Map(name -> bytes).
    async function unzip(arrayBuffer) {
      const dv = new DataView(arrayBuffer);
      const u8 = new Uint8Array(arrayBuffer);
      const n = dv.byteLength;
      let eocd = -1;
      for (let i = n - 22; i >= 0 && i >= n - 22 - 65536; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('not a valid .osz/zip file');
      const count = dv.getUint16(eocd + 10, true);
      let off = dv.getUint32(eocd + 16, true);
      const headers = [];
      for (let i = 0; i < count; i++) {
        if (dv.getUint32(off, true) !== 0x02014b50) break;
        const method = dv.getUint16(off + 10, true);
        const compSize = dv.getUint32(off + 20, true);
        const nameLen = dv.getUint16(off + 28, true);
        const extraLen = dv.getUint16(off + 30, true);
        const commentLen = dv.getUint16(off + 32, true);
        const localOff = dv.getUint32(off + 42, true);
        const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
        headers.push({ name: name, method: method, compSize: compSize, localOff: localOff });
        off += 46 + nameLen + extraLen + commentLen;
      }
      const out = new Map();
      for (const h of headers) {
        if (h.name.endsWith('/')) continue;       // directory entry
        const lhNameLen = dv.getUint16(h.localOff + 26, true);
        const lhExtraLen = dv.getUint16(h.localOff + 28, true);
        const dataStart = h.localOff + 30 + lhNameLen + lhExtraLen;
        const comp = u8.subarray(dataStart, dataStart + h.compSize);
        let bytes;
        if (h.method === 0) bytes = comp.slice();                 // stored
        else if (h.method === 8) bytes = await inflateRaw(comp);  // deflate
        else continue;                                            // unsupported
        out.set(h.name, bytes);
      }
      return out;
    }

    async function inflateRaw(u8) {
      const ds = new DecompressionStream('deflate-raw');
      const ab = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(ab);
    }

    // ---- Speed preview (mini highway in song-select; updates live with slider) -
    let previewRaf = 0;
    function startSpeedPreview() {
      if (!speedPreview || previewRaf || document.hidden || (selector && !speedPreview.closest('details')?.open)) return;
      const g = speedPreview.getContext('2d');
      const W = speedPreview.width, H = speedPreview.height, lanes = 4;
      const laneW = W / lanes, hitY = H - 24, spacing = 360;
      function frame(ts) {
        const appr = approachMs();          // live: reflects speed changes
        const style = noteStyle(), scale = noteScale();
        g.clearRect(0, 0, W, H);
        g.fillStyle = '#0e0f13'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#3a4050'; g.fillRect(0, hitY, W, 2);
        for (let lane = 0; lane < lanes; lane++)
          drawReceptor(g, style, laneColor(lane), lane * laneW, laneW, hitY - 9, 18, 1, arrowDir(lane), false);
        for (let lane = 0; lane < lanes; lane++) {
          const phase = (ts + lane * 137) % appr;        // stagger lanes for a real-ish pattern
          for (let k = 0; k <= Math.ceil(appr / spacing); k++) {
            const noteAge = phase - k * spacing;         // ms since this note spawned
            if (noteAge < 0 || noteAge > appr) continue;
            drawTap(g, style, laneColor(lane), lane * laneW, laneW, (noteAge / appr) * hitY, scale, 1, arrowDir(lane));
          }
        }
        previewRaf = requestAnimationFrame(frame);
      }
      previewRaf = requestAnimationFrame(frame);
    }
    if (selector) {
      speedPreview?.closest('details')?.addEventListener('toggle', () => { stopSpeedPreview(); startSpeedPreview(); });
      document.addEventListener('visibilitychange', () => { stopSpeedPreview(); if (!document.hidden && panelOpen && !screens.select.hidden) startSpeedPreview(); });
    }
    function stopSpeedPreview() { if (previewRaf) cancelAnimationFrame(previewRaf); previewRaf = 0; }

    // ---- Tap-to-the-beat calibration ----------------------------------------
    // Plays a steady metronome; each tap's offset from the nearest beat is
    // collected, and after enough taps the trimmed mean becomes the offset.
    let tapState = null;
    function tapReset() {
      tapState = null;
      if (tapResultEl) tapResultEl.textContent = '';
      if (tapBtn) tapBtn.textContent = 'Tap to the beat';
    }
    function registerTap(perfTs) {
      if (!tapState) return;
      const tapCtx = R.createClock(audioCtx,0).at(R.eventTime(perfTs)) / 1000;
      const k = Math.round((tapCtx - tapState.baseTick) / tapState.period);
      const beat = tapState.baseTick + k * tapState.period;
      if (k < 0) return;                                  // before the first beat
      const errMs = (tapCtx - beat) * 1000;       // vs the HEARD beep (same shift as gameplay)
      if (Math.abs(errMs) > tapState.period * 1000 / 2) return;   // not near any beat
      tapState.errors.push(errMs);
      const need = 12;
      if (tapBtn) tapBtn.textContent = 'Tap! (' + tapState.errors.length + '/' + need + ')';
      if (tapState.errors.length >= need) finishTapCalibration();
    }
    function finishTapCalibration() {
      const e = tapState.errors.slice().sort((a, b) => a - b);
      const trimmed = e.slice(1, e.length - 1);           // drop the worst outlier each side
      const mean = trimmed.reduce((a, b) => a + b, 0) / (trimmed.length || 1);
      const offset = Math.round(mean);
      settings.vsrgCalibrationOffset = offset;
      if (deps.saveSettings) deps.saveSettings();
      if (calibSlider) calibSlider.value = offset;
      if (calibValEl) calibValEl.textContent = offset + ' ms';
      if (tapResultEl) tapResultEl.textContent = 'Your offset: ' + offset + ' ms (set). Tap again to redo.';
      tapState = null;
      if (tapBtn) tapBtn.textContent = 'Tap to the beat';
    }

    // ---- Loading a chart for play -----------------------------------------
    // Fully stop and discard the current run (audio, RAF loop, input binding).
    function teardownRun() {
      if (!run) return;
      run.disposeReplay?.();
      if(audioCtx)audioCtx.__replaySound=null;
      run.finished = true;
      pauseUI.hide();
      cancelAnimationFrame(run.rafId);
      bindInput(false);
      try { run.src.stop(); } catch (e) {}
      run = null;
      if (fpsEl) fpsEl.textContent = '';
      if (skipBtn) skipBtn.hidden = true;
    }

    async function loadAndPlay(entry) {
      if (loading) return;        // ignore double-clicks / overlapping loads
      loading = true;
      const gen = ++loadGen;      // cancels if close()/quit bumps loadGen mid-load
      teardownRun();              // never leave a previous run/audio running
      lastSong = entry;
      setImportStatus('');
      selector?.stop();
      try {
        const [ac, osuText] = await Promise.all([ensureCtx(), entry.getOsuText()]);
        const chart = parseOsu(osuText);
        const [audioBuf, samples] = await Promise.all([ac.decodeAudioData(await entry.getAudio()), window.Hitsound.prepare(ac, entry.getSamples ? await entry.getSamples() : [])]);
        if (gen !== loadGen || !panelOpen) return;   // user left during the load
        startRun(entry, chart, audioBuf);
        run.samples = samples;
      } catch (_) { show('select');setImportStatus(window.I18N.t('rhythm.load_failed'));selector?.failure();return false;
      } finally {
        loading = false;
      }
    }

    // ---- Gameplay ----------------------------------------------------------
    function defaultKeyMap(keyCount) { return KEY_MAPS[keyCount] || KEY_MAPS[4]; }
    function laneKeyMap(keyCount) {
      const custom = settings.vsrgKeybinds && settings.vsrgKeybinds[keyCount];
      if (custom && custom.length === keyCount) return custom.map((k) => String(k).toLowerCase());
      return defaultKeyMap(keyCount);
    }

    function startRun(entry, chart, audioBuf) {
      teardownRun();                 // defensive: never overlap with a prior run
      stopSpeedPreview();
      if (deps.pauseBgm) deps.pauseBgm();
      stageHud?.start(entry);
      show('game');
      grabFocus();                   // pull keyboard focus into the iframe (Discord Activity)
      sizeCanvas();
      const ac = audioCtx;
      const windows = windowsForOD(chart.overallDifficulty);
      const keyCount = chart.keyCount;
      const keys = laneKeyMap(keyCount);

      const engine = M.createSession(chart);
      const notes = engine.notes;
      const totalJudgements = notes.length;

      // Schedule audio: source starts LEAD_IN after now.
      const startCtx = ac.currentTime + LEAD_IN_MS / 1000;
      const src = ac.createBufferSource();
      const gain = ac.createGain();
      gain.gain.value = Math.max(0, Math.min(1, Number.isFinite(Number(settings.musicVol)) ? Number(settings.musicVol) / 100 : 0.6));
      src.buffer = audioBuf;
      src.connect(gain).connect(ac.destination);
      src.start(startCtx);

      // Capture perf<->ctx mapping for input timestamp conversion.
      const t0perf = performance.now();
      const t0ctx = ac.currentTime;

      const firstNoteTime = notes.reduce((m, n) => Math.min(m, n.time), Infinity);
      run = {
        entry, chart, notes, keys, keyCount, windows, src, gain, audioBuf, engine,
        clock: R.createClock(ac, startCtx), paused: false,
        startCtx, t0perf, t0ctx, totalJudgements,
        approachMs: approachMs(),     // visual scroll speed, snapshot at run start
        state: engine.state,
        lastNoteTime: notes.reduce((m, n) => Math.max(m, n.endTime || n.time), 0),
        finished: false, rafId: 0, pressed: {},
        errors: [],                   // signed hit-timing errors (ms) for UR + the bar
        auto: autoplay,
        // Skip target: jump to ~1.5s before the first note if the intro is long enough.
        firstNoteTime: isFinite(firstNoteTime) ? firstNoteTime : 0,
        skipTo: Math.max(0, (isFinite(firstNoteTime) ? firstNoteTime : 0) - 1500), skipped: false,
      };
      run.state.totalNotes = totalJudgements;
      errTicks = [];                 // clear the error bar for the new run

      // Album art (async): draw dimmed behind the highway once it decodes.
      if (entry.getArt) {
        entry.getArt().then((blob) => {
          if (!blob || !run || run.entry !== entry) return;
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { if (run && run.entry === entry) run.artImg = img; URL.revokeObjectURL(url); };
          img.onerror = () => URL.revokeObjectURL(url);
          img.src = url;
        }).catch(() => {});
      }

      src.onended = () => {};   // end is driven by song-time, not this event
      fpsFrames = 0; fpsLast = performance.now(); fpsPrev = 0; fpsMaxDt = 0;
      bindInput(true);
      run.activityRun = !run.auto ? window.ActivityGames?.newRun() : null;
      run.replay = window.ActivityReplay?.begin(run, 'vsrg', {snapshot:captureReplayView,draw:render});
      if(run.replay){run.replay.data.musicVolume=run.gain.gain.value;const capture=run.replay,clock=run.clock;audioCtx.__replaySound=sound=>capture.sound(clock.at(),sound);}
      run.rafId = requestAnimationFrame(loop);
      sizeCanvas();
      updateHud();
    }

    // Current song time in ms from live audio clock.
    // Measured against the audio the user actually HEARS (shifted back by output
    // latency) so the default timing matches osu across devices; calOffset is then
    // a small personal fine-tune, not a per-device latency band-aid.
    function songTimeNow() { return run.clock.at() - calOffset(); }
    // Map an input performance.now() timestamp to song time (with calibration).
    function inputSongTime(perfTs) { return run.clock.at(R.eventTime(perfTs)) - calOffset(); }

    function loop() {
      if (!run || run.finished || run.paused) return;
      const st = songTimeNow();
      stageHud?.update(st, run.lastNoteTime);
      if (run.auto) autoPlay(st);   // preview: hit each note on time, hold through tails
      sweepMisses(st);
      render(st + calOffset() + (Number(settings.vsrgVisualOffset) || 0));
      if (run.replay) {
        const held = Object.keys(heldLanes()).reduce((mask,lane)=>mask|(1<<Number(lane)),0);
        run.replay.sample(st + calOffset(), st + calOffset() + (Number(settings.vsrgVisualOffset) || 0), null, held, run.state.counts, run.state.combo, run.approachMs);
      }
      tickFps();
      updateSkip(st);
      if (st > run.lastNoteTime + END_PAD_MS) { finishRun(); return; }
      run.rafId = requestAnimationFrame(loop);
    }
    // Skip button: offered during a long intro; fast-forwards the audio + clock to
    // ~1.5s before the first note (like osu's Skip).
    function updateSkip(st) {
      if (!skipBtn) return;
      const show = !run.skipped && run.skipTo > 800 && st < run.skipTo - 100;
      if (skipBtn.hidden === show) skipBtn.hidden = !show;
    }
    function doSkip() {
      if (!run || run.finished || run.skipped) return;
      if (songTimeNow() >= run.skipTo - 50) return;
      const ac = audioCtx, when = ac.currentTime;
      try { run.src.stop(); } catch (e) {}
      const src = ac.createBufferSource();
      src.buffer = run.audioBuf; src.connect(run.gain);     // gain already wired to destination
      src.start(when, run.skipTo / 1000);
      run.src = src;
      run.startCtx = when - run.skipTo / 1000; run.clock.reset(run.startCtx);               // songTimeNow now reads ~skipTo
      run.t0ctx = ac.currentTime; run.t0perf = performance.now();   // re-sync input→ctx mapping
      run.skipped = true;
      run.replay?.skip(run.skipTo);
      skipBtn.hidden = true;
    }
    // FPS counter: frames over the last ~half-second. The loop is a bare rAF, so
    // this is the display's refresh rate (60 / 144 / 240… as fast as the monitor +
    // render cost allow) — no artificial frame cap.
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

    // Mark notes whose hit window has fully passed as misses.
    function sweepMisses(st) { run.engine.advance(st); flushEngine(); }

    // Deliver the pure engine's events to audio and UI once per update.
    function flushEngine() {
      const events = run.engine.takeEvents();
      for (const e of events) {
        if (e.kind === 'sound') { playHitsound(e.note); continue; }
        run.replay?.mark(e.note, e.kind, e.tier, run.clock.at());
        if (Number.isFinite(e.error) && e.tier !== 'miss') recordError(e.error, e.tier);
        if (e.kind === 'judge') { flashJudge(e.tier); pushFx(e.note.lane, e.tier === 'miss' ? 'miss' : 'hit', TIER_COLORS[e.tier]); }
        else if (e.kind === 'break') { flashJudge('miss'); pushFx(e.note.lane, 'miss', TIER_COLORS.miss); }
        else if (e.kind === 'head') pushFx(e.note.lane, 'hit', TIER_COLORS[e.tier]);
      }
      if (events.length) updateHud();
    }



    // Record a signed timing error (negative = early, positive = late) for the
    // unstable-rate bar (live, fading ticks) and the run's UR stat.
    let errTicks = [];
    function recordError(errMs, tier) {
      if (run) {
        run.errors.push(errMs);
        const n=run.errors.length, delta=errMs-(run.errorMean || 0);
        run.errorMean=(run.errorMean || 0)+delta/n;
        run.errorM2=(run.errorM2 || 0)+delta*(errMs-run.errorMean);
      }
      errTicks.push({ err: errMs, tier: tier, t: performance.now() });
      if (errTicks.length > 64) errTicks.shift();
    }
    // Unstable rate = stdev of hit errors × 10 (osu definition).
    function unstableRate(errs) {
      if (!errs || errs.length < 2) return 0;
      const m = errs.reduce((a, b) => a + b, 0) / errs.length;
      const v = errs.reduce((s, e) => s + (e - m) * (e - m), 0) / errs.length;
      return Math.sqrt(v) * 10;
    }

    // ---- Autoplay (preview): hit every note perfectly, no score saved --------
    function autoPlay(st) {
      run.engine.auto(st);
      run.pressed = Object.fromEntries([...run.engine.held].map(lane => [lane, true]));
      flushEngine();
    }

    // ---- Input -------------------------------------------------------------
    function onHit(lane, perfTs) {
      if (!run || run.finished || run.auto || run.paused) return;
      run.replay?.input(inputSongTime(perfTs)+calOffset(),lane,true);
      run.engine.press(lane, inputSongTime(perfTs)); flushEngine();
    }
    function playHitsound(note) { if (window.Hitsound && audioCtx) window.Hitsound.playNote(audioCtx, run.samples, R.soundSpec(run.chart, note || {}, note ? note.time : songTimeNow())); }   // shared engine (hitsound.js)

    function onRelease(lane, perfTs) {
      if (!run || run.finished || run.auto || run.paused) return;
      if (heldLanes()[lane]) return;
      run.replay?.input(inputSongTime(perfTs)+calOffset(),lane,false);
      run.engine.release(lane, inputSongTime(perfTs)); flushEngine();
    }

    // Input timestamps use e.timeStamp (when the event actually occurred, same
    // epoch as performance.now()) rather than sampling inside the handler, so a
    // main-thread stall can't turn into bogus hit error.
    function onKeyDown(e) {
      if (!run || run.finished) return;
      if (e.key === 'Escape') { e.preventDefault(); if (!run.paused) pauseRun(); return; }
      if (run.paused) { const lane=run.keys.indexOf(e.key.toLowerCase()); if(lane>=0) { run.pressed[lane]=true; e.preventDefault(); } return; }
      if ((e.key === ' ' || e.code === 'Space') && skipBtn && !skipBtn.hidden) { e.preventDefault(); doSkip(); return; }
      if (handleControlKey(e.key)) { e.preventDefault(); return; }   // 1/2 speed, -/= offset
      const lane = run.keys.indexOf(e.key.toLowerCase());
      if (lane < 0 || run.pressed[lane]) return;     // ignore auto-repeat
      run.pressed[lane] = true;
      e.preventDefault();
      pushFx(lane, 'press', '#ffffff');              // every press flashes its lane
      onHit(lane, e.timeStamp);
    }
    function onKeyUp(e) {
      if (!run || run.finished) return;
      const lane = run.keys.indexOf(e.key.toLowerCase());
      if (lane < 0) return;
      run.pressed[lane] = false;
      onRelease(lane, e.timeStamp);
    }
    function laneFromX(clientX) {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      return Math.max(0, Math.min(run.keyCount - 1, Math.floor(x / (rect.width / run.keyCount))));
    }
    function onPointerDown(e) {
      if (!run || run.finished || run.paused) return;
      e.preventDefault();
      // Capture the pointer so pointerup/cancel still fire here even if the
      // finger slides off the canvas mid-hold (otherwise the hold tail auto-misses).
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      const lane = laneFromX(e.clientX);
      run.pressed['p' + e.pointerId] = lane;
      pushFx(lane, 'press', '#ffffff');
      onHit(lane, e.timeStamp);
    }
    function onPointerUp(e) {
      if (!run || run.finished) return;
      const lane = run.pressed['p' + e.pointerId];
      if (lane == null) return;
      delete run.pressed['p' + e.pointerId];
      onRelease(lane, e.timeStamp);
    }

    // ---- Rendering ---------------------------------------------------------
    function sizeCanvas() {
      const r = panel.getBoundingClientRect();
      const laneSize = Number(settings.vsrgLaneWidth) || 72;
      const w = Math.min(laneSize * (run ? run.keyCount : 4), r.width);
      // Cap backing-store resolution (≤1.5×) so high-DPR / 4K screens don't fill 2–4×
      // the pixels each frame — the usual cause of lag on weaker GPUs. CSS size is
      // unchanged, so layout/aim are unaffected; the canvas is just slightly softer.
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round((r.height - 0) * scale);
      canvas.style.width = w + 'px';
      canvas.style.height = (r.height) + 'px';
    }

    // Transient hit/press effects drawn at the judgement line.
    // kind: 'press' (white pulse), 'hit' (tier ring + pulse), 'miss' (red pulse).
    let hitFx = [];
    function pushFx(lane, kind, color) {
      hitFx.push({ lane: lane, kind: kind, color: color, t: performance.now() });
      if (hitFx.length > 48) hitFx.shift();
    }

    function heldLanes() {
      const held = {};
      for (const k in run.pressed) {
        if (k.charAt(0) === 'p') held[run.pressed[k]] = true;   // pointer -> lane
        else if (run.pressed[k]) held[k] = true;                // keyboard lane bool
      }
      return held;
    }

    function liveRenderView() {
      return {canvas,ctx2d,run,dpr:canvas.width/canvas.getBoundingClientRect().width,now:performance.now(),
        settings:{vsrgReceptorPosition:settings.vsrgReceptorPosition,vsrgConstantScroll:settings.vsrgConstantScroll,vsrgUpscroll:settings.vsrgUpscroll},
        held:heldLanes(),style:noteStyle(),scale:noteScale(),colors:Array.from({length:run.keyCount},(_,i)=>laneColor(i)),hitFx,errTicks};
    }
    function captureReplayView(st) {
      const v=liveRenderView(),hitY=canvas.height*(Number(settings.vsrgReceptorPosition)||.85);
      const position=t=>settings.vsrgConstantScroll?t:R.scrollAt(run.chart.scroll,t);
      const yAt=t=>hitY-(position(t)-position(st))/run.approachMs*hitY;
      v.canvas={width:canvas.width,height:canvas.height};delete v.ctx2d;
      v.run={keyCount:run.keyCount,chart:run.chart,approachMs:run.approachMs,artImg:run.artImg,windows:run.windows,
        errors:{length:run.errors.length},errorMean:run.errorMean,
        notes:run.notes.filter(n=>!(n.headJudged&&(n.endTime==null||n.tailJudged)) &&
          (n.endTime!=null ? Math.min(yAt(n.endTime),n.holding?hitY:yAt(n.time))<canvas.height+36*v.dpr && Math.max(yAt(n.endTime),n.holding?hitY:yAt(n.time))>-36*v.dpr : yAt(n.time)>-36*v.dpr&&yAt(n.time)<canvas.height+18*v.dpr)).map(n=>({...n}))};
      v.hitFx=hitFx.slice();v.errTicks=errTicks.slice();v.replay=true;
      v.hud=window.ActivityReplay.captureHud(canvas,[comboEl,accEl,judgeEl,infoEl,fpsEl,skipBtn]);
      return v;
    }
    function render(st, view=liveRenderView()) {
      const {canvas,ctx2d,run,dpr,settings,hitFx,errTicks}=view;
      const W = canvas.width, H = canvas.height;
      const keyCount = run.keyCount;
      const laneW = W / keyCount;
      const hitY = H * (Number(settings.vsrgReceptorPosition) || 0.85);
      const position = time => settings.vsrgConstantScroll ? time : R.scrollAt(run.chart.scroll, time);
      const yAt = time => hitY - (position(time) - position(st)) / run.approachMs * hitY;
      const flip = settings.vsrgUpscroll === true;
      const noteH = 18 * dpr;
      const recH = 22 * dpr;
      const held = view.held;
      const nowP = view.now;

      ctx2d.clearRect(0, 0, W, H);
      ctx2d.save();
      if (flip) { ctx2d.translate(0, H); ctx2d.scale(1, -1); }
      ctx2d.fillStyle = '#081b2b'; ctx2d.fillRect(0, 0, W, H);
      // album art: cover-fit, heavily dimmed so notes stay readable
      if (run.artImg) {
        const iw = run.artImg.naturalWidth, ih = run.artImg.naturalHeight;
        if (iw && ih) {
          const scale = Math.max(W / iw, H / ih);
          const dw = iw * scale, dh = ih * scale;
          ctx2d.globalAlpha = 0.10;
          ctx2d.drawImage(run.artImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
          ctx2d.globalAlpha = 1;
        }
      }
      for (let i = 0; i < keyCount; i++) {
        ctx2d.fillStyle = held[i] ? 'rgba(255,255,255,0.09)' : ((i % 2) ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)');
        ctx2d.fillRect(i * laneW, 0, laneW, H);
        if (held[i]) {
          const beam=ctx2d.createLinearGradient(0,Math.max(0,hitY-H*.45),0,hitY);
          beam.addColorStop(0,'transparent');beam.addColorStop(1,view.colors[i]+'55');
          ctx2d.fillStyle=beam;ctx2d.fillRect(i*laneW,Math.max(0,hitY-H*.45),laneW,H*.45);
        }
      }
      // judgement line
      ctx2d.fillStyle = '#74cde9'; ctx2d.fillRect(0, hitY - 2 * dpr, W, 4 * dpr);

      // receptors (style-aware; filled + glowing while the lane key is held)
      const style = view.style;
      const scale = view.scale;
      for (let i = 0; i < keyCount; i++) {
        const color = view.colors[i];
        if (held[i]) drawReceptor(ctx2d, style, color, i * laneW, laneW, hitY, recH, dpr, arrowDir(i), true);
        drawReceptor(ctx2d, style, color, i * laneW, laneW, hitY, recH, dpr, arrowDir(i), false);
      }

      // notes (holds first so taps/caps draw on top)
      for (const n of run.notes) {
        if (n.headJudged && (n.endTime == null || n.tailJudged)) continue;
        const color = view.colors[n.lane];
        const dir = arrowDir(n.lane);
        const laneX = n.lane * laneW;
        const yHead = yAt(n.time);

        if (n.endTime != null) {
          const yTail = yAt(n.endTime);
          drawHold(ctx2d, style, color, laneX, laneW, yHead, yTail, n.holding, hitY, scale, dpr, dir);
        }
        if (!n.headJudged && yHead > -noteH * 2 && yHead < H + noteH) {
          drawTap(ctx2d, style, color, laneX, laneW, yHead, scale, dpr, dir);
        }
      }

      // --- hit/press effects at the line ---
      for (let i = hitFx.length - 1; i >= 0; i--) {
        const f = hitFx[i];
        const dur = f.kind === 'press' ? 130 : 280;
        const age = nowP - f.t;
        if (age > dur) { if(!view.replay) hitFx.splice(i, 1); continue; }
        const k = age / dur;                       // 0..1 progress
        const cx = f.lane * laneW + laneW / 2;
        ctx2d.save();
        if (f.kind === 'hit') {
          // expanding ring + bright receptor flash
          ctx2d.globalAlpha = 1 - k;
          ctx2d.strokeStyle = f.color;
          ctx2d.lineWidth = (3 * (1 - k) + 1) * dpr;
          ctx2d.beginPath();
          ctx2d.arc(cx, hitY + recH / 2, (laneW * 0.18 + k * laneW * 0.55), 0, Math.PI * 2);
          ctx2d.stroke();
          ctx2d.globalAlpha = (1 - k) * 0.7;
          ctx2d.fillStyle = f.color;
          ctx2d.fillRect(f.lane * laneW + 4 * dpr, hitY - 4 * dpr, laneW - 8 * dpr, recH + 8 * dpr);
        } else {
          // press / miss: quick receptor pulse (no ring)
          ctx2d.globalAlpha = (1 - k) * (f.kind === 'miss' ? 0.5 : 0.4);
          ctx2d.fillStyle = f.color;
          ctx2d.fillRect(f.lane * laneW + 4 * dpr, hitY, laneW - 8 * dpr, recH);
        }
        ctx2d.restore();
      }

      ctx2d.restore();
      drawErrorBar(W, H, dpr, view);
    }

    // Unstable-rate / hit-error bar near the bottom: ticks left of centre = early,
    // right = late. Background zones show the perfect/great/good windows; a marker
    // shows the running mean. Ticks fade over ~2.5s.
    function drawErrorBar(W, H, dpr, view) {
      const {ctx2d,run,errTicks}=view;
      const w = run.windows;
      const cx = W / 2, y = H - 46 * dpr, half = W * 0.34;
      const pxPerMs = half / (w.bad || 127);          // full bar = ±bad window
      const zone = (ms, color) => {
        ctx2d.fillStyle = color;
        ctx2d.fillRect(cx - ms * pxPerMs, y - 5 * dpr, ms * pxPerMs * 2, 10 * dpr);
      };
      zone(w.good, 'rgba(245,158,11,0.20)');
      zone(w.great, 'rgba(255,209,102,0.22)');
      zone(w.perfect, 'rgba(57,217,138,0.28)');
      // centre line
      ctx2d.fillStyle = 'rgba(255,255,255,0.6)';
      ctx2d.fillRect(cx - dpr, y - 9 * dpr, 2 * dpr, 18 * dpr);
      // ticks
      const nowP = view.now;
      for (let i = errTicks.length - 1; i >= 0; i--) {
        const e = errTicks[i];
        const age = nowP - e.t;
        if (age > 2500) { if(!view.replay) errTicks.splice(i, 1); continue; }
        const x = cx + Math.max(-half, Math.min(half, e.err * pxPerMs));
        ctx2d.globalAlpha = 1 - age / 2500;
        ctx2d.fillStyle = TIER_COLORS[e.tier] || '#fff';
        ctx2d.fillRect(x - dpr, y - 8 * dpr, 2 * dpr, 16 * dpr);
        ctx2d.globalAlpha = 1;
      }
      // running-mean marker (small triangle under the bar)
      if (run.errors.length >= 3) {
        const mean = run.errorMean || 0;
        const mx = cx + Math.max(-half, Math.min(half, mean * pxPerMs));
        ctx2d.fillStyle = '#9be7ff';
        ctx2d.beginPath();
        ctx2d.moveTo(mx, y + 9 * dpr); ctx2d.lineTo(mx - 4 * dpr, y + 15 * dpr); ctx2d.lineTo(mx + 4 * dpr, y + 15 * dpr);
        ctx2d.closePath(); ctx2d.fill();
      }
    }

    const JUDGE_LABELS = { marvelous: 'MAX', perfect: '300', great: '200', good: '100', bad: '50', miss: 'MISS' };
    function flashJudge(tier) {
      if (!judgeEl) return;
      judgeEl.textContent = JUDGE_LABELS[tier] || tier;
      judgeEl.style.color = TIER_COLORS[tier] || '#fff';
      // pop: snap big+opaque, then settle — gives the readout some punch
      judgeEl.style.transition = 'none';
      judgeEl.style.opacity = '1';
      judgeEl.style.transform = 'scale(1.35)';
      requestAnimationFrame(() => {
        judgeEl.style.transition = 'opacity .32s, transform .18s';
        judgeEl.style.opacity = '0';
        judgeEl.style.transform = 'scale(1)';
      });
    }
    // Brief centred readout for live speed/offset changes during a run.
    function flashInfo(text) {
      if (!infoEl) return;
      infoEl.textContent = text;
      infoEl.style.transition = 'none'; infoEl.style.opacity = '1';
      requestAnimationFrame(() => { infoEl.style.transition = 'opacity .6s'; infoEl.style.opacity = '0'; });
    }
    // In-game control keys (don't clash with lane keys d/f/j/k/s/l/space):
    //   1 = slower, 2 = faster · - = offset earlier, = / + = offset later.
    function handleControlKey(key) {
      if (key === '1' || key === '2') {
        setScrollSpeed(scrollSpeed() + (key === '2' ? 0.1 : -0.1));   // fine step
        flashInfo('Speed ' + scrollSpeed().toFixed(1) + '×');
        return true;
      }
      if (key === '-' || key === '_' || key === '=' || key === '+') {
        const delta = (key === '-' || key === '_') ? -5 : 5;
        settings.vsrgCalibrationOffset = (Number(settings.vsrgCalibrationOffset) || 0) + delta;
        if (deps.saveSettings) deps.saveSettings();
        flashInfo('Offset ' + settings.vsrgCalibrationOffset + ' ms');
        return true;
      }
      return false;
    }
    function updateHud() {
      if (comboEl) {
        comboEl.textContent = run.state.combo > 1 ? run.state.combo + 'x' : '';
        if (run.state.combo > 1) {                 // bump the combo on each gain
          if (comboEl.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            if (run.comboAnimation) run.comboAnimation.cancel();
            run.comboAnimation = comboEl.animate([{transform:'scale(1.12)'},{transform:'scale(1)'}],{duration:140});
          }
        }
      }
      if (accEl) {
        const ur = run.errors.length > 1 ? Math.sqrt((run.errorM2 || 0) / run.errors.length) * 10 : 0;
        accEl.textContent = accuracy(run.state.counts).toFixed(2) + '%' +
          (ur ? '  ·  UR ' + Math.round(ur) : '');
      }
    }

    // ---- End of run / results ---------------------------------------------
    function bindInput(on) {
      const fn = on ? 'addEventListener' : 'removeEventListener';
      window[fn]('keydown', onKeyDown);
      window[fn]('keyup', onKeyUp);
      canvas[fn]('pointerdown', onPointerDown);
      canvas[fn]('pointerup', onPointerUp);
      canvas[fn]('pointercancel', onPointerUp);
    }

    async function finishRun() {
      if (!run || run.finished) return;
      const active = run;
      active.finished = true;
      pauseUI.hide();
      cancelAnimationFrame(active.rafId);
      bindInput(false);
      try { active.src.stop(); } catch (e) {}
      if (!active.auto && active.activityRun) {
        void window.ActivityGames?.complete(active.activityRun, {
          mode: 'vsrg', title: active.entry.title, difficulty: active.entry.diffName,
          getText: () => active.entry.getOsuText(), counts: active.state.counts, maxCombo: active.state.maxCombo,
        }).catch(() => {});
      }
      const acc = accuracy(active.state.counts);
      // Autoplay is a preview — never recorded as a personal best.
      const pb = active.auto ? null : await savePersonalBest('classic-v2:' + active.entry.hash, {
        accuracy: acc, maxCombo: active.state.maxCombo,
        counts: active.state.counts, title: active.entry.title, diffName: active.entry.diffName,
      });
      renderResults(active, acc, pb);
      if (run !== active) return;
      show('results');
      window.ActivityReplay?.mount(resultsBody, active);
    }

    function renderResults(r, acc, pb) {
      const c = r.state.counts;
      resultsBody.innerHTML =
        '<div class="vsrg-res-title">' + escapeH(r.entry.title) + ' · ' + escapeH(r.entry.diffName) + '</div>' +
        '<div class="vsrg-res-acc">' + acc.toFixed(2) + '%</div>' +
        '<div class="vsrg-res-combo">' + r.state.maxCombo + 'x max combo · UR ' + Math.round(unstableRate(r.errors)) + '</div>' +
        '<div class="vsrg-res-breakdown">' +
          'MAX ' + c.marvelous + ' · 300 ' + c.perfect + ' · 200 ' + c.great +
          ' · 100 ' + c.good + ' · 50 ' + c.bad + ' · Miss ' + c.miss +
        '</div>' +
        (r.auto ? '<div class="vsrg-res-pb">Autoplay preview — not saved.</div>'
          : (pb && pb.prev ? '<div class="vsrg-res-pb">Previous best: ' + pb.prev.accuracy.toFixed(2) + '%' +
            (pb.improved ? ' — new best!' : '') + '</div>'
            : '<div class="vsrg-res-pb">First clear — saved as your best.</div>'));
    }

    function quitToSelect() {
      loadGen++;                 // cancel any load still in flight
      teardownRun();
      if (deps.resumeBgm) deps.resumeBgm();
      show('select');
      renderSongList();
      startSpeedPreview();
    }

    // ---- Personal bests (IndexedDB) ---------------------------------------
    async function savePersonalBest(hash, result) {
      const prev = await idbGet('pb', hash);
      const improved = !prev || result.accuracy > prev.accuracy;
      if (improved) {
        await idbPut('pb', hash, {
          accuracy: result.accuracy, maxCombo: result.maxCombo,
          counts: result.counts, title: result.title, diffName: result.diffName,
          date: new Date().toISOString(),
        });
      }
      return { prev: prev, improved: improved };
    }

    // ---- Calibration -------------------------------------------------------
    let calibLoop = null;
    let calibTiming = null;       // { baseTick, period, tc0, tp0 } for tap mapping
    function onTapButton(perfTs) {
      if (!calibTiming) return;
      if (!tapState) tapState = {
        baseTick: calibTiming.baseTick, period: calibTiming.period,
        tc0: calibTiming.tc0, tp0: calibTiming.tp0, errors: [],
      };
      registerTap(perfTs);
    }
    function openCalibration() {
      stopSpeedPreview();
      show('calib');
      tapReset();
      if (calibSlider) {
        calibSlider.value = calOffset();
        if (calibValEl) calibValEl.textContent = calOffset() + ' ms';
      }
      ensureCtx().then((ac) => {
        const cctx = calibCanvas ? calibCanvas.getContext('2d') : null;
        const period = 0.6;                       // 100 BPM metronome
        const baseTick = ac.currentTime + 0.2;    // first beep; flash phase is anchored to this
        calibTiming = { baseTick: baseTick, period: period, tc0: ac.currentTime, tp0: performance.now() };
        let nextTick = baseTick;
        function tick() {
          while (nextTick < ac.currentTime + 0.1) {
            const o = ac.createOscillator(), g = ac.createGain();
            o.frequency.value = 1200;
            g.gain.setValueAtTime(0.0001, nextTick);
            g.gain.exponentialRampToValueAtTime(0.4, nextTick + 0.001);
            g.gain.exponentialRampToValueAtTime(0.0001, nextTick + 0.05);
            o.connect(g).connect(ac.destination);
            o.start(nextTick); o.stop(nextTick + 0.06);
            nextTick += period;
          }
          if (cctx) {
            // Phase is measured from baseTick (when beeps actually fire), not the raw
            // ctx epoch, so flash and beep share a timeline. Same sign as gameplay
            // (inputSongTime subtracts calOffset), and we wrap negatives into [0,period).
            const rel = R.createClock(ac,baseTick).at() / 1000 - calOffset() / 1000;
            const phase = (((rel % period) + period) % period) / period;
            const flash = phase < 0.12 ? 1 : 0;
            cctx.clearRect(0, 0, calibCanvas.width, calibCanvas.height);
            cctx.fillStyle = flash ? '#39d98a' : '#1a1c22';
            cctx.beginPath();
            cctx.arc(calibCanvas.width / 2, calibCanvas.height / 2, 40, 0, Math.PI * 2);
            cctx.fill();
          }
          calibLoop = requestAnimationFrame(tick);
        }
        tick();
      });
    }
    function closeCalibration() {
      if (calibLoop) cancelAnimationFrame(calibLoop);
      calibLoop = null;
      calibTiming = null;
      tapReset();
      show('select');
      startSpeedPreview();        // back on the select screen
    }

    // ---- Appearance sub-screen ----------------------------------------------
    let appearRaf = 0;
    function openAppearance() {
      stopSpeedPreview();
      show('appearance');
      renderAppearanceControls();
      startAppearancePreview();
    }
    function closeAppearance() {
      if (appearRaf) cancelAnimationFrame(appearRaf);
      appearRaf = 0;
      show('select');
      startSpeedPreview();
    }
    function toHex6(c) { return /^#[0-9a-f]{6}$/i.test(c) ? c : '#5b8cff'; }
    function renderAppearanceControls() {
      if (stylePickEl) stylePickEl.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('sel', b.getAttribute('data-style') === noteStyle()));
      if (presetPickEl) presetPickEl.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('sel', b.getAttribute('data-preset') === (settings.vsrgColorPreset || 'default')));
      if (sizeSlider) sizeSlider.value = noteScale();
      if (sizeValEl) sizeValEl.textContent = noteScale().toFixed(1) + '×';
      if (laneColorsEl) {
        laneColorsEl.innerHTML = '';
        for (let i = 0; i < 7; i++) {
          const inp = document.createElement('input');
          inp.type = 'color'; inp.value = toHex6(laneColor(i)); inp.title = 'Lane ' + (i + 1);
          inp.addEventListener('input', () => {
            const arr = (settings.vsrgLaneColors || []).slice();
            arr[i] = inp.value;
            settings.vsrgLaneColors = arr;
            if (deps.saveSettings) deps.saveSettings();
          });
          laneColorsEl.appendChild(inp);
        }
      }
      renderKeybinds();
    }
    // Lane-key rebinding: a row of key slots per key count (4–7K). Click a slot,
    // then press the key you want bound to that lane.
    let rebindTarget = null;   // { keyCount, lane, btn } while capturing
    function renderKeybinds() {
      if (!keybindsEl) return;
      keybindsEl.innerHTML = '';
      [4, 5, 6, 7].forEach((kc) => {
        const row = document.createElement('div'); row.className = 'vsrg-kb-row';
        const lbl = document.createElement('b'); lbl.textContent = kc + 'K'; row.appendChild(lbl);
        const keys = laneKeyMap(kc);
        for (let lane = 0; lane < kc; lane++) {
          const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'vsrg-key';
          btn.textContent = keys[lane] === ' ' ? '␣' : keys[lane];
          btn.addEventListener('click', () => startRebind(kc, lane, btn));
          row.appendChild(btn);
        }
        keybindsEl.appendChild(row);
      });
    }
    function startRebind(keyCount, lane, btn) {
      if (rebindTarget) rebindTarget.btn.classList.remove('binding');
      rebindTarget = { keyCount: keyCount, lane: lane, btn: btn };
      btn.classList.add('binding'); btn.textContent = '…';
    }
    function applyRebind(key) {
      const t = rebindTarget; rebindTarget = null;
      const binds = Object.assign({}, settings.vsrgKeybinds || {});
      const cur = (binds[t.keyCount] && binds[t.keyCount].length === t.keyCount)
        ? binds[t.keyCount].slice() : laneKeyMap(t.keyCount).slice();
      cur[t.lane] = key;
      binds[t.keyCount] = cur;
      settings.vsrgKeybinds = binds;
      if (deps.saveSettings) deps.saveSettings();
      renderKeybinds();
    }
    function startAppearancePreview() {
      if (!appearPreview || appearRaf) return;
      const g = appearPreview.getContext('2d');
      const W = appearPreview.width, H = appearPreview.height, lanes = 4;
      const laneW = W / lanes, hitY = H - 40, spacing = 360, appr = 1500;
      function frame(ts) {
        const style = noteStyle(), scale = noteScale();
        g.clearRect(0, 0, W, H); g.fillStyle = '#0e0f13'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#4a5060'; g.fillRect(0, hitY, W, 2);
        for (let lane = 0; lane < lanes; lane++)
          drawReceptor(g, style, laneColor(lane), lane * laneW, laneW, hitY - 10, 20, 1, arrowDir(lane), false);
        for (let lane = 0; lane < lanes; lane++) {
          const phase = (ts + lane * 137) % appr;
          for (let k = 0; k <= Math.ceil(appr / spacing); k++) {
            const age = phase - k * spacing;
            if (age < 0 || age > appr) continue;
            drawTap(g, style, laneColor(lane), lane * laneW, laneW, (age / appr) * hitY, scale, 1, arrowDir(lane));
          }
        }
        appearRaf = requestAnimationFrame(frame);
      }
      appearRaf = requestAnimationFrame(frame);
    }

    // ---- Public open/close (called by app.js applyMode) -------------------
    function open() {
      panel.classList.add('open');
      panelOpen = true;
      if (deps.captureKeyboard) deps.captureKeyboard(true);   // panel owns the keyboard
      if (speedValEl) speedValEl.value = String(scrollSpeed());
      show('select');
      refreshLibrary();
      startSpeedPreview();
    }
    function close() {
      loadGen++;                 // cancel any load still in flight
      if (run && !run.finished) quitToSelect();
      if (calibLoop) closeCalibration();
      if (appearRaf) { cancelAnimationFrame(appearRaf); appearRaf = 0; }
      stopSpeedPreview();
      panel.classList.remove('open'); window.UIMotion?.clear(panel);
      panelOpen = false;
      selector?.close();
      if (deps.captureKeyboard) deps.captureKeyboard(false);  // release the keyboard
      if (deps.resumeBgm) deps.resumeBgm();
      if (settings.gameMode === 'vsrg') {
        settings.gameMode = 'clicker';
        if (deps.saveSettings) deps.saveSettings();
        window.dispatchEvent(new CustomEvent('gamemodechange'));
      }
    }

    // ---- Wire UI events ----------------------------------------------------
    if (songlistEl && !selector) songlistEl.addEventListener('click', (e) => {
      const b = e.target.closest('.vsrg-song');
      if (!b) return;
      const idx = Number(b.getAttribute('data-i'));
      const entry = library[idx];
      if (entry) loadAndPlay(entry).catch((err) => setImportStatus('Load failed: ' + err.message));
    });
    if (importBtn) importBtn.addEventListener('click', () => importFolder());
    if (importInput) importInput.addEventListener('change', () => handleImportFiles(importInput.files));
    if (keyFilterEl) keyFilterEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-keys]');
      if (!b) return;
      keyFilter = b.getAttribute('data-keys');
      keyFilterEl.querySelectorAll('button').forEach((x) =>
        x.classList.toggle('sel', x.getAttribute('data-keys') === keyFilter));
      renderSongList();
    });
    if (hitsoundBtn) hitsoundBtn.addEventListener('click', () => { show('hitsound'); if (window.Hitsound) window.Hitsound.renderControls(hsControlsEl); });
    if (hitsoundDoneBtn) hitsoundDoneBtn.addEventListener('click', () => show('select'));
    if (calibrateBtn) calibrateBtn.addEventListener('click', openCalibration);
    if (skipBtn) skipBtn.addEventListener('click', doSkip);
    if (autoBtn) autoBtn.addEventListener('click', () => { autoplay = !autoplay; autoBtn.classList.toggle('on', autoplay); autoBtn.dataset.i18n = autoplay ? 'rhythm.auto_on' : 'rhythm.auto_off'; autoBtn.textContent = window.I18N.t(autoBtn.dataset.i18n); });
    const exitBtn = document.getElementById('vsrg-exit');
    if (exitBtn) exitBtn.addEventListener('click', function () { close(); });
    // Panel-level Escape: back out of a sub-screen, or exit the mode entirely.
    // During an active run, onKeyDown (bound only then) owns Escape as quit-to-select,
    // so this defers in that case to avoid double-handling.
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !panelOpen) return;
      if (run && !run.finished) return;
      if (screens.calib && !screens.calib.hidden) { closeCalibration(); return; }
      if (screens.appearance && !screens.appearance.hidden) { closeAppearance(); return; }
      if (screens.hitsound && !screens.hitsound.hidden) { show('select'); return; }
      if (screens.results && !screens.results.hidden) { quitToSelect(); return; }
      close();
    });
    if (calibDoneBtn) calibDoneBtn.addEventListener('click', closeCalibration);
    if (calibSlider) calibSlider.addEventListener('input', (e) => {
      settings.vsrgCalibrationOffset = Number(e.target.value);
      if (calibValEl) calibValEl.textContent = settings.vsrgCalibrationOffset + ' ms';
      if (deps.saveSettings) deps.saveSettings();
    });
    if (retryBtn) retryBtn.addEventListener('click', () => {
      if (lastSong) loadAndPlay(lastSong);
    });
    if (backBtn) backBtn.addEventListener('click', quitToSelect);
    // .osz import
    if (oszBtn) oszBtn.addEventListener('click', () => { if (oszInput) { oszInput.value = ''; oszInput.click(); } });
    if (oszInput) oszInput.addEventListener('change', () => handleOszFiles(oszInput.files));
    // Skin (.osk): skins are an osu!standard feature, so hand the file to that mode.
    if (skinBtn) skinBtn.addEventListener('click', () => { if (skinOskInput) { skinOskInput.value = ''; skinOskInput.click(); } });
    if (skinOskInput) skinOskInput.addEventListener('change', async () => {
      const file = skinOskInput.files[0]; if (!file) return;
      if (window.OsuStdGame && window.OsuStdGame.importSkinFile) {
        try { await window.OsuStdGame.importSkinFile(file); setImportStatus('Skin “' + file.name.replace(/\.(osk|zip)$/i, '') + '” loaded — it applies in Standard mode.'); }
        catch (e) { setImportStatus('Skin load failed: ' + ((e && e.message) || e)); }
      } else { setImportStatus('Skin loading needs Standard mode (unavailable).'); }
    });
    // Scroll-speed stepper (uncapped). The previews read scrollSpeed() live.
    if (speedDownBtn) speedDownBtn.addEventListener('click', () => setScrollSpeed(scrollSpeed() - 0.5));
    if (speedUpBtn) speedUpBtn.addEventListener('click', () => setScrollSpeed(scrollSpeed() + 0.5));
    // Type an exact speed (e.g. 3.2, 5.55); Enter/blur applies, invalid reverts.
    if (speedValEl) {
      const applyTyped = () => {
        const v = parseFloat(speedValEl.value);
        if (isFinite(v)) setScrollSpeed(v); else speedValEl.value = String(scrollSpeed());
      };
      speedValEl.addEventListener('change', applyTyped);
      speedValEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); speedValEl.blur(); } });
    }
    // Appearance sub-screen
    if (appearanceBtn) appearanceBtn.addEventListener('click', openAppearance);
    if (appearDoneBtn) appearDoneBtn.addEventListener('click', closeAppearance);
    if (stylePickEl) stylePickEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-style]'); if (!b) return;
      settings.vsrgNoteStyle = b.getAttribute('data-style');
      if (deps.saveSettings) deps.saveSettings(); renderAppearanceControls();
    });
    if (presetPickEl) presetPickEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-preset]'); if (!b) return;
      settings.vsrgColorPreset = b.getAttribute('data-preset');
      settings.vsrgLaneColors = [];               // a preset clears per-lane overrides
      if (deps.saveSettings) deps.saveSettings(); renderAppearanceControls();
    });
    if (sizeSlider) sizeSlider.addEventListener('input', (e) => {
      settings.vsrgNoteScale = Math.max(0.6, Math.min(1.8, Number(e.target.value) || 1));
      if (sizeValEl) sizeValEl.textContent = settings.vsrgNoteScale.toFixed(1) + '×';
      if (deps.saveSettings) deps.saveSettings();
    });
    if (appearResetBtn) appearResetBtn.addEventListener('click', () => {
      settings.vsrgNoteStyle = 'bar'; settings.vsrgNoteScale = 1.0;
      settings.vsrgLaneWidth=72; settings.vsrgReceptorPosition=0.85; settings.vsrgUpscroll=false; settings.vsrgConstantScroll=false; settings.vsrgVisualOffset=0;
      panel.querySelectorAll('[data-rhythm-setting]').forEach(el => el.rhythmRefresh());
      settings.vsrgColorPreset = 'default'; settings.vsrgLaneColors = []; settings.vsrgKeybinds = {};
      if (deps.saveSettings) deps.saveSettings(); renderAppearanceControls();
    });
    // Capture the next key while a lane-key slot is being rebound (capture phase,
    // so it pre-empts the panel's Escape/Space handlers). Escape cancels.
    window.addEventListener('keydown', (e) => {
      if (!rebindTarget) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape') { rebindTarget.btn.classList.remove('binding'); rebindTarget = null; renderKeybinds(); return; }
      if (e.key.length === 1 || e.key === ' ') applyRebind(e.key.toLowerCase());
    }, true);
    // Tap calibration: the button or Space (while the calib screen is open) registers a tap.
    if (tapBtn) tapBtn.addEventListener('click', (e) => onTapButton(e.timeStamp));
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ' && panelOpen && screens.calib && !screens.calib.hidden) {
        e.preventDefault();
        onTapButton(e.timeStamp);
      }
    });
    window.addEventListener('resize', () => { if (run && !run.finished) sizeCanvas(); });
    // Keep keyboard focus inside the iframe: make the canvas focusable and
    // re-grab focus whenever the user clicks anywhere in the panel (Discord
    // steals focus when its chat box is clicked).
    if (canvas) { canvas.setAttribute('tabindex', '0'); canvas.style.outline = 'none'; }
    if (panel) panel.addEventListener('pointerdown', () => { if (run && !run.finished && !run.paused) grabFocus(); });

    api.open = open;
    api.close = close;
    api.importFolder = importFolder;
    api.setKeyFilter = function (k) { keyFilter = k; renderSongList(); };
    // Cross-mode hook (called by osustd.js when a standard-side import finds mania
    // charts): store the playable Mode-3 ones here so they land in the Mania library.
    api.importForeignCharts = async function (records) {
      if (!records || !records.length) return 0;
      let n = 0;
      for (const r of records) {
        let chart; try { chart = parseOsu(r.osuText); } catch (e) { continue; }   // accept osu!mania only
        if (!KEY_MAPS[chart.keyCount]) continue;
        const hash = await sha256(r.osuText);
        await idbPut('osz', hash, {
          title: chart.title, artist: chart.artist, diffName: chart.diffName,
          keyCount: chart.keyCount, od: chart.overallDifficulty, hash: hash,
          stars: difficultyStars(chart), osuText: r.osuText, audio: r.audio, art: r.art || null, samples: r.samples || [],
        });
        n++;
      }
      if (n && panelOpen) await refreshLibrary();
      return n;
    };
  }

  // ---- SHA-256 chart identity (WebCrypto; replaces osu's MD5 for local use) -
  // Any stable hash works for local PB keying + future friend matching, as long
  // as everyone uses the same algorithm. WebCrypto has no MD5, so we use SHA-256.
  async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---- Minimal IndexedDB wrapper ----------------------------------------
  let _dbPromise = null;
  function idb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('aobing-vsrg', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        // 'pb'  = personal bests, keyed by chart hash.
        // 'osz' = imported .osz maps (osuText + audio + art bytes), keyed by hash;
        //         these persist across reloads (unlike folder imports).
        if (!db.objectStoreNames.contains('pb')) db.createObjectStore('pb');
        if (!db.objectStoreNames.contains('osz')) db.createObjectStore('osz');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }
  function idbPut(store, key, val) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }
  function idbGet(store, key) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const r = tx.objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  function idbGetAll(store) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const r = tx.objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    }));
  }

  window.VsrgGame = api;
  if (window.__vsrgDeps) initBrowser(window.__vsrgDeps);
}

})();
