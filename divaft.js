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

  // Timing windows (± ms) and note weights — matched to Project Heartbeat's Future Tone
  // judge (HBJudge.RATING_WINDOWS) and scoring (HBBaseNote.NOTE_SCORES, which are
  // COOL 1000 / FINE 800 / SAFE 500 / SAD 100 / WORST 0 → /10 for a 0–100 % attainment).
  const WINDOWS = { cool: 32, fine: 64, safe: 96, sad: 128 };
  const WEIGHTS = { cool: 100, fine: 80, safe: 50, sad: 10, worst: 0 };
  const DOUBLE_WINDOW = 40;   // ms tolerance for "simultaneous" presses of a multi note

  // Map an absolute timing error (ms) to a judgement tier.
  function tierFor(absMs) {
    if (absMs <= WINDOWS.cool) return 'cool';
    if (absMs <= WINDOWS.fine) return 'fine';
    if (absMs <= WINDOWS.safe) return 'safe';
    if (absMs <= WINDOWS.sad) return 'sad';
    return 'worst';
  }

  // Attainment % over a tier-count object — PH's percentage = note-score-sum / max_score
  // (each note's max is COOL). Equivalent to the weighted average of NOTE_SCORES.
  function accuracy(c) {
    const total = c.cool + c.fine + c.safe + c.sad + c.worst;
    if (!total) return 100;
    return Math.round(((c.cool * WEIGHTS.cool + c.fine * WEIGHTS.fine + c.safe * WEIGHTS.safe + c.sad * WEIGHTS.sad) / total) * 100) / 100;
  }

  // Clear rank — PH's get_result_rating (no-fail): PERFECT when there are no SAFE/SAD/
  // WORST (only COOL/FINE), otherwise by attainment %: EXCELLENT ≥95, GREAT ≥90,
  // STANDARD ≥75, else CHEAP.
  function clearRank(acc, counts) {
    const failure = (counts.safe || 0) + (counts.sad || 0) + (counts.worst || 0);
    if (failure === 0) return 'PERFECT';
    if (acc >= 95) return 'EXCELLENT';
    if (acc >= 90) return 'GREAT';
    if (acc >= 75) return 'STANDARD';
    return 'CHEAP';
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
  // Browser wiring — window.DivaGame.init(deps). Panel + render + input + audio.
  // =========================================================================
  if (typeof document === 'undefined') return;

  const api = { init: initBrowser };
  const LEAD_IN_MS = 1500, END_PAD_MS = 2500;
  const PLAY_W = 1.0, PLAY_H = 1.0;   // normalized 16:9 field; aspect enforced in transform

  function initBrowser(deps) {
    const settings = deps.settings || {};
    const panel = document.getElementById('divaft-panel');
    if (!panel) return;
    const screens = {
      select:  document.getElementById('divaft-select'),
      game:    document.getElementById('divaft-game'),
      results: document.getElementById('divaft-results'),
      keys:    document.getElementById('divaft-keys'),
      calib:   document.getElementById('divaft-calib'),
      hitsound: document.getElementById('divaft-hitsound'),
    };
    const songlistEl = document.getElementById('divaft-songlist');
    const canvas = document.getElementById('divaft-canvas');
    const g = canvas.getContext('2d');
    const comboEl = document.getElementById('divaft-combo');
    const accEl = document.getElementById('divaft-acc');
    const judgeEl = document.getElementById('divaft-judge');
    const fpsEl = document.getElementById('divaft-fps');
    const keysOverlayEl = document.getElementById('divaft-keys-overlay');
    const skipBtn = document.getElementById('divaft-skip');
    const resultsBody = document.getElementById('divaft-results-body');
    const retryBtn = document.getElementById('divaft-retry');
    const backBtn = document.getElementById('divaft-back');
    const exitBtn = document.getElementById('divaft-exit');
    const autoBtn = document.getElementById('divaft-auto');
    const keysBtn = document.getElementById('divaft-keys-btn');
    const keysDoneBtn = document.getElementById('divaft-keys-done');
    const keybindsEl = document.getElementById('divaft-keybinds');
    const macrosEl = document.getElementById('divaft-macros');
    const hitsoundBtn = document.getElementById('divaft-hitsound-btn');
    const hitsoundDoneBtn = document.getElementById('divaft-hitsound-done');
    const hsControlsEl = document.getElementById('divaft-hs-controls');
    const calibrateBtn = document.getElementById('divaft-calibrate');
    const calibCanvas = document.getElementById('divaft-calib-canvas');
    const calibSlider = document.getElementById('divaft-calib-slider');
    const calibValEl = document.getElementById('divaft-calib-val');
    const calibDoneBtn = document.getElementById('divaft-calib-done');
    const tapBtn = document.getElementById('divaft-tap');
    const tapResultEl = document.getElementById('divaft-tap-result');

    let audioCtx = null, panelOpen = false, library = [], run = null, loading = false, loadGen = 0;
    let cpkLive = [];   // in-memory base-game CPK song entries (decrypt-on-demand, this session)
    let cpkImportGen = 0;   // guards against overlapping CPK imports racing on cpkLive
    let cpkSources = [];   // [{name, read, toc}] — all CPKs imported this session (main + region + dlc)
    let autoplay = false;
    let fpsFrames = 0, fpsLast = 0, fpsPrev = 0, fpsMaxDt = 0;

    function calOffset() { return Number(settings.divaCalibrationOffset) || 0; }
    function show(name) { for (const k in screens) if (screens[k]) screens[k].hidden = (k !== name); }
    function grabFocus() { try { window.focus(); } catch (e) {} try { canvas.focus({ preventScroll: true }); } catch (e) {} }
    function escapeH(s) { return deps.escapeHtml ? deps.escapeHtml(String(s)) : String(s); }

    function ensureCtx() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state !== 'running') return audioCtx.resume().then(() => audioCtx);
      return Promise.resolve(audioCtx);
    }
    function audioLatency() {
      if (!audioCtx) return 0;
      const l = (typeof audioCtx.outputLatency === 'number' && audioCtx.outputLatency) || audioCtx.baseLatency || 0;
      return Math.min(l || 0, 0.4);
    }

    // ---- 16:9 playfield transform (letterboxed) ------------------------------
    function sizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const MAX_W = 2200;
      const scale = Math.min(dpr, 1.5, MAX_W / Math.max(rect.width, rect.height, 1));
      canvas.width = Math.max(1, Math.round(rect.width * Math.max(0.75, scale)));
      canvas.height = Math.max(1, Math.round(rect.height * Math.max(0.75, scale)));
    }
    // Fit a 16:9 field centred in the canvas; (x,y) are normalized [0..1].
    function field() {
      const W = canvas.width, H = canvas.height;
      const aw = Math.min(W, H * 16 / 9), ah = aw * 9 / 16;
      return { x: (W - aw) / 2, y: (H - ah) / 2, w: aw, h: ah };
    }
    function toScreen(nx, ny, f) { return { x: f.x + nx * f.w, y: f.y + ny * f.h }; }

    // ---- Library / song select ----------------------------------------------
    async function loadBundled() {
      const out = [];
      try {
        const manifest = await fetch('assets/divaft/bundled.json').then((r) => r.json());
        for (const m of manifest) {
          const base = m.dir.replace(/\/$/, '');
          const raw = await fetch(base + '/' + m.chart).then((r) => r.json());
          let chart; try { chart = assembleChart(raw); } catch (e) { continue; }
          out.push({
            id: 'bundled:' + m.id, title: chart.title, artist: chart.artist, stars: chart.stars,
            getChart: () => Promise.resolve(chart),
            getAudio: () => fetch(base + '/' + m.audio).then((r) => r.arrayBuffer()),
          });
        }
      } catch (e) { /* none */ }
      return out;
    }
    function renderSongList() {
      if (!songlistEl) return;
      if (!library.length) { songlistEl.innerHTML = '<div class="diva-empty">No songs yet.</div>'; return; }
      songlistEl.innerHTML = library.map((e, i) =>
        '<button class="diva-song" data-i="' + i + '"><span class="diva-song-title">' + escapeH(e.title || '(untitled)') +
        '</span><span class="diva-song-meta">' + escapeH(e.artist || '') + ' · ~' + (e.stars || 0).toFixed(1) + '★</span></button>'
      ).join('');
    }
    async function refreshLibrary() {
      const bundled = await loadBundled();
      let cached = []; try { cached = await loadCachedCharts(); } catch (e) {}
      library = bundled.concat(cached).concat(cpkLive);
      renderSongList();
    }
    async function loadCachedCharts() {
      // Imported charts store the assembled chart inline and reference shared audio
      // (one ogg per song, deduped across its difficulties) in the 'audio' store.
      const all = await idbGetAll('chart');
      // Guard against any record that predates the current schema (must carry an
      // assembled chart + an audio key) so a stale entry can't crash song select.
      return (all || []).filter((s) => s && s.chart && s.audioKey).map((s) => ({
        id: 'cache:' + s.id, title: s.title, artist: s.artist || '', stars: s.stars || 1,
        getChart: () => Promise.resolve(s.chart),
        getAudio: () => idbGet('audio', s.audioKey).then((u8) => { if (!u8) throw new Error('audio missing for ' + s.id); return u8.slice().buffer; }),
      }));
    }

    // ---- Loose folder import (mod / rom directory) ---------------------------
    function setImportStatus(msg) { const el = document.getElementById('divaft-import-status'); if (el) el.textContent = msg || ''; }
    async function importFolder(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      if (!window.DivaPvdb || !window.DivaDsc) { setImportStatus('Decoder not loaded.'); return; }
      setImportStatus('Reading folder…');
      const relOf = (f) => (f.webkitRelativePath || f.name);
      const dbFile = files.find((f) => /(?:^|\/)(?:mod_)?pv_db\.txt$/i.test(relOf(f)));
      if (!dbFile) { setImportStatus('No pv_db.txt found in that folder.'); return; }
      // pv_db paths (e.g. "rom/script/x.dsc") are mod-root-relative, but the pv_db file
      // itself may live in rom/ or at the root depending on the pack — so resolve by
      // matching the file whose full path ends with the pv_db-relative path.
      const lc = files.map((f) => ({ f: f, p: relOf(f).toLowerCase() }));
      const resolve = (rel) => {
        const want = '/' + String(rel).toLowerCase().replace(/^[./]+/, '');
        for (const e of lc) if (e.p === want.slice(1) || e.p.endsWith(want)) return e.f;
        return null;
      };
      let songs;
      try { songs = window.DivaPvdb.parse(await dbFile.text()); }
      catch (e) { setImportStatus('Could not read pv_db.txt.'); return; }
      // Namespace cache keys by the selected folder so two packs that reuse the same
      // stock PV id (common) don't overwrite each other's audio/charts.
      const pack = (relOf(dbFile).split('/')[0] || 'mod').toLowerCase();
      let imported = 0, skipped = 0, songN = 0;
      for (const song of songs) {
        const diffs = window.DivaPvdb.playableDiffs(song);
        const audioFile = song.audio ? resolve(song.audio) : null;
        if (!diffs.length || !audioFile) { skipped += Math.max(1, diffs.length); continue; }
        songN++; setImportStatus('Importing ' + songN + '/' + songs.length + '… (' + imported + ' charts)');
        const audioKey = pack + '/' + song.id;
        let audioStored = false;
        for (const diff of diffs) {
          const scriptFile = resolve(song.diffs[diff].script);
          if (!scriptFile) { skipped++; continue; }
          try {
            const decoded = window.DivaDsc.decode(await scriptFile.arrayBuffer());
            // Skip corrupt/truncated charts: a valid FT chart terminates at a real END.
            if (!decoded.ended || !decoded.notes.length) { skipped++; continue; }
            const chart = assembleChart({ title: song.title + ' [' + diff + ']', artist: song.artist, bpm: song.bpm, audioFile: song.audio, notes: decoded.notes, chanceTimes: decoded.chanceTimes });
            if (song.diffs[diff].stars) chart.stars = song.diffs[diff].stars;   // prefer the DB's official level
            if (!audioStored) { await idbPut('audio', audioKey, new Uint8Array(await audioFile.arrayBuffer())); audioStored = true; }
            const id = pack + '/' + song.id + '_' + diff;
            await idbPut('chart', id, { id: id, title: chart.title, artist: chart.artist || '', stars: chart.stars, diff: diff, audioKey: audioKey, chart: chart });
            imported++;
          } catch (e) { skipped++; try { console.error('[divaft] import ' + song.id + '/' + diff, e); } catch (_) {} }
        }
      }
      setImportStatus('Imported ' + imported + ' charts · ' + skipped + ' skipped.');
      await refreshLibrary();
    }

    // ---- Base-game CPK import (live, decrypt-on-demand) -----------------------
    // The base diva_main.cpk is ~24 GB and AES-encrypted; we read its TOC and decrypt
    // each chart/audio only when played (the File stays in memory for the session — no
    // mass decrypt, no huge IndexedDB blob). Song NAMES live in the small region CPK's
    // pv_db.txt (diva_main_region.cpk), so the user imports both; files are resolved
    // across all imported CPKs. Without a pv_db we fall back to "PV NNN" titles.
    const DIFF_STARS = { easy: 2, normal: 4, hard: 6, extreme: 8, encore: 9, extra: 9 };
    // resolve a logical path (e.g. rom/script/pv_001_easy.dsc) across every imported CPK
    function resolveCpk(path) {
      for (const src of cpkSources) { const e = src.toc.find(path); if (e) return { read: src.read, entry: e }; }
      return null;
    }
    // chartRef/audioRef are resolved {read, entry} pairs captured at build time, so the
    // exact archive+entry chosen during the rebuild is what plays (no re-resolution).
    function makeCpkEntry(pv, diff, title, stars, chartRef, audioRef, bpm, audioName) {
      const full = title + ' [' + diff + ']';
      return {
        id: 'cpk:' + pv + '_' + diff, title: full, artist: '', stars: stars || DIFF_STARS[diff.replace('+', '')] || 5,
        getChart: async () => {
          const bytes = await window.Cpk.readEntry(chartRef.read, chartRef.entry);
          const dec = window.DivaDsc.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          if (!dec.ended || !dec.notes.length) throw new Error('chart did not decode cleanly');
          return assembleChart({ title: full, bpm: bpm || 0, audioFile: audioName || '', notes: dec.notes, chanceTimes: dec.chanceTimes });
        },
        getAudio: async () => { const b = await window.Cpk.readEntry(audioRef.read, audioRef.entry); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
      };
    }
    // sub-rom preference when the same pv/diff chart exists in several layers
    function subromRank(name) { const t = name.split('/')[0]; return t === 'rom' ? 0 : t === 'rom_steam' ? 1 : t === 'rom_steam_dlc' ? 2 : /ps4/.test(t) ? 3 : t === 'rom_switch' ? 4 : 5; }
    async function importCpk(fileList) {
      if (!window.Cpk) { setImportStatus('CPK reader not loaded.'); return; }
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const myGen = ++cpkImportGen;
      setImportStatus('Reading ' + files.length + ' archive' + (files.length > 1 ? 's' : '') + '…');
      const staged = [];   // read into a local batch; only commit if we're still the winning import
      for (const file of files) {
        if (cpkSources.some((s) => s.name === file.name) || staged.some((s) => s.name === file.name)) continue;
        try { const read = window.Cpk.fileReader(file); const toc = await window.Cpk.readToc(read); staged.push({ name: file.name, read: read, toc: toc }); }
        catch (e) { try { console.error('[divaft] cpk ' + file.name, e); } catch (_) {} }
      }
      if (myGen !== cpkImportGen) return;
      cpkSources = cpkSources.concat(staged);
      if (!cpkSources.length) { setImportStatus('No readable CPK selected.'); return; }
      await rebuildCpkLibrary(myGen);
    }
    async function rebuildCpkLibrary(myGen) {
      // 1) overlay metadata (names, stars, audio, bpm) from any pv_db (the region CPK)
      const meta = {};   // pv_id -> { title, audio, bpm, stars:{diff:n} }
      let havePvdb = false;
      for (const src of cpkSources) {
        const dbEntry = src.toc.entries.find((e) => /(?:^|\/)(?:mod_)?pv_db\.txt$/i.test(e.name));
        if (!dbEntry) continue;
        let txt; try { txt = new TextDecoder().decode(await window.Cpk.readEntry(src.read, dbEntry)); } catch (e) { continue; }
        if (myGen !== cpkImportGen) return;
        havePvdb = true;
        for (const song of window.DivaPvdb.parse(txt)) {
          const m = meta[song.id] || (meta[song.id] = { title: '', audio: '', bpm: 0, stars: {} });
          if (song.title && !/^pv_\d/.test(song.title)) m.title = song.title;   // a real name, not the id fallback
          if (song.audio) m.audio = song.audio;
          if (song.bpm) m.bpm = song.bpm;
          for (const d of window.DivaPvdb.playableDiffs(song)) if (song.diffs[d].stars != null) m.stars[d] = song.diffs[d].stars;
        }
      }
      // 2) enumerate ALL charts by filename across every CPK (the playable set), preferring
      //    the rom/rom_steam layer; pv_db is only an overlay so nothing gets dropped.
      const songs = {};   // pv_id -> { num, diffs:{diff:scriptPath}, rank:{diff:n} }
      for (const src of cpkSources) for (const e of src.toc.entries) {
        const mm = /(?:^|\/)script\/pv_(\d+)_([a-z]+)(_\d+)?\.dsc$/i.exec(e.name);
        if (!mm) continue;
        const pv = 'pv_' + mm[1], diff = mm[2].toLowerCase() + (mm[3] ? '+' : '');
        const s = songs[pv] || (songs[pv] = { num: mm[1], diffs: {}, rank: {} });
        const r = subromRank(e.name);
        if (s.diffs[diff] === undefined || r < s.rank[diff]) { s.diffs[diff] = e.name; s.rank[diff] = r; }
      }
      const next = []; let songCount = 0;
      for (const pv in songs) {
        const s = songs[pv], m = meta[pv] || {};
        // resolve audio once: prefer the pv_db path, else the per-song convention path.
        const audioName = m.audio || ('rom/sound/song/' + pv + '.ogg');
        const audioRef = (m.audio && resolveCpk(m.audio)) || resolveCpk('rom/sound/song/' + pv + '.ogg');
        if (!audioRef) continue;
        const title = m.title || ('PV ' + s.num);
        let any = false;
        for (const diff in s.diffs) {
          const chartRef = resolveCpk(s.diffs[diff]);   // s.diffs[diff] is a full entry name → exact
          if (!chartRef) continue;
          const stars = (m.stars && m.stars[diff.replace('+', '')]) || null;
          next.push(makeCpkEntry(pv, diff, title, stars, chartRef, audioRef, m.bpm || 0, audioName));
          any = true;
        }
        if (any) songCount++;
      }
      if (myGen !== cpkImportGen) return;
      cpkLive = next;
      setImportStatus(songCount + ' songs · ' + cpkLive.length + ' charts from ' + cpkSources.length + ' archive' + (cpkSources.length > 1 ? 's' : '') +
        (havePvdb ? '' : ' — also import diva_main_region.cpk for song names'));
      await refreshLibrary();
    }

    // ---- Input maps ----------------------------------------------------------
    function divaKeys() {
      const d = settings.divaKeys;
      return (d && typeof d === 'object') ? d : { triangle: ['w', 'i'], circle: ['d', 'l'], cross: ['s', 'k'], square: ['a', 'j'], slideL: ['q', 'z'], slideR: ['e', 'c'] };
    }
    function divaMacros() { return Array.isArray(settings.divaMacros) ? settings.divaMacros : []; }
    // key (lowercase) -> array of buttons it triggers (normal binds + macros).
    function buttonsForKey(k) {
      const out = [];
      const map = divaKeys();
      for (const btn in map) if ((map[btn] || []).map((x) => String(x).toLowerCase()).indexOf(k) >= 0) out.push(btn);
      for (const mac of divaMacros()) if (String(mac.key).toLowerCase() === k) for (const b of (mac.buttons || [])) if (out.indexOf(b) < 0) out.push(b);
      return out;
    }
    function allBoundKeys() {
      const set = {};
      const map = divaKeys();
      for (const btn in map) for (const k of (map[btn] || [])) set[String(k).toLowerCase()] = true;
      for (const mac of divaMacros()) set[String(mac.key).toLowerCase()] = true;
      return Object.keys(set);
    }

    // ---- Run lifecycle -------------------------------------------------------
    function teardownRun() {
      if (!run) return;
      run.finished = true; cancelAnimationFrame(run.rafId); bindInput(false);
      try { run.src.stop(); } catch (e) {}
      run = null;
      if (fpsEl) fpsEl.textContent = '';
      if (skipBtn) skipBtn.hidden = true;
      if (keysOverlayEl) keysOverlayEl.innerHTML = '';
    }
    async function loadAndPlay(entry) {
      if (loading) return;
      loading = true; const gen = ++loadGen; teardownRun(); run = null;
      try {
        const chart = await entry.getChart();
        const ac = await ensureCtx();
        const audioBuf = await ac.decodeAudioData(await entry.getAudio());
        if (gen !== loadGen || !panelOpen) return;
        startRun(entry, chart, audioBuf);
      } catch (e) { try { console.error('[divaft] load', e); } catch (_) {} }
      finally { loading = false; }
    }
    function startRun(entry, chart, audioBuf) {
      teardownRun();
      if (deps.pauseBgm) deps.pauseBgm();
      show('game'); grabFocus(); sizeCanvas();
      const ac = audioCtx;
      const objs = chart.notes.map((n) => ({ n: n, headJudged: false, holding: false, tailJudged: n.holdEnd == null, tier: null }));
      const startCtx = ac.currentTime + LEAD_IN_MS / 1000;
      const src = ac.createBufferSource(); const gain = ac.createGain();
      gain.gain.value = Math.max(0, Math.min(1, (Number(settings.musicVol) || 0) / 100)) || 0.6;
      src.buffer = audioBuf; src.connect(gain).connect(ac.destination); src.start(startCtx);
      const lastTime = chart.notes.reduce((m, n) => Math.max(m, n.holdEnd != null ? n.holdEnd : n.time), 0);
      const firstTime = chart.notes.length ? chart.notes[0].time : 0;
      run = {
        entry: entry, chart: chart, objs: objs, src: src, gain: gain, startCtx: startCtx,
        t0perf: performance.now(), t0ctx: ac.currentTime, audioBuf: audioBuf,
        counts: { cool: 0, fine: 0, safe: 0, sad: 0, worst: 0 }, combo: 0, maxCombo: 0,
        errors: [], bursts: [], pressed: {}, groupFirst: {}, lastTime: lastTime, finished: false, rafId: 0,
        auto: autoplay, firstTime: firstTime, skipTo: Math.max(0, firstTime - 1500), skipped: false,
      };
      errTicks = [];
      fpsFrames = 0; fpsLast = performance.now(); fpsPrev = 0; fpsMaxDt = 0;
      buildKeyOverlay();
      bindInput(true);
      run.rafId = requestAnimationFrame(loop);
      updateHud();
    }
    function songTimeNow() { return (audioCtx.currentTime - run.startCtx - audioLatency()) * 1000; }
    function inputSongTime(perfTs) {
      const ctxAtInput = run.t0ctx + (perfTs - run.t0perf) / 1000;
      return (ctxAtInput - run.startCtx - audioLatency()) * 1000 - calOffset();
    }
    function loop() {
      if (!run || run.finished) return;
      const st = songTimeNow();
      if (run.auto) autoPlay(st);
      sweepMisses(st);
      render(st);
      tickFps();
      updateSkip(st);
      if (st > run.lastTime + END_PAD_MS) { finishRun(); return; }
      run.rafId = requestAnimationFrame(loop);
    }

    // ---- Judgement -----------------------------------------------------------
    const TIER_LABEL = { cool: 'COOL', fine: 'FINE', safe: 'SAFE', sad: 'SAD', worst: 'WORST' };
    const TIER_ORDER = { cool: 0, fine: 1, safe: 2, sad: 3, worst: 4 };
    const TIER_COLOR = { cool: '#ffd022', fine: '#4ebeff', safe: '#00a13c', sad: '#57a9ff', worst: '#e470ff' };   // PH Future Tone rating colours
    function credit(tier, n) {
      run.counts[tier]++;
      if (tier === 'worst') run.combo = 0;
      else { run.combo++; run.maxCombo = Math.max(run.maxCombo, run.combo); }
      if (n) run.bursts.push({ x: n.x, y: n.y, tier: tier, t: performance.now() });
      if (run.bursts.length > 40) run.bursts.shift();
      flashJudge(tier); updateHud();
    }
    function press(button, perfTs) {
      if (!run || run.finished || run.auto) return;
      const st = inputSongTime(perfTs);
      let i = matchNote(run.objs, button, st, WINDOWS.sad);
      // A slide press also clears a star note (Diva: stars take any slide).
      if (i < 0 && (button === 'slideL' || button === 'slideR')) i = matchNote(run.objs, 'star', st, WINDOWS.sad);
      if (i < 0) return;
      const o = run.objs[i];
      const err = st - o.n.time;
      let tier = tierFor(Math.abs(err));
      // Chord coupling: members of a multi must be struck together. The first member
      // anchors the group; later members struck more than DOUBLE_WINDOW apart are
      // capped at 'safe' (sloppy chords lose the top tiers). Macros/autoplay fire all
      // members at the same timestamp, so they never trip the penalty.
      const gid = o.n.groupId;
      if (gid != null) {
        if (run.groupFirst[gid] == null) run.groupFirst[gid] = st;
        else if (Math.abs(st - run.groupFirst[gid]) > DOUBLE_WINDOW && TIER_ORDER[tier] < TIER_ORDER.safe) tier = 'safe';
      }
      o.headJudged = true; o.tier = tier;
      if (tier !== 'worst') { run.errors.push(err); recordErrTick(err, tier); playHit(); }
      if (o.n.holdEnd != null && tier !== 'worst') { o.holding = true; run.pressed[button] = (run.pressed[button] || 0) + 1; }
      credit(tier, o.n);
    }
    function release(button, perfTs) {
      if (!run || run.finished || run.auto) return;
      const st = inputSongTime(perfTs);   // same mapping as press(): honours latency + calibration
      for (const o of run.objs) {
        if (o.n.button === button && o.holding && !o.tailJudged) {
          o.holding = false; o.tailJudged = true;
          const early = Math.max(0, o.n.holdEnd - st);
          const tier = early <= WINDOWS.cool ? 'cool' : early <= WINDOWS.fine ? 'fine' : early <= WINDOWS.safe ? 'safe' : early <= WINDOWS.sad ? 'sad' : 'worst';
          credit(tier, o.n);
        }
      }
    }
    function sweepMisses(st) {
      for (const o of run.objs) {
        if (!o.headJudged && st > o.n.time + WINDOWS.sad) { o.headJudged = true; o.tier = 'worst'; credit('worst', o.n); }
        if (o.n.holdEnd != null && o.headJudged && !o.tailJudged && st > o.n.holdEnd + WINDOWS.sad) {
          o.tailJudged = true; if (o.holding) { o.holding = false; credit('cool', o.n); } else credit('worst', o.n);
        }
      }
    }
    // Autoplay: hit every note perfectly on time, hold through tails.
    function autoPlay(st) {
      for (const o of run.objs) {
        if (!o.headJudged && st >= o.n.time) {
          o.headJudged = true; o.tier = 'cool'; run.errors.push(0); recordErrTick(0, 'cool'); playHit();
          if (o.n.holdEnd != null) o.holding = true;
          credit('cool', o.n);
        }
        if (o.n.holdEnd != null && o.holding && !o.tailJudged && st >= o.n.holdEnd) {
          o.holding = false; o.tailJudged = true; credit('cool', o.n);
        }
      }
    }
    function playHit() { if (window.Hitsound && audioCtx) window.Hitsound.play(audioCtx); }

    // ---- UR error bar (reuse vsrg's idea) -----------------------------------
    let errTicks = [];
    function recordErrTick(errMs, tier) { errTicks.push({ err: errMs, tier: tier, t: performance.now() }); if (errTicks.length > 64) errTicks.shift(); }
    function unstableRate(errs) {
      if (!errs || errs.length < 2) return 0;
      const m = errs.reduce((a, b) => a + b, 0) / errs.length;
      const v = errs.reduce((s, e) => s + (e - m) * (e - m), 0) / errs.length;
      return Math.sqrt(v) * 10;
    }

    // ---- Render --------------------------------------------------------------
    function buttonPath(gg, btn, x, y, r) {
      gg.beginPath();
      if (btn === 'triangle') { gg.moveTo(x, y - r); gg.lineTo(x + r * 0.87, y + r * 0.5); gg.lineTo(x - r * 0.87, y + r * 0.5); gg.closePath(); }
      else if (btn === 'circle') { gg.arc(x, y, r, 0, Math.PI * 2); }
      else if (btn === 'cross') { const s = r * 0.7; gg.moveTo(x - s, y - s); gg.lineTo(x + s, y + s); gg.moveTo(x + s, y - s); gg.lineTo(x - s, y + s); }
      else if (btn === 'square') { gg.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); }
      else if (btn === 'star') { for (let k = 0; k < 5; k++) { const oa = -Math.PI / 2 + k * 2 * Math.PI / 5, ia = oa + Math.PI / 5; const ox = x + Math.cos(oa) * r, oy = y + Math.sin(oa) * r, ix = x + Math.cos(ia) * r * 0.45, iy = y + Math.sin(ia) * r * 0.45; if (k === 0) gg.moveTo(ox, oy); else gg.lineTo(ox, oy); gg.lineTo(ix, iy); } gg.closePath(); }
      else { /* slideL/slideR → arrow */ const d = btn === 'slideL' ? -1 : 1; gg.moveTo(x - r * d, y); gg.lineTo(x + r * 0.2 * d, y - r * 0.7); gg.lineTo(x + r * 0.2 * d, y - r * 0.25); gg.lineTo(x + r * d, y - r * 0.25); gg.lineTo(x + r * d, y + r * 0.25); gg.lineTo(x + r * 0.2 * d, y + r * 0.25); gg.lineTo(x + r * 0.2 * d, y + r * 0.7); gg.closePath(); }
    }
    function render(st) {
      const W = canvas.width, H = canvas.height, dpr = window.devicePixelRatio || 1;
      const f = field();
      g.clearRect(0, 0, W, H); g.fillStyle = '#0b0c10'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1 * dpr; g.strokeRect(f.x, f.y, f.w, f.h);
      const R = Math.max(10, f.h * 0.045);   // target radius
      // Faint connectors linking multi-note groups and slide chains (Diva's visual cue
      // that these notes belong together). Only upcoming, unjudged members are linked.
      const links = {};
      for (let i = 0; i < run.objs.length; i++) {
        const o = run.objs[i], n = o.n;
        if (o.headJudged || st < n.time - n.flyTime) continue;
        const key = n.groupId != null ? 'g' + n.groupId : (n.slideChain != null ? 's' + n.slideChain : null);
        if (key == null) continue;
        (links[key] || (links[key] = [])).push(toScreen(n.x, n.y, f));
      }
      g.lineWidth = 2 * dpr; g.strokeStyle = 'rgba(255,255,255,0.18)';
      for (const k in links) {
        const pts = links[k]; if (pts.length < 2) continue;
        g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
        for (let j = 1; j < pts.length; j++) g.lineTo(pts[j].x, pts[j].y);
        g.stroke();
      }
      // notes newest-first so upcoming sit on top
      for (let i = run.objs.length - 1; i >= 0; i--) {
        const o = run.objs[i], n = o.n;
        if (o.headJudged && o.tailJudged) continue;
        const appear = n.time - n.flyTime;
        if (st < appear) continue;
        const t = toScreen(n.x, n.y, f);
        const col = BUTTON_COLOR[n.button] || '#fff';
        if (!o.headJudged) {
          const p = Math.max(0, Math.min(1, (st - appear) / n.flyTime));
          const ip = trailPoint(n, p); const sc = toScreen(ip.x, ip.y, f);
          // target ghost
          g.globalAlpha = 0.5; g.strokeStyle = col; g.lineWidth = 3 * dpr;
          buttonPath(g, n.button, t.x, t.y, R); g.stroke();
          // shrink ring (press cue)
          g.globalAlpha = 0.8 * (1 - p) + 0.2; g.strokeStyle = '#fff'; g.lineWidth = 2 * dpr;
          g.beginPath(); g.arc(t.x, t.y, R * (1 + (1 - p) * 2.6), 0, Math.PI * 2); g.stroke();
          // flying icon
          g.globalAlpha = 1; g.fillStyle = col;
          if (n.button === 'cross') { g.strokeStyle = col; g.lineWidth = 5 * dpr; buttonPath(g, n.button, sc.x, sc.y, R); g.stroke(); }
          else { buttonPath(g, n.button, sc.x, sc.y, R); g.fill(); }
        }
        // hold bar
        if (n.holdEnd != null && o.headJudged && !o.tailJudged) {
          g.globalAlpha = o.holding ? 0.9 : 0.4; g.strokeStyle = col; g.lineWidth = 4 * dpr;
          buttonPath(g, n.button, t.x, t.y, R); g.stroke();
        }
        g.globalAlpha = 1;
      }
      // bursts
      const nowB = performance.now();
      for (let i = run.bursts.length - 1; i >= 0; i--) {
        const b = run.bursts[i], age = nowB - b.t; if (age > 320) { run.bursts.splice(i, 1); continue; }
        const k = age / 320, sc = toScreen(b.x, b.y, f);
        g.globalAlpha = 1 - k; g.strokeStyle = TIER_COLOR[b.tier] || '#fff'; g.lineWidth = 3 * dpr;
        g.beginPath(); g.arc(sc.x, sc.y, R * (1 + k * 0.8), 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
      }
      // UR bar
      drawErrorBar(W, H, dpr);
    }
    function drawErrorBar(W, H, dpr) {
      const cx = W / 2, y = H - 28 * dpr, half = W * 0.20, bad = WINDOWS.sad;
      const px = half / bad;
      const zone = (ms, c) => { g.fillStyle = c; g.fillRect(cx - ms * px, y - 5 * dpr, ms * px * 2, 10 * dpr); };
      zone(WINDOWS.sad, 'rgba(255,159,67,0.18)'); zone(WINDOWS.safe, 'rgba(255,209,102,0.20)');
      zone(WINDOWS.fine, 'rgba(86,160,255,0.22)'); zone(WINDOWS.cool, 'rgba(57,217,138,0.30)');
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(cx - dpr, y - 9 * dpr, 2 * dpr, 18 * dpr);
      const now = performance.now();
      for (let i = errTicks.length - 1; i >= 0; i--) {
        const e = errTicks[i], age = now - e.t; if (age > 2500) { errTicks.splice(i, 1); continue; }
        const x = cx + Math.max(-half, Math.min(half, e.err * px));
        g.globalAlpha = 1 - age / 2500; g.fillStyle = TIER_COLOR[e.tier] || '#fff';
        g.fillRect(x - dpr, y - 8 * dpr, 2 * dpr, 16 * dpr); g.globalAlpha = 1;
      }
    }
    function tickFps() {
      if (!fpsEl) return;
      const now = performance.now();
      if (fpsPrev) { const dt = now - fpsPrev; if (dt > fpsMaxDt) fpsMaxDt = dt; }
      fpsPrev = now; fpsFrames++;
      const el = now - fpsLast;
      if (el >= 500) {
        const fps = Math.round(fpsFrames * 1000 / el), avg = el / fpsFrames;
        fpsEl.textContent = (settings.showFps !== false) ? (fps + ' FPS · ' + avg.toFixed(1) + ' ms · max ' + Math.round(fpsMaxDt) + ' ms') : '';
        fpsFrames = 0; fpsLast = now; fpsMaxDt = 0;
      }
    }
    function flashJudge(tier) {
      if (!judgeEl) return;
      judgeEl.textContent = TIER_LABEL[tier] || tier; judgeEl.style.color = TIER_COLOR[tier] || '#fff';
      judgeEl.style.transition = 'none'; judgeEl.style.opacity = '1';
      requestAnimationFrame(() => { judgeEl.style.transition = 'opacity .3s'; judgeEl.style.opacity = '0'; });
    }
    function updateHud() {
      if (comboEl) comboEl.textContent = run.combo > 1 ? run.combo + 'x' : '';
      if (accEl) { const ur = unstableRate(run.errors); accEl.textContent = accuracy(run.counts).toFixed(2) + '%' + (ur ? '  ·  UR ' + Math.round(ur) : ''); }
    }

    // ---- Skip ----------------------------------------------------------------
    function updateSkip(st) {
      if (!skipBtn) return;
      const showit = !run.skipped && run.skipTo > 800 && st < run.skipTo - 100;
      if (skipBtn.hidden === showit) skipBtn.hidden = !showit;
    }
    function doSkip() {
      if (!run || run.finished || run.skipped || songTimeNow() >= run.skipTo - 50) return;
      const ac = audioCtx, when = ac.currentTime;
      try { run.src.stop(); } catch (e) {}
      const src = ac.createBufferSource(); src.buffer = run.audioBuf; src.connect(run.gain);
      src.start(when, run.skipTo / 1000); run.src = src;
      run.startCtx = when - run.skipTo / 1000; run.t0ctx = ac.currentTime; run.t0perf = performance.now();
      run.skipped = true; skipBtn.hidden = true;
    }

    // ---- Key overlay ---------------------------------------------------------
    let keyBoxes = {}, keyCounts = {};
    function buildKeyOverlay() {
      if (!keysOverlayEl) return;
      keyBoxes = {}; keyCounts = {}; keysOverlayEl.innerHTML = '';
      BUTTONS.slice(0, 6).forEach((b) => {
        const box = document.createElement('div'); box.className = 'diva-key';
        const lbl = { triangle: '△', circle: '○', cross: '✕', square: '□', slideL: '◄', slideR: '►' }[b] || b;
        box.innerHTML = '<span class="diva-key-label" style="color:' + (BUTTON_COLOR[b] || '#fff') + '">' + lbl + '</span><span class="diva-key-count">0</span>';
        keysOverlayEl.appendChild(box); keyBoxes[b] = box; keyCounts[b] = 0;
      });
    }
    function flashKey(b) { const box = keyBoxes[b]; if (!box) return; keyCounts[b] = (keyCounts[b] || 0) + 1; box.querySelector('.diva-key-count').textContent = keyCounts[b]; box.classList.add('active'); setTimeout(() => box.classList.remove('active'), 80); }

    // ---- Input binding -------------------------------------------------------
    function bindInput(on) {
      const fn = on ? 'addEventListener' : 'removeEventListener';
      window[fn]('keydown', onKeyDown);
      window[fn]('keyup', onKeyUp);
    }
    function onKeyDown(e) {
      if (!run || run.finished) return;
      if (e.key === 'Escape') { quitToSelect(); return; }
      if ((e.key === ' ' || e.code === 'Space') && skipBtn && !skipBtn.hidden) { e.preventDefault(); doSkip(); return; }
      const k = e.key.toLowerCase();
      const btns = buttonsForKey(k);
      if (!btns.length) return;
      if (run.heldKeys && run.heldKeys[k]) return;   // ignore auto-repeat
      run.heldKeys = run.heldKeys || {}; run.heldKeys[k] = true;
      e.preventDefault();
      for (const b of btns) { flashKey(b); press(b, e.timeStamp); }
    }
    function onKeyUp(e) {
      if (!run) return;
      const k = e.key.toLowerCase();
      if (run.heldKeys) run.heldKeys[k] = false;
      for (const b of buttonsForKey(k)) release(b, e.timeStamp);
    }

    // ---- Results / PB --------------------------------------------------------
    async function finishRun() {
      if (!run || run.finished) return;
      const isAuto = run.auto;
      run.finished = true; cancelAnimationFrame(run.rafId); bindInput(false);
      try { run.src.stop(); } catch (e) {}
      const acc = accuracy(run.counts), c = run.counts;
      const rank = clearRank(acc, c);
      const rankColor = { PERFECT: '#ffd022', EXCELLENT: '#39d98a', GREAT: '#4ebeff', STANDARD: '#b06bff', CHEAP: '#ff5470' }[rank];
      let prev = null, improved = false, pbFailed = false;
      if (!isAuto) {
        // Never let a storage error swallow the results screen — degrade to "not saved".
        try {
          prev = await idbGet('diva-pb', run.entry.id);
          improved = !prev || acc > prev.accuracy;
          if (improved) await idbPut('diva-pb', run.entry.id, { accuracy: acc, maxCombo: run.maxCombo, date: new Date().toISOString() });
        } catch (e) { pbFailed = true; prev = null; improved = false; try { console.error('[divaft] PB store', e); } catch (_) {} }
      }
      const cell = (label, val, col) => '<div class="diva-res-cell"><div class="diva-res-cn" style="color:' + col + '">' + val + '</div><div class="diva-res-cl">' + label + '</div></div>';
      resultsBody.innerHTML =
        '<div class="diva-res-title">' + escapeH(run.entry.title) + '</div>' +
        '<div class="diva-res-rank" style="color:' + rankColor + '">' + rank + '</div>' +
        '<div class="diva-res-acc">' + acc.toFixed(2) + '%</div>' +
        '<div class="diva-res-grid">' + cell('COOL', c.cool, '#ffd022') + cell('FINE', c.fine, '#4ebeff') + cell('SAFE', c.safe, '#00a13c') + cell('SAD', c.sad, '#57a9ff') + cell('WORST', c.worst, '#e470ff') + '</div>' +
        '<div class="diva-res-combo">Max combo ' + run.maxCombo + 'x &nbsp;·&nbsp; UR ' + Math.round(unstableRate(run.errors)) + '</div>' +
        (isAuto ? '<div class="diva-res-pb">Autoplay preview — not saved.</div>'
                : pbFailed ? '<div class="diva-res-pb">Score couldn\'t be saved (storage unavailable).</div>'
                : (prev ? '<div class="diva-res-pb">Previous best: ' + prev.accuracy.toFixed(2) + '%' + (improved ? ' — <b>new best!</b>' : '') + '</div>'
                        : '<div class="diva-res-pb">First clear — saved as your best.</div>'));
      show('results');
    }
    function quitToSelect() { loadGen++; teardownRun(); if (deps.resumeBgm) deps.resumeBgm(); show('select'); renderSongList(); }

    // ---- Keybind / macro UI --------------------------------------------------
    let rebind = null;   // { kind:'button'|'macro', target, slot }
    function renderKeybinds() {
      if (keybindsEl) {
        const map = divaKeys();
        keybindsEl.innerHTML = BUTTONS.slice(0, 6).map((b) => {
          const lbl = { triangle: '△ Triangle', circle: '○ Circle', cross: '✕ Cross', square: '□ Square', slideL: '◄ Slide L', slideR: '► Slide R' }[b];
          const keys = (map[b] || []).map((k, s) => '<button class="diva-kb" data-b="' + b + '" data-s="' + s + '">' + (k === ' ' ? '␣' : (k || '—').toUpperCase()) + '</button>').join('');
          return '<div class="diva-kb-row"><span>' + lbl + '</span>' + keys + '</div>';
        }).join('');
      }
      if (macrosEl) {
        const macros = divaMacros();
        let html = '';
        for (let i = 0; i < 4; i++) {
          const m = macros[i] || { key: '', buttons: [] };
          const keyBtn = '<button class="diva-kb" data-mac="' + i + '">' + (m.key ? m.key.toUpperCase() : '+ key') + '</button>';
          const toggles = FACE.map((b) => '<button class="diva-mac-tog' + (m.buttons.indexOf(b) >= 0 ? ' on' : '') + '" data-mact="' + i + '" data-b="' + b + '">' + ({ triangle: '△', circle: '○', cross: '✕', square: '□' }[b]) + '</button>').join('');
          html += '<div class="diva-kb-row"><span>Macro ' + (i + 1) + '</span>' + keyBtn + toggles + '</div>';
        }
        macrosEl.innerHTML = html;
      }
    }

    // ---- Calibration (port of osu/vsrg) --------------------------------------
    let calibLoop = null, calibTiming = null, tapState = null, calibGen = 0;
    function tapReset() { tapState = null; if (tapResultEl) tapResultEl.textContent = ''; if (tapBtn) tapBtn.textContent = 'Tap to the beat'; }
    function registerTap(perfTs) {
      if (!tapState) return;
      const tapCtx = tapState.tc0 + (perfTs - tapState.tp0) / 1000;
      const k = Math.round((tapCtx - tapState.baseTick) / tapState.period); if (k < 0) return;
      const beat = tapState.baseTick + k * tapState.period;
      const errMs = (tapCtx - beat - audioLatency()) * 1000;
      if (Math.abs(errMs) > tapState.period * 1000 / 2) return;
      tapState.errors.push(errMs);
      if (tapBtn) tapBtn.textContent = 'Tap! (' + tapState.errors.length + '/12)';
      if (tapState.errors.length >= 12) finishTap();
    }
    function finishTap() {
      const e = tapState.errors.slice().sort((a, b) => a - b).slice(1, -1);
      const off = Math.round(e.reduce((a, b) => a + b, 0) / (e.length || 1));
      settings.divaCalibrationOffset = off; if (deps.saveSettings) deps.saveSettings();
      if (calibSlider) calibSlider.value = off; if (calibValEl) calibValEl.textContent = off + ' ms';
      if (tapResultEl) tapResultEl.textContent = 'Your offset: ' + off + ' ms (set). Tap again to redo.';
      tapState = null; if (tapBtn) tapBtn.textContent = 'Tap to the beat';
    }
    function onTapButton(perfTs) { if (!calibTiming) return; if (!tapState) tapState = { baseTick: calibTiming.baseTick, period: calibTiming.period, tc0: calibTiming.tc0, tp0: calibTiming.tp0, errors: [] }; registerTap(perfTs); }
    function openCalibration() {
      show('calib'); tapReset();
      const myGen = ++calibGen;   // invalidate any pending start if the screen is left before audio resolves
      if (calibSlider) { calibSlider.value = calOffset(); if (calibValEl) calibValEl.textContent = calOffset() + ' ms'; }
      ensureCtx().then((ac) => {
        if (myGen !== calibGen) return;   // panel/screen was closed while ensureCtx() was pending
        const cctx = calibCanvas ? calibCanvas.getContext('2d') : null;
        const period = 0.6, baseTick = ac.currentTime + 0.2;
        calibTiming = { baseTick: baseTick, period: period, tc0: ac.currentTime, tp0: performance.now() };
        let nextTick = baseTick;
        (function tick() {
          if (!calibTiming) return;
          while (nextTick < ac.currentTime + 0.1) {
            const o = ac.createOscillator(), gg = ac.createGain(); o.frequency.value = 1200;
            gg.gain.setValueAtTime(0.0001, nextTick); gg.gain.exponentialRampToValueAtTime(0.4, nextTick + 0.001); gg.gain.exponentialRampToValueAtTime(0.0001, nextTick + 0.05);
            o.connect(gg).connect(ac.destination); o.start(nextTick); o.stop(nextTick + 0.06); nextTick += period;
          }
          if (cctx) {
            const rel = ac.currentTime - baseTick - audioLatency() - calOffset() / 1000;
            const phase = (((rel % period) + period) % period) / period, flash = phase < 0.12;
            cctx.clearRect(0, 0, calibCanvas.width, calibCanvas.height); cctx.fillStyle = flash ? '#39d98a' : '#1a1c22';
            cctx.beginPath(); cctx.arc(calibCanvas.width / 2, calibCanvas.height / 2, 40, 0, Math.PI * 2); cctx.fill();
          }
          calibLoop = requestAnimationFrame(tick);
        })();
      });
    }
    function closeCalibration() { calibGen++; if (calibLoop) cancelAnimationFrame(calibLoop); calibLoop = null; calibTiming = null; tapReset(); show('select'); }

    // ---- Open / close --------------------------------------------------------
    function open() {
      panel.classList.add('open'); panelOpen = true;
      if (deps.captureKeyboard) deps.captureKeyboard(true);
      show('select'); refreshLibrary(); renderKeybinds();
    }
    function close() {
      loadGen++; if (run && !run.finished) quitToSelect();
      calibGen++; if (calibLoop) { cancelAnimationFrame(calibLoop); calibLoop = null; calibTiming = null; }
      panel.classList.remove('open'); panelOpen = false;
      if (deps.captureKeyboard) deps.captureKeyboard(false);
      if (deps.resumeBgm) deps.resumeBgm();
      if (settings.gameMode === 'diva') { settings.gameMode = 'clicker'; if (deps.saveSettings) deps.saveSettings(); window.dispatchEvent(new CustomEvent('gamemodechange')); }
    }

    // ---- Wiring --------------------------------------------------------------
    if (songlistEl) songlistEl.addEventListener('click', (e) => { const b = e.target.closest('.diva-song'); if (!b) return; const entry = library[Number(b.getAttribute('data-i'))]; if (entry) loadAndPlay(entry); });
    if (exitBtn) exitBtn.addEventListener('click', close);
    const importBtn = document.getElementById('divaft-import');
    const importInput = document.getElementById('divaft-import-input');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => importInput.click());
      importInput.addEventListener('change', () => { importFolder(importInput.files); importInput.value = ''; });
    }
    const importCpkBtn = document.getElementById('divaft-import-cpk');
    const importCpkInput = document.getElementById('divaft-import-cpk-input');
    if (importCpkBtn && importCpkInput) {
      importCpkBtn.addEventListener('click', () => importCpkInput.click());
      importCpkInput.addEventListener('change', () => { if (importCpkInput.files.length) importCpk(importCpkInput.files); importCpkInput.value = ''; });
    }
    if (retryBtn) retryBtn.addEventListener('click', () => { if (run && run.entry) loadAndPlay(run.entry); else if (library[0]) loadAndPlay(library[0]); });
    if (backBtn) backBtn.addEventListener('click', quitToSelect);
    if (skipBtn) skipBtn.addEventListener('click', doSkip);
    if (autoBtn) autoBtn.addEventListener('click', () => { autoplay = !autoplay; autoBtn.classList.toggle('on', autoplay); autoBtn.textContent = 'Auto: ' + (autoplay ? 'on' : 'off'); });
    if (keysBtn) keysBtn.addEventListener('click', () => { renderKeybinds(); show('keys'); });
    if (keysDoneBtn) keysDoneBtn.addEventListener('click', () => show('select'));
    if (hitsoundBtn) hitsoundBtn.addEventListener('click', () => { show('hitsound'); if (window.Hitsound) window.Hitsound.renderControls(hsControlsEl); });
    if (hitsoundDoneBtn) hitsoundDoneBtn.addEventListener('click', () => show('select'));
    if (calibrateBtn) calibrateBtn.addEventListener('click', openCalibration);
    if (calibDoneBtn) calibDoneBtn.addEventListener('click', closeCalibration);
    if (tapBtn) tapBtn.addEventListener('click', (e) => onTapButton(e.timeStamp));
    if (calibSlider) calibSlider.addEventListener('input', (e) => { settings.divaCalibrationOffset = Number(e.target.value); if (calibValEl) calibValEl.textContent = settings.divaCalibrationOffset + ' ms'; if (deps.saveSettings) deps.saveSettings(); });
    // keybind rebinding + macro toggles
    if (keybindsEl) keybindsEl.addEventListener('click', (e) => { const b = e.target.closest('.diva-kb'); if (!b || b.getAttribute('data-b') == null) return; rebind = { kind: 'button', b: b.getAttribute('data-b'), s: Number(b.getAttribute('data-s')) }; b.textContent = '…'; });
    if (macrosEl) macrosEl.addEventListener('click', (e) => {
      const keyB = e.target.closest('[data-mac]');
      const tog = e.target.closest('[data-mact]');
      const macros = (settings.divaMacros = divaMacros().slice());
      if (keyB) { const i = Number(keyB.getAttribute('data-mac')); rebind = { kind: 'macro', i: i }; keyB.textContent = '…'; return; }
      if (tog) {
        const i = Number(tog.getAttribute('data-mact')), btn = tog.getAttribute('data-b');
        while (macros.length <= i) macros.push({ key: '', buttons: [] });
        const set = macros[i].buttons; const at = set.indexOf(btn); if (at >= 0) set.splice(at, 1); else set.push(btn);
        if (deps.saveSettings) deps.saveSettings(); renderKeybinds();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (rebind === null) return;
      if (!panelOpen || screens.keys.hidden) { rebind = null; return; }
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape') { rebind = null; renderKeybinds(); return; }
      const k = e.key.toLowerCase(); if (k.length !== 1 && k !== ' ') return;
      if (rebind.kind === 'button') { const map = (settings.divaKeys = JSON.parse(JSON.stringify(divaKeys()))); map[rebind.b][rebind.s] = k; }
      else { const macros = (settings.divaMacros = divaMacros().slice()); while (macros.length <= rebind.i) macros.push({ key: '', buttons: [] }); macros[rebind.i].key = k; }
      if (deps.saveSettings) deps.saveSettings(); rebind = null; renderKeybinds();
    }, true);
    window.addEventListener('keydown', (e) => { if (e.key !== 'Escape' || !panelOpen) return; if (run && !run.finished) return; if (screens.keys && !screens.keys.hidden) { show('select'); return; } if (screens.hitsound && !screens.hitsound.hidden) { show('select'); return; } if (screens.calib && !screens.calib.hidden) { closeCalibration(); return; } if (screens.results && !screens.results.hidden) { quitToSelect(); return; } close(); });
    window.addEventListener('resize', () => { if (run && !run.finished) sizeCanvas(); });
    if (canvas) { canvas.setAttribute('tabindex', '0'); canvas.style.outline = 'none'; }
    if (panel) panel.addEventListener('pointerdown', grabFocus);

    api.open = open; api.close = close;
  }

  // ---- IndexedDB (Diva charts + bests) --------------------------------------
  let _db = null;
  function idb() {
    if (_db) return _db;
    _db = new Promise((res, rej) => {
      const req = indexedDB.open('aobing-divaft', 2);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('chart')) db.createObjectStore('chart'); if (!db.objectStoreNames.contains('diva-pb')) db.createObjectStore('diva-pb'); if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio'); };
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });
    return _db;
  }
  function idbPut(store, key, val) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }
  function idbGet(store, key) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const r = tx.objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); }
  function idbGetAll(store) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const r = tx.objectStore(store).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); })); }

  window.DivaGame = api;
  if (window.__divaftDeps) initBrowser(window.__divaftDeps);

})();
