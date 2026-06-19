'use strict';

/*
 * hitsound.js — shared hitsound engine for the rhythm modes (osu!standard + mania).
 *
 * One place owns the hitsound so both modes behave identically and a custom sound
 * uploaded in one shows up in the other. Exposes window.Hitsound:
 *   init(deps)              — wire { settings, saveSettings } (called by app.js)
 *   play(audioCtx)          — play the current hitsound in that context (on each hit)
 *   renderControls(el)      — build the picker/upload/volume/test UI into `el`
 *
 * Sounds: a few synthesized presets (no assets) or a user-uploaded file. The custom
 * file's bytes persist in IndexedDB and are decoded lazily per AudioContext (each
 * mode has its own context). Settings used: hitsoundKind, hitsoundVol.
 */
(function () {
  if (typeof document === 'undefined') return;   // browser-only (no-op under Node)

  // Synthesized presets: a short pitch-swept blip with a fast decay envelope.
  const PRESETS = {
    soft: { label: 'Soft', type: 'triangle', f0: 900,  f1: 260, dur: 0.07, peak: 0.45 },
    tick: { label: 'Tick', type: 'square',   f0: 1700, f1: 950, dur: 0.03, peak: 0.28 },
    drum: { label: 'Drum', type: 'sine',     f0: 220,  f1: 70,  dur: 0.12, peak: 0.60 },
    beep: { label: 'Beep', type: 'sine',     f0: 1250, f1: 1250, dur: 0.05, peak: 0.40 },
  };
  const DEFAULT_KIND = 'soft';

  let deps = { settings: {}, saveSettings: function () {} };
  let customBytes = null, customName = '', customVer = 0;   // uploaded sound (bytes + cache version)
  let previewCtx = null;

  function settings() { return deps.settings || {}; }
  function kind() {
    const k = settings().hitsoundKind;
    if (k === 'custom') return 'custom';
    return PRESETS[k] ? k : DEFAULT_KIND;
  }
  function vol() { const v = Number(settings().hitsoundVol); return isNaN(v) ? 35 : v; }
  function escapeName(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---- Persisted custom sound (IndexedDB) ----------------------------------
  let _db = null;
  function idb() {
    if (_db) return _db;
    _db = new Promise((res, rej) => {
      const r = indexedDB.open('aobing-hitsound', 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('custom')) db.createObjectStore('custom'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return _db;
  }
  function idbPut(k, v) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction('custom', 'readwrite'); tx.objectStore('custom').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }
  function idbGet(k) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction('custom', 'readonly'); const q = tx.objectStore('custom').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })); }
  function idbDel(k) { return idb().then((db) => new Promise((res, rej) => { const tx = db.transaction('custom', 'readwrite'); tx.objectStore('custom').delete(k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }

  async function loadCustom() {
    try { const rec = await idbGet('current'); if (rec && rec.bytes) { customBytes = rec.bytes; customName = rec.name || 'custom'; customVer++; } } catch (e) {}
  }
  function init(d) { if (d) deps = d; loadCustom(); }

  // ---- Playback ------------------------------------------------------------
  // scale (default 1) attenuates volume for softer events (e.g. slider ticks).
  function play(ctx, scale) {
    const v = vol() * (scale == null ? 1 : scale); if (!ctx || !(v > 0)) return;
    if (kind() === 'custom' && customBytes) { playCustom(ctx, v); return; }
    playPreset(ctx, PRESETS[kind()] || PRESETS[DEFAULT_KIND], v);
  }
  function playPreset(ctx, p, v) {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = p.type;
    o.frequency.setValueAtTime(p.f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, p.f1), t + p.dur * 0.6);
    const peak = Math.min(1, v / 100) * p.peak;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + p.dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + p.dur + 0.02);
  }
  // Decode the custom file lazily per context (tagged with customVer so a new
  // upload re-decodes). The very first hit after an upload may be silent while
  // the async decode resolves — every hit after plays the sample.
  function playCustom(ctx, v) {
    if (ctx.__hsVer === customVer && ctx.__hsBuf) { playBuffer(ctx, ctx.__hsBuf, v); return; }
    if (ctx.__hsDecoding === customVer) return;
    ctx.__hsDecoding = customVer;
    try {
      ctx.decodeAudioData(customBytes.slice().buffer)
        .then((b) => { ctx.__hsBuf = b; ctx.__hsVer = customVer; ctx.__hsDecoding = -1; })
        .catch(() => { ctx.__hsDecoding = -1; });
    } catch (e) { ctx.__hsDecoding = -1; }
  }
  function playBuffer(ctx, buf, v) {
    const src = ctx.createBufferSource(), g = ctx.createGain();
    g.gain.value = Math.min(1, v / 100);
    src.buffer = buf; src.connect(g).connect(ctx.destination); src.start();
  }

  // Slider tick (osu's slidertick): a short bright blip, beat-synced by the caller.
  // Distinct from the configured hit sound so the rhythm reads clearly over the slide.
  function tick(ctx) {
    const v = vol(); if (!ctx || !(v > 0)) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(1750, t);
    const peak = Math.min(1, v / 100) * 0.32;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.05);
  }

  // ---- Map-controlled additions (whistle / finish / clap) ------------------
  // osu objects carry a hitsound bitmask (1 normal, 2 whistle, 4 finish, 8 clap);
  // the normal always plays and the others layer on top. Synthesized here so a map
  // gets "different sounds for different clicks" without per-skin samples.
  function noiseBuf(ctx) {
    if (ctx.__hsNoise) return ctx.__hsNoise;
    const n = Math.floor(ctx.sampleRate * 0.3), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    ctx.__hsNoise = b; return b;
  }
  function blip(ctx, type, f0, f1, dur, peak) {
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur * 0.7);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function noiseHit(ctx, hp, dur, peak) {
    const t = ctx.currentTime, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuf(ctx); f.type = 'highpass'; f.frequency.value = hp;
    g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(ctx.destination); src.start(t); src.stop(t + dur + 0.02);
  }
  function playAdditions(ctx, bits, scale) {
    const v = vol() * (scale == null ? 1 : scale); if (!ctx || !(v > 0)) return;
    const g = Math.min(1, v / 100);
    blip(ctx, 'triangle', 360, 200, 0.06, g * 0.40);          // normal (always)
    if (bits & 2) blip(ctx, 'sine', 1500, 1400, 0.08, g * 0.30);   // whistle
    if (bits & 4) noiseHit(ctx, 3500, 0.20, g * 0.35);             // finish (cymbal)
    if (bits & 8) noiseHit(ctx, 900, 0.05, g * 0.50);             // clap
  }

  function preview() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!previewCtx) previewCtx = new Ctx();
    if (previewCtx.state !== 'running') { previewCtx.resume().then(() => play(previewCtx)); return; }
    play(previewCtx);
  }

  async function setCustomFromFile(file) {
    const ab = await file.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!previewCtx) previewCtx = new Ctx();
    await previewCtx.decodeAudioData(ab.slice(0));   // validate it's real audio (throws otherwise)
    customBytes = new Uint8Array(ab); customName = file.name; customVer++;
    await idbPut('current', { bytes: customBytes, name: customName });
    settings().hitsoundKind = 'custom'; deps.saveSettings();
  }
  async function clearCustom() {
    customBytes = null; customName = ''; customVer++;
    try { await idbDel('current'); } catch (e) {}
    if (settings().hitsoundKind === 'custom') { settings().hitsoundKind = DEFAULT_KIND; deps.saveSettings(); }
  }

  // ---- Customization UI (rendered into a host element by each panel) --------
  function renderControls(el) {
    if (!el) return;
    const k = kind();
    const presetBtns = Object.keys(PRESETS).map((key) =>
      '<button type="button" class="hs-preset' + (k === key ? ' sel' : '') + '" data-hk="' + key + '">' + PRESETS[key].label + '</button>').join('');
    el.innerHTML =
      '<div class="hs-row"><span>Sound</span><span class="hs-pick">' + presetBtns +
        '<button type="button" class="hs-preset' + (k === 'custom' ? ' sel' : '') + '" data-hk="custom">' +
          (customName ? 'Custom: ' + escapeName(customName) : 'Custom…') + '</button>' +
      '</span></div>' +
      '<div class="hs-row"><span>Volume</span><input type="range" id="hs-vol" min="0" max="100" step="5" value="' + vol() + '"><b id="hs-vol-val">' + vol() + '</b></div>' +
      '<div class="hs-row"><span>Custom file</span>' +
        '<button type="button" id="hs-upload">Upload .wav / .mp3 / .ogg…</button>' +
        (customName ? '<button type="button" id="hs-clear">✕ remove</button>' : '') +
      '</div>' +
      '<div class="hs-row"><span>Map hitsounds</span>' +
        '<button type="button" id="hs-usemap" class="hs-preset' + (settings().hitsoundUseMap ? ' sel' : '') + '">' +
          (settings().hitsoundUseMap ? 'On — use the map’s sounds' : 'Off — use the sound above') + '</button>' +
      '</div>' +
      '<input type="file" id="hs-file" accept="audio/*" hidden>' +
      '<button type="button" id="hs-test" class="hs-test">▶ Test</button>';

    const useMapBtn = el.querySelector('#hs-usemap');
    if (useMapBtn) useMapBtn.addEventListener('click', () => { settings().hitsoundUseMap = !settings().hitsoundUseMap; deps.saveSettings(); renderControls(el); });
    el.querySelectorAll('[data-hk]').forEach((b) => b.addEventListener('click', () => {
      const hk = b.getAttribute('data-hk');
      if (hk === 'custom' && !customBytes) { el.querySelector('#hs-file').click(); return; }   // pick a file first
      settings().hitsoundKind = hk; deps.saveSettings(); renderControls(el); preview();
    }));
    const vbar = el.querySelector('#hs-vol');
    vbar.addEventListener('input', (e) => { settings().hitsoundVol = Number(e.target.value); el.querySelector('#hs-vol-val').textContent = e.target.value; deps.saveSettings(); });
    vbar.addEventListener('change', () => preview());
    el.querySelector('#hs-upload').addEventListener('click', () => el.querySelector('#hs-file').click());
    el.querySelector('#hs-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { await setCustomFromFile(f); renderControls(el); preview(); }
      catch (err) { window.alert('Could not load that audio file: ' + ((err && err.message) || err)); }
    });
    const clr = el.querySelector('#hs-clear');
    if (clr) clr.addEventListener('click', async () => { await clearCustom(); renderControls(el); });
    el.querySelector('#hs-test').addEventListener('click', () => preview());
  }

  window.Hitsound = { init: init, play: play, tick: tick, playAdditions: playAdditions, preview: preview, renderControls: renderControls };
  if (window.__hitsoundDeps) init(window.__hitsoundDeps);   // self-init (loaded after app.js sets deps)
})();
