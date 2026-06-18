'use strict';
/*
 * phsong.js — parse a Project Heartbeat song into the Diva note model.
 *
 * PH is a Future-Tone clone, so its notes map straight onto our engine. A PH song is a
 * folder with `song.json` (manifest) + one chart JSON per difficulty (e.g. `hard.json`).
 * Charts are `{ layers: [{ timing_points: [ {time, position, note_type, entry_angle,
 * oscillation_frequency, type:"Note"}, … ] }] }`. Field is 1920×1080; flyTime is 4 beats
 * at the song BPM (PH get_time_out). Audio is either a local file (`audio` field) or a
 * YouTube id (`youtube_url`) whose audio PH caches at youtube_dl/cache/<id>.ogg.
 *
 * Note-type enum (PH HBBaseNote.NOTE_TYPE): 0 UP, 1 LEFT, 2 DOWN, 3 RIGHT, 4 SLIDE_LEFT,
 * 5 SLIDE_RIGHT, 6/7 SLIDE_CHAIN_PIECE_L/R, 8 HEART. Diva button mapping mirrors the
 * Project Diva layout (UP=△, RIGHT=○, DOWN=✕, LEFT=□).
 */
(function () {
  const NOTE_BUTTON = { 0: 'triangle', 1: 'square', 2: 'cross', 3: 'circle', 4: 'slideL', 5: 'slideR', 6: 'slideL', 7: 'slideR', 8: 'circle' };
  const SLIDE_DIR = { 4: 'L', 5: 'R', 6: 'L', 7: 'R' };   // slides + chain pieces, by direction
  const FIELD_W = 1920, FIELD_H = 1080;

  // Pull the 11-char video id out of any YouTube URL form.
  function youtubeId(url) {
    const m = /(?:youtu\.be\/|[?&]v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/.exec(String(url || ''));
    return m ? m[1] : '';
  }

  // PH stores position as the string "Vector2( x, y )" (or sometimes an object).
  function parsePosition(p) {
    if (p && typeof p === 'object') return { x: Number(p.x) || 0, y: Number(p.y) || 0 };
    const m = /Vector2\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(String(p || ''));
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: FIELD_W / 2, y: FIELD_H / 2 };
  }

  // parseSong(json) → { title, artist, bpm, audio, youtubeUrl, youtubeId, charts:{diff:{file,stars}} }
  function parseSong(json) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    const charts = {};
    for (const d in (s.charts || {})) if (s.charts[d] && s.charts[d].file) charts[d] = { file: s.charts[d].file, stars: s.charts[d].stars || null };
    return {
      title: s.title ? String(s.title).trim() : '', artist: s.artist ? String(s.artist).trim() : '', bpm: Number(s.bpm) || 0,
      audio: s.audio || '', youtubeUrl: s.youtube_url || '', youtubeId: youtubeId(s.youtube_url), charts: charts,
    };
  }

  // parseChart(json, bpm) → { notes, chanceTimes:[] } in the Diva note model (pass through
  // DivaEngine.assembleChart, which groups same-time doubles and estimates/keeps stars).
  function parseChart(json, bpm) {
    const c = typeof json === 'string' ? JSON.parse(json) : json;
    const flyTime = bpm > 0 ? Math.round(60000 / bpm * 4) : 1400;   // PH get_time_out: 4 beats
    const raw = [];
    for (const layer of (c.layers || [])) for (const tp of (layer.timing_points || [])) if (tp.type === 'Note') raw.push(tp);
    raw.sort((a, b) => a.time - b.time);
    const notes = [];
    let chainId = 0, chainActive = null;
    for (const tp of raw) {
      const button = NOTE_BUTTON[tp.note_type];
      if (!button) continue;
      const pos = parsePosition(tp.position);
      const note = {
        button: button, time: Math.round(tp.time), flyTime: flyTime,
        x: pos.x / FIELD_W, y: pos.y / FIELD_H,
        angle: (Number(tp.entry_angle) || 0) - 90,   // reconcile to the engine's trailPoint entry dir
        distance: (Number(tp.distance) || 1200) / FIELD_H,
        amplitude: (tp.oscillation_amplitude != null ? Number(tp.oscillation_amplitude) : 500) / FIELD_W,
        frequency: Number(tp.oscillation_frequency) || 0,
        holdEnd: null, groupId: null, slideChain: null,
      };
      const dir = SLIDE_DIR[tp.note_type];
      if (dir) { if (chainActive !== dir) { chainId++; chainActive = dir; } note.slideChain = chainId; }
      else chainActive = null;
      notes.push(note);
    }
    return { notes: notes, chanceTimes: [] };
  }

  const API = { parseSong: parseSong, parseChart: parseChart, youtubeId: youtubeId, _parsePosition: parsePosition, NOTE_BUTTON: NOTE_BUTTON };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.PhSong = API;
})();
