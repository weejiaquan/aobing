'use strict';
/*
 * divadsc.js — decode a Project Diva FT / Mega Mix+ binary `.dsc` chart into the
 * Phase-1 note model (the one `DivaEngine.assembleChart` consumes).
 *
 * The opcode table, field size, time divisor and angle scale below were confirmed
 * EMPIRICALLY in Phase-2 Task 0 against the user's real charts (EdenBeginnerPack):
 * all four fixtures walked the int-stream cleanly to END with byte-exact length.
 * Reference for the table + TARGET decode: Hydr8gon/Project-DS `src/game.cpp`
 * (`paramCounts`, the 0x06 TARGET handler, the 0x1C/0x3A flying-time handlers).
 *
 * Format: u32 LE signature 0x14050921, then a stream of int32 LE opcodes; each
 * opcode id is followed by `PARAM_COUNTS[id]` int32 args. TIME sets the clock,
 * TARGET emits a note, 0x1C/0x3A set the fly-in time, END (0) stops.
 *   - clock units: ~100000 / second  → ms = units / 100
 *   - field:       480000 (w) × 270000 (h)  → x = argx/480000, y = argy/270000
 *   - angle:       arg / 1000 degrees
 *   - hit time:    timer + flyTime (the note spawns at `timer`, flies `flyTime`)
 */
(function () {
  // PARAM_COUNTS[opcode] = number of int32 args. 0x00-0x6A explicit (Project-DS);
  // 0x6B-0xFF are 0. An opcode outside this range stops the walk gracefully.
  const PARAM_COUNTS = [
    0, 1, 4, 2, 2, 2, 7, 4, 2, 6, 2, 1, 6, 2, 1, 1, // 0x00
    3, 2, 3, 5, 5, 4, 4, 5, 2, 0, 2, 4, 2, 2, 1, 21, // 0x10
    0, 3, 2, 5, 1, 1, 7, 1, 1, 2, 1, 2, 1, 2, 3, 3, // 0x20
    1, 2, 2, 3, 6, 6, 1, 1, 2, 3, 1, 2, 2, 4, 4, 1, // 0x30
    2, 1, 2, 1, 1, 3, 3, 3, 2, 1, 9, 3, 2, 4, 2, 3, // 0x40
    2, 24, 1, 2, 1, 3, 1, 3, 4, 1, 2, 6, 3, 2, 3, 3, // 0x50
    4, 1, 1, 3, 3, 4, 2, 3, 3, 8, 2,                 // 0x60-0x6A
  ];
  const OP = { END: 0x00, TIME: 0x01, TARGET: 0x06, BAR_TIME: 0x1C, FLY_TIME: 0x3A };
  const FACE = ['triangle', 'circle', 'cross', 'square'];
  const FIELD_W = 480000, FIELD_H = 270000, UNITS_PER_MS = 100;
  const SIGNATURE = 0x14050921;

  // Map a TARGET `type` field to a note button. Returns null for types we skip
  // (PV-event/effect targets that carry no playable note).
  //   0-3  face buttons (triangle/circle/cross/square)
  //   4-7  "held" buttons — judged as a face-button tap (Diva's hold-bonus is a
  //        separate scoring subsystem with no fixed end-time in the chart)
  //   12/13 single slides (L/R)        15/16 held-slide chain links (L/R)
  //   18-21 PV-event notes → face buttons
  function mapType(t) {
    if (t < 4) return { button: FACE[t] };
    if (t < 8) return { button: FACE[t & 3] };
    if (t === 12) return { button: 'slideL' };
    if (t === 13) return { button: 'slideR' };
    if (t === 15) return { button: 'slideL', chain: true };
    if (t === 16) return { button: 'slideR', chain: true };
    if (t >= 18 && t < 22) return { button: FACE[t - 18] };
    return null;
  }

  // Build a note from TARGET args `a` = [type, x, y, angle, distance, amplitude, frequency].
  // `angle` is rotated by -90° so the engine's entry direction (cos/sin) matches the
  // game's (sin/-cos) fly-in. distance/amplitude are normalised against the field height.
  function mapTarget(a, button, timer, flyTime) {
    return {
      button: button,
      time: Math.round((timer + flyTime) / UNITS_PER_MS),
      flyTime: Math.round(flyTime / UNITS_PER_MS),
      x: a[1] / FIELD_W,
      y: a[2] / FIELD_H,
      angle: (a[3] / 1000) - 90,
      distance: a[4] / FIELD_H,
      amplitude: a[5] / FIELD_H,
      frequency: a[6] || 0,
      holdEnd: null, groupId: null, slideChain: null,
    };
  }

  // Decode a `.dsc` ArrayBuffer → { notes, chanceTimes }. Notes are time-sorted and
  // carry the Phase-1 fields; pass the result through DivaEngine.assembleChart, which
  // validates buttons, groups same-time doubles and estimates stars.
  function decode(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (dv.byteLength < 4 || dv.getUint32(0, true) !== SIGNATURE) {
      throw new Error('not an FT/MM+ .dsc (bad signature)');
    }
    let off = 4, timer = 0, flyTime = 100000;        // flyTime default 1000ms (in units)
    const notes = [];
    let chainId = 0, chainActive = null;             // current slide-chain run (button or null)
    let ended = false;                               // true only when a real END opcode is reached
    while (off + 4 <= dv.byteLength) {
      const op = dv.getInt32(off, true); off += 4;
      if (op < 0 || op >= PARAM_COUNTS.length) break; // unknown opcode → stop this chart cleanly
      if (op === OP.END) { ended = true; break; }
      const argc = PARAM_COUNTS[op];
      if (off + argc * 4 > dv.byteLength) break;       // truncated tail → stop
      const a = []; for (let k = 0; k < argc; k++) { a.push(dv.getInt32(off, true)); off += 4; }
      if (op === OP.TIME) timer = a[0];
      else if (op === OP.FLY_TIME) flyTime = a[0] * 100;
      else if (op === OP.BAR_TIME) flyTime = (60 / a[0]) * (a[1] + 1) * 100000;
      else if (op === OP.TARGET) {
        const m = mapType(a[0] & 0xFF);
        if (!m) { chainActive = null; continue; }
        const note = mapTarget(a, m.button, timer, flyTime);
        if (m.chain) {
          if (chainActive !== m.button) { chainId++; chainActive = m.button; } // new run when direction changes
          note.slideChain = chainId;
        } else {
          chainActive = null;
        }
        notes.push(note);
      }
    }
    notes.sort((x, y) => x.time - y.time);
    return { notes: notes, chanceTimes: [], ended: ended };
  }

  const API = { decode: decode, _mapType: mapType, _mapTarget: mapTarget, PARAM_COUNTS: PARAM_COUNTS, SIGNATURE: SIGNATURE };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.DivaDsc = API;
})();
