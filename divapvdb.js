'use strict';
/*
 * divapvdb.js — parse a Project Diva `pv_db.txt` / `mod_pv_db.txt` into a song list.
 *
 * The DB is flat `key=value` text; every line is `pv_<id>.<dotted.path>=<value>`.
 * We only read the handful of fields needed to build + locate a playable chart:
 *   song_name / song_name_en        → title
 *   song_file_name                  → audio path (relative to the mod root)
 *   bpm                             → tempo
 *   songinfo.music / songinfo_en.music → artist
 *   difficulty.<diff>.0.script_file_name → the .dsc path for that difficulty
 *   difficulty.<diff>.0.level       → e.g. PV_LV_07_5 → 7.5 stars
 */
(function () {
  const DIFF_ORDER = { easy: 0, normal: 1, hard: 2, extreme: 3, encore: 4, extra: 5 };

  // "PV_LV_07_5" → 7.5 ; "PV_LV_03_0" → 3.0 ; unknown → null
  function levelToStars(level) {
    const m = /PV_LV_(\d+)_(\d+)/.exec(level || '');
    if (!m) return null;
    return parseInt(m[1], 10) + parseInt(m[2], 10) / 10;
  }

  // parse(text) → [{ id, title, titleJp, artist, bpm, audio, diffs:{<diff>:{script,level,stars}} }]
  // Sorted by pv id. Songs with no difficulty/script and no audio are dropped by the caller.
  function parse(text) {
    const byId = {};
    const lines = String(text).split(/\r?\n/);
    for (const line of lines) {
      if (!line || line[0] === '#') continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      const head = /^(pv_\d+)\.(.+)$/.exec(key);
      if (!head) continue;
      const id = head[1], rest = head[2];
      const song = byId[id] || (byId[id] = { id: id, title: '', titleJp: '', artist: '', bpm: 0, audio: '', diffs: {} });

      if (rest === 'song_name') song.titleJp = val;
      else if (rest === 'song_name_en') song.title = val;
      else if (rest === 'song_file_name') song.audio = val;
      else if (rest === 'bpm') song.bpm = parseInt(val, 10) || 0;
      else if ((rest === 'songinfo.music' || rest === 'songinfo_en.music') && !song.artist) song.artist = val;
      else {
        const dm = /^difficulty\.([a-z_]+)\.0\.(script_file_name|level)$/.exec(rest);
        if (dm) {
          const diff = dm[1];
          const d = song.diffs[diff] || (song.diffs[diff] = { script: '', level: '', stars: null });
          if (dm[2] === 'script_file_name') d.script = val;
          else { d.level = val; d.stars = levelToStars(val); }
        }
      }
    }
    const songs = Object.keys(byId).map((id) => {
      const s = byId[id];
      if (!s.title) s.title = s.titleJp || s.id;     // fall back JP → id when no English name
      return s;
    });
    songs.sort((a, b) => a.id.localeCompare(b.id));
    return songs;
  }

  // Ordered list of difficulties a song actually has a script for (easy→extreme→…).
  function playableDiffs(song) {
    return Object.keys(song.diffs)
      .filter((d) => song.diffs[d].script)
      .sort((a, b) => (DIFF_ORDER[a] == null ? 99 : DIFF_ORDER[a]) - (DIFF_ORDER[b] == null ? 99 : DIFF_ORDER[b]));
  }

  const API = { parse: parse, playableDiffs: playableDiffs, _levelToStars: levelToStars, DIFF_ORDER: DIFF_ORDER };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.DivaPvdb = API;
})();
