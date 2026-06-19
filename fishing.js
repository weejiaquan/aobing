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
    s.pos += (rng() - 0.5) * p.step * dt; // step = per-second amplitude
    return (s.pos = clamp01(s.pos));
  },
};

// --- Behavior composition (data: primitive + zone + modifiers) ---
const ZONES = { top: [0.55, 0.95], bottom: [0.05, 0.45], mid: [0.2, 0.8], wide: [0.0, 1.0] };

const BEHAVIORS = {
  drifter:        { primitive: 'drift', params: { retarget: 2.5, ease: 2.5 } },
  lazyDrifter:    { primitive: 'drift', params: { retarget: 3.5, ease: 1.5 } },
  topDrifter:     { primitive: 'drift', zone: 'top', params: { retarget: 2.5, ease: 2.5 } },
  bottomDrifter:  { primitive: 'drift', zone: 'bottom', params: { retarget: 2.5, ease: 2.5 } },
  feintingDrifter:{ primitive: 'drift', params: { retarget: 2.5, ease: 2.5 }, mods: { feint: 0.25 } },
  bouncer:        { primitive: 'oscillate', params: { omega: 1.6 } },
  wideBouncer:    { primitive: 'oscillate', zone: 'wide', params: { omega: 1.3 } },
  rampingBouncer: { primitive: 'oscillate', params: { omega: 1.4 }, mods: { speedRamp: 0.8 } },
  pausingBouncer: { primitive: 'oscillate', params: { omega: 1.6 }, mods: { pause: { period: 1.8, hold: 0.5 } } },
  darter:         { primitive: 'dart', zone: 'wide', params: { retarget: 0.8, ease: 7 } },
  sprinter:       { primitive: 'dart', zone: 'wide', params: { retarget: 0.8, ease: 7 }, mods: { speedRamp: 1.0 } },
  ambush:         { primitive: 'dart', zone: 'wide', params: { retarget: 0.8, ease: 9 }, mods: { pause: { period: 1.5, hold: 0.7 } } },
  twitch:         { primitive: 'dart', zone: 'wide', params: { retarget: 0.7, ease: 7 }, mods: { jitter: 0.04 } },
  floater:        { primitive: 'hold', zone: 'top', params: { stiffness: 2.2 } },
  sinker:         { primitive: 'hold', zone: 'bottom', params: { stiffness: 2.2 } },
  anchor:         { primitive: 'hold', zone: 'bottom', params: { stiffness: 3.4 } },
  surfacer:       { primitive: 'hold', zone: 'top', params: { stiffness: 2.2 }, mods: { jitter: 0.05 } },
  patroller:      { primitive: 'sweep', zone: 'wide', params: { speed: 0.35 } },
  pendulum:       { primitive: 'sweep', zone: 'mid', params: { speed: 0.30 } },
  pulsar:         { primitive: 'pulse', params: { interval: 1.4, hopEase: 8 } },
  geyser:         { primitive: 'pulse', zone: 'top', params: { interval: 1.2, hopEase: 8 } },
  hopper:         { primitive: 'pulse', params: { interval: 1.3, hopEase: 8 }, mods: { jitter: 0.03 } },
  meanderer:      { primitive: 'walk', params: { step: 0.5 } },
  nervous:        { primitive: 'walk', params: { step: 0.7 }, mods: { jitter: 0.03 } },
  trickster:      { primitive: 'drift', params: { retarget: 2.5, ease: 2.5 }, mods: { phase: { alt: 'dart', period: 2.5, altParams: { retarget: 0.8, ease: 7 } } } },
  tempest:        { primitive: 'oscillate', params: { omega: 1.6 }, mods: { phase: { alt: 'dart', period: 2.0, altParams: { retarget: 0.8, ease: 7 } }, crescendo: 0.8 } },
  mirage:         { primitive: 'drift', params: { retarget: 2.5, ease: 2.5 }, mods: { mirror: 2.5 } },
  tyrant:         { primitive: 'dart', zone: 'wide', params: { retarget: 0.8, ease: 8 }, mods: { phase: { alt: 'hold', period: 2.0, altParams: { stiffness: 3.0 } }, crescendo: 1.0 } },
  glider:         { primitive: 'sweep', zone: 'wide', params: { speed: 0.5 }, mods: { speedRamp: 0.6 } },
  flutter:        { primitive: 'oscillate', params: { omega: 2.4 }, mods: { jitter: 0.03 } },
  ghost:          { primitive: 'drift', zone: 'wide', params: { retarget: 1.8, ease: 2.0 }, mods: { mirror: 3.0 } },
};

function resolveBehavior(fish) {
  const def = BEHAVIORS[fish.behavior] || BEHAVIORS.drifter;
  const zone = ZONES[def.zone || 'mid'];
  const speedMul = RARITY_TIERS[fish.rarity].fishSpeed / RARITY_TIERS[1].fishSpeed; // 1.0 .. ~3.1
  return {
    primitive: def.primitive,
    params: Object.assign({ lo: zone[0], hi: zone[1] }, def.params),
    mods: def.mods || {},
    speedMul,
  };
}

function createBehaviorState(fish) {
  const def = resolveBehavior(fish);
  return { def, pos: 0.5, target: null, since: 0, t: 0, dir: 1, elapsed: 0 };
}

// Scale the time-derivative params that drive motion speed.
function scaledParams(p, factor) {
  const out = Object.assign({}, p);
  if (out.ease != null) out.ease *= factor;
  if (out.omega != null) out.omega *= factor;
  if (out.speed != null) out.speed *= factor;
  if (out.stiffness != null) out.stiffness *= factor;
  if (out.hopEase != null) out.hopEase *= factor;
  if (out.step != null) out.step *= factor;
  if (out.retarget != null) out.retarget /= factor; // faster retarget when quicker
  return out;
}

function stepFish(s, dt, rng, progress = 0) {
  const def = s.def;
  const mods = def.mods;
  s.elapsed += dt;

  // pause: freeze inside the hold window of each period.
  if (mods.pause) {
    const phase = s.elapsed % mods.pause.period;
    if (phase < mods.pause.hold) { s.t += dt; return s.pos; }
  }

  // speed scaling from rarity + speedRamp + crescendo.
  let factor = def.speedMul;
  if (mods.speedRamp) factor *= 1 + mods.speedRamp * Math.min(1, s.elapsed / 12);
  if (mods.crescendo) factor *= 1 + mods.crescendo * progress;

  // phase: swap to the alternate primitive on a timer.
  let primName = def.primitive;
  let params = def.params;
  if (mods.phase && Math.floor(s.elapsed / mods.phase.period) % 2 === 1) {
    primName = mods.phase.alt;
    params = Object.assign({ lo: def.params.lo, hi: def.params.hi }, mods.phase.altParams);
  }

  // mirror: on alternating periods, seek the vertically-reflected band so motion
  // stays continuous (no teleport). Reflect the band, not the output.
  if (mods.mirror) {
    const mirrored = Math.floor(s.elapsed / mods.mirror) % 2 === 1;
    if (mirrored) {
      params = Object.assign({}, params, { lo: 1 - params.hi, hi: 1 - params.lo });
    }
  }

  let pos = PRIMITIVES[primName](s, dt, rng, scaledParams(params, factor));

  // feint: occasionally reflect the just-applied delta to fake a reversal.
  if (mods.feint && rng() < mods.feint * dt) { pos = clamp01(s.pos - (s.target != null ? (s.target - s.pos) : 0) * 0.5); s.pos = pos; }

  // jitter: additive noise.
  if (mods.jitter) { pos = clamp01(pos + (rng() - 0.5) * mods.jitter); s.pos = pos; }

  s.t += dt;
  return pos;
}

// --- Bar-balance physics ---
const GRAVITY = 1.8;  // track units / s^2 pulling the bar down
const THRUST = 3.2;   // upward accel while holding

function createBarState(fish) {
  const tier = RARITY_TIERS[fish.rarity];
  return {
    fish,
    tier,
    bar: { pos: (1 - tier.barSize) / 2, vel: 0 },
    fish_: createBehaviorState(fish),
    progress: 0.35, // a small head start so a perfect catch is achievable
  };
}

function stepBar(state, dt, holding, rng) {
  const { tier, bar } = state;

  // fish motion (before bar physics, so overlap check uses pre-physics bar position)
  const fishPos = stepFish(state.fish_, dt, rng, state.progress);

  // overlap test: fish center within the bar span (using current bar position)
  const inside = fishPos >= bar.pos && fishPos <= bar.pos + tier.barSize;
  state.progress += (inside ? tier.fillRate : -tier.drainRate) * dt;
  if (state.progress > 1) state.progress = 1;
  if (state.progress < 0) state.progress = 0;

  // bar physics (after overlap check)
  bar.vel += (holding ? THRUST : 0) * dt;
  bar.vel -= GRAVITY * dt;
  bar.vel *= 0.92; // damping for control
  bar.pos += bar.vel * dt;
  const maxPos = 1 - tier.barSize;
  if (bar.pos < 0) { bar.pos = 0; bar.vel = 0; }
  if (bar.pos > maxPos) { bar.pos = maxPos; bar.vel = 0; }

  return state;
}

function isCaught(state) { return state.progress >= 1; }
function isEscaped(state) { return state.progress <= 0; }

const API = { mulberry32, RARITY_TIERS, clamp01, rollEncounter, rollCastWait, CAST_WAIT_MIN, CAST_WAIT_MAX, HOOK_WINDOW_SECONDS, rollSize, rollFloat, floatToGrade, rollShiny, createSpecimen, SHINY_RATE, computeCoins, PRIMITIVES, sampleTarget, ZONES, BEHAVIORS, resolveBehavior, createBehaviorState, stepFish, createBarState, stepBar, isCaught, isEscaped, GRAVITY, THRUST };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.FishingEngine = API;
