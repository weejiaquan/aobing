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
    overallDifficulty: parseFloat(diff.OverallDifficulty),
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
    const lane = Math.floor((x * keyCount) / 512);
    let endTime = null;
    if (type & 128) {
      // Hold: extra params live in p[5] as "endTime:hitSample..."
      endTime = parseInt(String(p[5] || '').split(':')[0], 10);
      if (!Number.isFinite(endTime)) endTime = null;
    }
    if (!Number.isFinite(time) || !Number.isFinite(lane)) continue;
    notes.push({ time: time, lane: lane, endTime: endTime });
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
    title: meta.title,
    artist: meta.artist,
    diffName: meta.diffName,
    keyCount: meta.keyCount,
    overallDifficulty: meta.overallDifficulty,
    bpm: timing.bpm,
    offset: timing.offset,
    notes: notes,
  };
}

// =========================================================================
// Judgement & scoring
// =========================================================================

// osu!mania timing windows (half-windows, ms) for a given OverallDifficulty.
// A hit within ±window[tier] of the note time earns that tier. Beyond `bad`
// it is a MISS. MARVELOUS is fixed; the rest tighten by 3ms per OD point.
function windowsForOD(od) {
  return {
    marvelous: 16.5,
    perfect: 64 - 3 * od,
    great: 97 - 3 * od,
    good: 127 - 3 * od,
    bad: 151 - 3 * od,
  };
}

// Judge a hit against a note time. Returns { tier, errorMs } where errorMs is
// signed (hit - note): negative = early, positive = late. `tier` is one of
// marvelous|perfect|great|good|bad|miss.
function judge(noteTimeMs, hitTimeMs, windows) {
  const errorMs = hitTimeMs - noteTimeMs;
  const abs = Math.abs(errorMs);
  let tier = 'miss';
  if (abs <= windows.marvelous) tier = 'marvelous';
  else if (abs <= windows.perfect) tier = 'perfect';
  else if (abs <= windows.great) tier = 'great';
  else if (abs <= windows.good) tier = 'good';
  else if (abs <= windows.bad) tier = 'bad';
  return { tier: tier, errorMs: errorMs };
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

// Tiers that keep a combo going. Per the project's chosen rule, `bad` (50)
// breaks combo (only marvelous/perfect/great/good continue it).
const COMBO_TIERS = { marvelous: true, perfect: true, great: true, good: true };

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
  splitSections: splitSections,
  parseMeta: parseMeta,
  parseHitObjects: parseHitObjects,
  parseTiming: parseTiming,
  parseOsu: parseOsu,
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
  const TIER_COLORS = { marvelous: '#9be7ff', perfect: '#39d98a', great: '#ffd166', good: '#f59e0b', bad: '#ff8c5a', miss: '#ff5470' };
  const APPROACH_MS = 1600;   // time a note is visible before the judgement line
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
    };
    const songlistEl = document.getElementById('vsrg-songlist');
    const importBtn = document.getElementById('vsrg-import');
    const importStatusEl = document.getElementById('vsrg-import-status');
    const keyFilterEl = document.getElementById('vsrg-keyfilter');
    const calibrateBtn = document.getElementById('vsrg-calibrate');
    const canvas = document.getElementById('vsrg-canvas');
    const ctx2d = canvas.getContext('2d');
    const comboEl = document.getElementById('vsrg-combo');
    const accEl = document.getElementById('vsrg-acc');
    const judgeEl = document.getElementById('vsrg-judge');
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
    let library = [];          // [{ id, source, title, artist, diffName, keyCount, od, hash, getOsuText, getAudio }]
    let keyFilter = 'all';
    let lastSong = null;       // remember for Retry
    let loading = false;       // guards against re-entrant loadAndPlay
    let loadGen = 0;           // bumped to cancel an in-flight async load

    // Active run (null when not playing)
    let run = null;

    function calOffset() { return Number(settings.vsrgCalibrationOffset) || 0; }

    // ---- Screen management -------------------------------------------------
    function show(name) {
      for (const k in screens) if (screens[k]) screens[k].hidden = (k !== name);
    }

    // ---- Audio -------------------------------------------------------------
    function ensureCtx() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state !== 'running') return audioCtx.resume().then(() => audioCtx);
      return Promise.resolve(audioCtx);
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
            getOsuText: () => Promise.resolve(osuText),
            getAudio: () => fetch(base + '/' + m.audio).then((r) => r.arrayBuffer()),
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
      if (!songlistEl) return;
      const items = library.filter(passesFilter);
      if (items.length === 0) {
        songlistEl.innerHTML = '<div class="vsrg-empty">' +
          escapeH(t('vsrg.noSongs') || 'No songs. Import your osu! Songs folder to add maps.') + '</div>';
        return;
      }
      songlistEl.innerHTML = items.map((e, i) =>
        '<button class="vsrg-song" data-i="' + library.indexOf(e) + '">' +
          '<span class="vsrg-song-title">' + escapeH(e.title || '(untitled)') + '</span>' +
          '<span class="vsrg-song-meta">' + escapeH(e.artist || '') +
            ' · ' + escapeH(e.diffName || '') + ' · ' + e.keyCount + 'K</span>' +
        '</button>'
      ).join('');
    }

    function escapeH(s) { return deps.escapeHtml ? deps.escapeHtml(String(s)) : String(s); }

    async function refreshLibrary() {
      const bundled = await loadBundled();
      let local = [];
      try { local = await restoreLocalLibrary(); } catch (e) { /* none */ }
      library = bundled.concat(local);
      renderSongList();
    }

    // ---- Folder import (File System Access API; desktop Chromium only) ------
    async function importFolder() {
      if (!window.showDirectoryPicker) {
        setImportStatus(t('vsrg.noFsApi') ||
          'Folder import needs Chrome or Edge on desktop. Bundled songs still work.');
        return;
      }
      let dir;
      try { dir = await window.showDirectoryPicker({ id: 'osu-songs', mode: 'read' }); }
      catch (e) { return; }                   // user cancelled
      setImportStatus(t('vsrg.scanning') || 'Scanning…');
      await idbPut('handles', 'songsDir', dir);
      const found = await scanDirectory(dir);
      await idbPut('library', 'local', serializeLocal(found));
      library = (await loadBundled()).concat(found);
      renderSongList();
      setImportStatus((t('vsrg.imported') || 'Imported {n} charts.').replace('{n}', found.length));
    }

    function setImportStatus(msg) { if (importStatusEl) importStatusEl.textContent = msg; }

    // Recursively walk a directory handle, parsing every mania .osu it finds.
    async function scanDirectory(dir) {
      const out = [];
      async function walk(handle) {
        // collect files at this level first so .osu can resolve its audio sibling.
        // Keys are lower-cased: osu charts reference audio with arbitrary case but
        // the real file may differ (esp. on Windows), so match case-insensitively.
        const files = new Map();
        const subdirs = [];
        for await (const [name, h] of handle.entries()) {
          if (h.kind === 'file') files.set(name.toLowerCase(), h);
          else subdirs.push(h);
        }
        for (const [name, h] of files) {
          if (!name.endsWith('.osu')) continue;
          let osuText;
          try { osuText = await (await h.getFile()).text(); } catch (e) { continue; }
          let chart;
          try { chart = parseOsu(osuText); } catch (e) { continue; }  // skip non-mania/empty
          if (!KEY_MAPS[chart.keyCount]) continue;     // no keymap for this key count
          const audioHandle = files.get(String(chart.audioFile).toLowerCase()) || null;
          if (!audioHandle) continue;          // can't play without its audio
          const hash = await sha256(osuText);
          out.push({
            id: 'local:' + hash,
            source: 'local',
            title: chart.title, artist: chart.artist, diffName: chart.diffName,
            keyCount: chart.keyCount, od: chart.overallDifficulty, hash: hash,
            _osuHandle: h, _audioHandle: audioHandle,
            getOsuText: () => h.getFile().then((f) => f.text()),
            getAudio: () => audioHandle.getFile().then((f) => f.arrayBuffer()),
          });
        }
        for (const sd of subdirs) await walk(sd);
      }
      await walk(dir);
      return out;
    }

    // Persist only the serialisable parts (handles ARE structured-cloneable).
    function serializeLocal(entries) {
      return entries.map((e) => ({
        id: e.id, title: e.title, artist: e.artist, diffName: e.diffName,
        keyCount: e.keyCount, od: e.od, hash: e.hash,
        osuHandle: e._osuHandle, audioHandle: e._audioHandle,
      }));
    }

    async function restoreLocalLibrary() {
      const saved = await idbGet('library', 'local');
      if (!saved || !saved.length) return [];
      // Verify we still have read permission on the stored directory handle.
      const dir = await idbGet('handles', 'songsDir');
      if (dir && dir.queryPermission) {
        const perm = await dir.queryPermission({ mode: 'read' });
        if (perm !== 'granted') return [];     // needs a fresh user gesture to re-grant
      }
      return saved.filter((s) => KEY_MAPS[s.keyCount]).map((s) => ({
        id: s.id, source: 'local',
        title: s.title, artist: s.artist, diffName: s.diffName,
        keyCount: s.keyCount, od: s.od, hash: s.hash,
        getOsuText: () => s.osuHandle.getFile().then((f) => f.text()),
        getAudio: () => s.audioHandle.getFile().then((f) => f.arrayBuffer()),
      }));
    }

    // ---- Loading a chart for play -----------------------------------------
    // Fully stop and discard the current run (audio, RAF loop, input binding).
    function teardownRun() {
      if (!run) return;
      run.finished = true;
      cancelAnimationFrame(run.rafId);
      bindInput(false);
      try { run.src.stop(); } catch (e) {}
      run = null;
    }

    async function loadAndPlay(entry) {
      if (loading) return;        // ignore double-clicks / overlapping loads
      loading = true;
      const gen = ++loadGen;      // cancels if close()/quit bumps loadGen mid-load
      teardownRun();              // never leave a previous run/audio running
      lastSong = entry;
      setImportStatus('');
      try {
        const osuText = await entry.getOsuText();
        const chart = parseOsu(osuText);
        const ac = await ensureCtx();
        const audioBuf = await ac.decodeAudioData(await entry.getAudio());
        if (gen !== loadGen || !panelOpen) return;   // user left during the load
        startRun(entry, chart, audioBuf);
      } finally {
        loading = false;
      }
    }

    // ---- Gameplay ----------------------------------------------------------
    function laneKeyMap(keyCount) { return KEY_MAPS[keyCount] || KEY_MAPS[4]; }

    function startRun(entry, chart, audioBuf) {
      teardownRun();                 // defensive: never overlap with a prior run
      if (deps.pauseBgm) deps.pauseBgm();
      show('game');
      sizeCanvas();
      const ac = audioCtx;
      const windows = windowsForOD(chart.overallDifficulty);
      const keyCount = chart.keyCount;
      const keys = laneKeyMap(keyCount);

      // Build per-note play state. Holds carry a tail.
      const notes = chart.notes.map((n) => ({
        time: n.time, lane: n.lane, endTime: n.endTime,
        headJudged: false, tailJudged: false, holding: false, headTier: null,
      }));
      const holdCount = notes.filter((n) => n.endTime != null).length;
      const totalJudgements = notes.length + holdCount;   // head + tail for holds

      // Schedule audio: source starts LEAD_IN after now.
      const startCtx = ac.currentTime + LEAD_IN_MS / 1000;
      const src = ac.createBufferSource();
      const gain = ac.createGain();
      gain.gain.value = Math.max(0, Math.min(1, (Number(settings.musicVol) || 0) / 100)) || 0.6;
      src.buffer = audioBuf;
      src.connect(gain).connect(ac.destination);
      src.start(startCtx);

      // Capture perf<->ctx mapping for input timestamp conversion.
      const t0perf = performance.now();
      const t0ctx = ac.currentTime;

      run = {
        entry, chart, notes, keys, keyCount, windows, src, gain,
        startCtx, t0perf, t0ctx, totalJudgements,
        state: createRunState({ notes: notes }),
        lastNoteTime: notes.reduce((m, n) => Math.max(m, n.endTime || n.time), 0),
        finished: false, rafId: 0, pressed: {},
      };
      run.state.totalNotes = totalJudgements;

      src.onended = () => {};   // end is driven by song-time, not this event
      bindInput(true);
      run.rafId = requestAnimationFrame(loop);
      updateHud();
    }

    // Current song time in ms from live audio clock.
    function songTimeNow() {
      return (audioCtx.currentTime - run.startCtx) * 1000;
    }
    // Map an input performance.now() timestamp to song time (with calibration).
    function inputSongTime(perfTs) {
      const ctxAtInput = run.t0ctx + (perfTs - run.t0perf) / 1000;
      return (ctxAtInput - run.startCtx) * 1000 - calOffset();
    }

    function loop() {
      if (!run || run.finished) return;
      const st = songTimeNow();
      sweepMisses(st);
      render(st);
      if (st > run.lastNoteTime + END_PAD_MS) { finishRun(); return; }
      run.rafId = requestAnimationFrame(loop);
    }

    // Mark notes whose hit window has fully passed as misses.
    function sweepMisses(st) {
      const badMs = run.windows.bad;
      for (const n of run.notes) {
        if (!n.headJudged && st > n.time + badMs) {
          n.headJudged = true;
          if (n.endTime != null) n.holding = false;
          applyTier('miss', n.lane, true);
        }
        // Tail: if head was hit but never released and the tail window passed.
        if (n.endTime != null && n.headJudged && !n.tailJudged && st > n.endTime + badMs) {
          n.tailJudged = true; n.holding = false;
          applyTier('miss', n.lane, true);
        }
      }
    }

    function applyTier(tier, lane, isMiss) {
      run.state = applyJudgement(run.state, tier);
      flashJudge(tier);
      pushFx(lane, isMiss ? 'miss' : 'hit', TIER_COLORS[tier] || '#fff');
      updateHud();
    }

    // ---- Input -------------------------------------------------------------
    function onHit(lane, perfTs) {
      if (!run || run.finished) return;
      const st = inputSongTime(perfTs);
      // nearest unhit head in this lane within the bad window
      let best = null, bestErr = Infinity;
      for (const n of run.notes) {
        if (n.lane !== lane || n.headJudged) continue;
        const err = Math.abs(st - n.time);
        if (err < bestErr) { bestErr = err; best = n; }
      }
      if (!best || bestErr > run.windows.bad) return;  // nothing to hit
      const res = judge(best.time, st, run.windows);
      best.headJudged = true; best.headTier = res.tier;
      if (best.endTime != null && res.tier !== 'miss') best.holding = true;
      applyTier(res.tier, lane, res.tier === 'miss');
    }

    function onRelease(lane, perfTs) {
      if (!run || run.finished) return;
      const st = inputSongTime(perfTs);
      // find a hold currently being held in this lane
      const n = run.notes.find((x) => x.lane === lane && x.holding && !x.tailJudged);
      if (!n) return;
      n.holding = false;
      const err = Math.abs(st - n.endTime);
      if (err <= run.windows.bad) {
        const res = judge(n.endTime, st, run.windows);
        n.tailJudged = true;
        applyTier(res.tier, lane, res.tier === 'miss');
      } else if (st < n.endTime - run.windows.bad) {
        // released far too early — tail miss
        n.tailJudged = true;
        applyTier('miss', lane, true);
      }
    }

    // Input timestamps use e.timeStamp (when the event actually occurred, same
    // epoch as performance.now()) rather than sampling inside the handler, so a
    // main-thread stall can't turn into bogus hit error.
    function onKeyDown(e) {
      if (!run || run.finished) return;
      if (e.key === 'Escape') { quitToSelect(); return; }
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
      if (!run || run.finished) return;
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
      const w = Math.min(560, r.width);
      canvas.width = w * (window.devicePixelRatio || 1);
      canvas.height = (r.height - 0) * (window.devicePixelRatio || 1);
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

    function render(st) {
      const W = canvas.width, H = canvas.height;
      const dpr = window.devicePixelRatio || 1;
      const keyCount = run.keyCount;
      const laneW = W / keyCount;
      const hitY = H - 90 * dpr;
      const noteH = 18 * dpr;
      const recH = 22 * dpr;
      const held = heldLanes();
      const nowP = performance.now();

      ctx2d.clearRect(0, 0, W, H);
      ctx2d.fillStyle = '#0e0f13'; ctx2d.fillRect(0, 0, W, H);
      for (let i = 0; i < keyCount; i++) {
        ctx2d.fillStyle = held[i] ? 'rgba(255,255,255,0.09)' : ((i % 2) ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)');
        ctx2d.fillRect(i * laneW, 0, laneW, H);
      }
      // judgement line
      ctx2d.fillStyle = '#4a5060'; ctx2d.fillRect(0, hitY - 2 * dpr, W, 4 * dpr);

      // receptors (filled + glowing while the lane key is held)
      for (let i = 0; i < keyCount; i++) {
        const color = LANE_COLORS[i % LANE_COLORS.length];
        const x = i * laneW + 4 * dpr, w = laneW - 8 * dpr;
        if (held[i]) {
          ctx2d.save();
          ctx2d.shadowColor = color; ctx2d.shadowBlur = 22 * dpr;
          ctx2d.fillStyle = color; ctx2d.globalAlpha = 0.85;
          ctx2d.fillRect(x, hitY, w, recH);
          ctx2d.restore();
        }
        ctx2d.strokeStyle = color; ctx2d.lineWidth = 2 * dpr;
        ctx2d.strokeRect(x, hitY, w, recH);
      }

      // notes (holds first so taps/caps draw on top)
      for (const n of run.notes) {
        if (n.headJudged && (n.endTime == null || n.tailJudged)) continue;
        const color = LANE_COLORS[n.lane % LANE_COLORS.length];
        const x = n.lane * laneW + 5 * dpr;
        const w = laneW - 10 * dpr;
        const yHead = hitY - ((n.time - st) / APPROACH_MS) * hitY;

        if (n.endTime != null) {
          // --- Hold: bright bordered body with a gradient, caps, and a glow while held ---
          const yTail = hitY - ((n.endTime - st) / APPROACH_MS) * hitY;
          const top = Math.min(yHead, yTail);
          const bot = Math.max(yHead, yTail) + noteH;
          const bodyTop = n.holding ? Math.max(top, hitY) : top;   // consumed part stops at the line while held
          ctx2d.save();
          const grad = ctx2d.createLinearGradient(0, bodyTop, 0, bot);
          grad.addColorStop(0, color); grad.addColorStop(1, color + '55');
          ctx2d.fillStyle = grad;
          if (n.holding) { ctx2d.shadowColor = color; ctx2d.shadowBlur = 18 * dpr; }
          ctx2d.beginPath();
          ctx2d.roundRect(x, bodyTop, w, Math.max(noteH, bot - bodyTop), 6 * dpr);
          ctx2d.fill();
          ctx2d.lineWidth = 2.5 * dpr; ctx2d.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx2d.stroke();
          ctx2d.restore();
          // tail cap (so the end is unmistakable)
          ctx2d.fillStyle = '#fff';
          ctx2d.fillRect(x, yTail, w, 4 * dpr);
        }

        if (!n.headJudged && yHead > -noteH && yHead < H) {
          // tap / hold-head: solid bar with a white top edge for a chunky look
          ctx2d.fillStyle = color;
          ctx2d.beginPath();
          ctx2d.roundRect(x, yHead, w, noteH, 5 * dpr);
          ctx2d.fill();
          ctx2d.fillStyle = 'rgba(255,255,255,0.9)';
          ctx2d.fillRect(x, yHead, w, 3 * dpr);
        }
      }

      // --- hit/press effects at the line ---
      for (let i = hitFx.length - 1; i >= 0; i--) {
        const f = hitFx[i];
        const dur = f.kind === 'press' ? 130 : 280;
        const age = nowP - f.t;
        if (age > dur) { hitFx.splice(i, 1); continue; }
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
    }

    const JUDGE_LABELS = { marvelous: 'MARVELOUS', perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', bad: 'BAD', miss: 'MISS' };
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
    function updateHud() {
      if (comboEl) {
        comboEl.textContent = run.state.combo > 1 ? run.state.combo + 'x' : '';
        if (run.state.combo > 1) {                 // bump the combo on each gain
          comboEl.classList.remove('pop'); void comboEl.offsetWidth; comboEl.classList.add('pop');
        }
      }
      if (accEl) accEl.textContent = accuracy(run.state.counts).toFixed(2) + '%';
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
      run.finished = true;
      cancelAnimationFrame(run.rafId);
      bindInput(false);
      try { run.src.stop(); } catch (e) {}
      const acc = accuracy(run.state.counts);
      const pb = await savePersonalBest(run.entry.hash, {
        accuracy: acc, maxCombo: run.state.maxCombo,
        counts: run.state.counts, title: run.entry.title, diffName: run.entry.diffName,
      });
      renderResults(run, acc, pb);
      show('results');
    }

    function renderResults(r, acc, pb) {
      const c = r.state.counts;
      resultsBody.innerHTML =
        '<div class="vsrg-res-title">' + escapeH(r.entry.title) + ' · ' + escapeH(r.entry.diffName) + '</div>' +
        '<div class="vsrg-res-acc">' + acc.toFixed(2) + '%</div>' +
        '<div class="vsrg-res-combo">' + r.state.maxCombo + 'x max combo</div>' +
        '<div class="vsrg-res-breakdown">' +
          'Marv ' + c.marvelous + ' · Perf ' + c.perfect + ' · Great ' + c.great +
          ' · Good ' + c.good + ' · Bad ' + c.bad + ' · Miss ' + c.miss +
        '</div>' +
        (pb && pb.prev ? '<div class="vsrg-res-pb">Previous best: ' + pb.prev.accuracy.toFixed(2) + '%' +
          (pb.improved ? ' — new best!' : '') + '</div>'
          : '<div class="vsrg-res-pb">First clear — saved as your best.</div>');
    }

    function quitToSelect() {
      loadGen++;                 // cancel any load still in flight
      teardownRun();
      if (deps.resumeBgm) deps.resumeBgm();
      show('select');
      renderSongList();
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
    function openCalibration() {
      show('calib');
      if (calibSlider) {
        calibSlider.value = calOffset();
        if (calibValEl) calibValEl.textContent = calOffset() + ' ms';
      }
      ensureCtx().then((ac) => {
        const cctx = calibCanvas ? calibCanvas.getContext('2d') : null;
        const period = 0.6;                       // 100 BPM metronome
        const baseTick = ac.currentTime + 0.2;    // first beep; flash phase is anchored to this
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
            const rel = ac.currentTime - baseTick - calOffset() / 1000;
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
      show('select');
    }

    // ---- Public open/close (called by app.js applyMode) -------------------
    function open() {
      panel.classList.add('open');
      panelOpen = true;
      if (deps.captureKeyboard) deps.captureKeyboard(true);   // panel owns the keyboard
      show('select');
      refreshLibrary();
    }
    function close() {
      loadGen++;                 // cancel any load still in flight
      if (run && !run.finished) quitToSelect();
      if (calibLoop) closeCalibration();
      panel.classList.remove('open');
      panelOpen = false;
      if (deps.captureKeyboard) deps.captureKeyboard(false);  // release the keyboard
      if (deps.resumeBgm) deps.resumeBgm();
      if (settings.gameMode === 'vsrg') {
        settings.gameMode = 'clicker';
        if (deps.saveSettings) deps.saveSettings();
        window.dispatchEvent(new CustomEvent('gamemodechange'));
      }
    }

    // ---- Wire UI events ----------------------------------------------------
    if (songlistEl) songlistEl.addEventListener('click', (e) => {
      const b = e.target.closest('.vsrg-song');
      if (!b) return;
      const idx = Number(b.getAttribute('data-i'));
      const entry = library[idx];
      if (entry) loadAndPlay(entry).catch((err) => setImportStatus('Load failed: ' + err.message));
    });
    if (importBtn) importBtn.addEventListener('click', () => importFolder());
    if (keyFilterEl) keyFilterEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-keys]');
      if (!b) return;
      keyFilter = b.getAttribute('data-keys');
      keyFilterEl.querySelectorAll('button').forEach((x) =>
        x.classList.toggle('sel', x.getAttribute('data-keys') === keyFilter));
      renderSongList();
    });
    if (calibrateBtn) calibrateBtn.addEventListener('click', openCalibration);
    const exitBtn = document.getElementById('vsrg-exit');
    if (exitBtn) exitBtn.addEventListener('click', function () { close(); });
    // Panel-level Escape: back out of a sub-screen, or exit the mode entirely.
    // During an active run, onKeyDown (bound only then) owns Escape as quit-to-select,
    // so this defers in that case to avoid double-handling.
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !panelOpen) return;
      if (run && !run.finished) return;
      if (screens.calib && !screens.calib.hidden) { closeCalibration(); return; }
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
    window.addEventListener('resize', () => { if (run && !run.finished) sizeCanvas(); });

    api.open = open;
    api.close = close;
    api.importFolder = importFolder;
    api.setKeyFilter = function (k) { keyFilter = k; renderSongList(); };
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
      const req = indexedDB.open('aobing-vsrg', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ['handles', 'library', 'pb']) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        }
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

  window.VsrgGame = api;
  if (window.__vsrgDeps) initBrowser(window.__vsrgDeps);
}

})();
