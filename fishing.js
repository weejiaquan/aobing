'use strict';
// Pure fishing engine. No DOM, no audio, no Firebase, no Math.random/Date.
// Randomness is injected as rng() -> [0,1); time is injected as dt (seconds).

// --- Seeded RNG (tests inject this; production passes Math.random) ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Rarity → difficulty tiers (positions/fractions of the track per second) ---
const RARITY_TIERS = {
  1: { fishSpeed: 0.30, barSize: 0.28, fillRate: 0.55, drainRate: 0.30, weight: 100, discoveryBonus: 25 },
  2: { fishSpeed: 0.42, barSize: 0.24, fillRate: 0.50, drainRate: 0.38, weight: 38, discoveryBonus: 80 },
  3: { fishSpeed: 0.56, barSize: 0.20, fillRate: 0.45, drainRate: 0.46, weight: 12, discoveryBonus: 220 },
  4: { fishSpeed: 0.74, barSize: 0.16, fillRate: 0.42, drainRate: 0.55, weight: 3, discoveryBonus: 650 },
  5: { fishSpeed: 0.94, barSize: 0.13, fillRate: 0.40, drainRate: 0.66, weight: 0.6, discoveryBonus: 2500 },
};

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// --- Encounter + timing ---
const CAST_WAIT_MIN = 1.5;
const CAST_WAIT_MAX = 5.0;
const HOOK_WINDOW_SECONDS = 1.0;

function rollEncounter(table, rng) {
  let total = 0;
  for (const f of table) total += RARITY_TIERS[f.rarity].weight;
  let r = rng() * total;
  for (const f of table) {
    r -= RARITY_TIERS[f.rarity].weight;
    if (r < 0) return f;
  }
  return table[table.length - 1]; // float-rounding fallback
}

function rollCastWait(rng) {
  return CAST_WAIT_MIN + rng() * (CAST_WAIT_MAX - CAST_WAIT_MIN);
}

// --- Specimen rolls ---
const SHINY_RATE = 1 / 256;
const GRADE_BANDS = [
  [0.07, 'Prime'],
  [0.15, 'Vivid'],
  [0.38, 'Healthy'],
  [0.45, 'Faded'],
  [Infinity, 'Scarred'],
];

function rollSize(fish, rng) {
  const [lo, hi] = fish.sizeRange;
  return lo + rng() * (hi - lo);
}

function rollFloat(fish, rng) {
  const [lo, hi] = fish.floatRange || [0, 1];
  const base = (rng() + rng()) / 2; // triangular, peak at 0.5 → mid-condition skew
  return clamp01(lo + base * (hi - lo));
}

function floatToGrade(f) {
  for (const [hi, name] of GRADE_BANDS) if (f < hi) return name;
  return 'Scarred';
}

function rollShiny(rng, rate = SHINY_RATE) {
  return rng() < rate;
}

function createSpecimen(fish, rng) {
  const size = rollSize(fish, rng);
  const float = rollFloat(fish, rng);
  const shiny = rollShiny(rng);
  return { species: fish.id, size, float, grade: floatToGrade(float), shiny };
}

// --- Coin payout ---
function computeCoins(fish, size, float, shiny, isNew) {
  const [lo, hi] = fish.sizeRange;
  const norm = hi > lo ? (size - lo) / (hi - lo) : 0.5;
  const sizeFactor = 0.75 + 0.5 * norm;        // 0.75 .. 1.25
  const qualityMul = 1 + 1.5 * (1 - float);     // 1.0 .. 2.5 (lower float = better)
  const shinyMul = shiny ? 5 : 1;
  const base = Math.round(fish.coinBase * sizeFactor * qualityMul * shinyMul);
  return base + (isNew ? RARITY_TIERS[fish.rarity].discoveryBonus : 0);
}

// --- Motion primitives (each returns pos in [0,1] and mutates state) ---
function sampleTarget(rng, p) {
  const lo = p.lo != null ? p.lo : 0;
  const hi = p.hi != null ? p.hi : 1;
  return lo + rng() * (hi - lo);
}

function seek(s, dt, rng, p) {
  s.since += dt;
  if (s.target == null || s.since >= p.retarget) { s.target = sampleTarget(rng, p); s.since = 0; }
  s.pos += (s.target - s.pos) * Math.min(1, p.ease * dt);
  return (s.pos = clamp01(s.pos));
}

const PRIMITIVES = {
  drift: seek,
  dart: seek,
  oscillate(s, dt, rng, p) {
    s.t += dt;
    const mid = ((p.lo != null ? p.lo : 0) + (p.hi != null ? p.hi : 1)) / 2;
    const amp = ((p.hi != null ? p.hi : 1) - (p.lo != null ? p.lo : 0)) / 2;
    return (s.pos = clamp01(mid + amp * Math.sin(s.t * p.omega)));
  },
  hold(s, dt, rng, p) {
    const center = ((p.lo != null ? p.lo : 0) + (p.hi != null ? p.hi : 1)) / 2;
    s.pos += (center - s.pos) * Math.min(1, p.stiffness * dt);
    return (s.pos = clamp01(s.pos));
  },
  sweep(s, dt, rng, p) {
    if (s.dir == null) s.dir = 1;
    s.pos += s.dir * p.speed * dt;
    if (s.pos >= p.hi) { s.pos = p.hi; s.dir = -1; }
    if (s.pos <= p.lo) { s.pos = p.lo; s.dir = 1; }
    return (s.pos = clamp01(s.pos));
  },
  pulse(s, dt, rng, p) {
    s.since += dt;
    if (s.target == null || s.since >= p.interval) { s.target = sampleTarget(rng, p); s.since = 0; }
    s.pos += (s.target - s.pos) * Math.min(1, p.hopEase * dt);
    return (s.pos = clamp01(s.pos));
  },
  walk(s, dt, rng, p) {
    s.pos += (rng() - 0.5) * p.step * dt * 60 / 60; // step is per-second amplitude
    return (s.pos = clamp01(s.pos));
  },
};

const API = { mulberry32, RARITY_TIERS, clamp01, rollEncounter, rollCastWait, CAST_WAIT_MIN, CAST_WAIT_MAX, HOOK_WINDOW_SECONDS, rollSize, rollFloat, floatToGrade, rollShiny, createSpecimen, SHINY_RATE, computeCoins, PRIMITIVES, sampleTarget };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.FishingEngine = API;
