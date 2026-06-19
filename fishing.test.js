'use strict';
// Unit tests for the PURE fishing engine exported by fishing.js.
// Run: `node --test fishing.test.js`
// No DOM, no audio, no mocks — the engine is framework-agnostic by design.
// Tests are intentionally verbose so failures double as debugging output.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ENGINE = require('./fishing.js');
const { mulberry32, RARITY_TIERS } = ENGINE;

test('mulberry32 is deterministic for a fixed seed', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB, 'same seed must yield identical sequence');
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, `rng value ${v} must be in [0,1)`);
  }
});

test('mulberry32 differs across seeds', () => {
  const a = mulberry32(1)();
  const b = mulberry32(2)();
  assert.notEqual(a, b, 'different seeds should not collide on first draw');
});

test('RARITY_TIERS has 5 tiers with required numeric fields', () => {
  for (let r = 1; r <= 5; r++) {
    const t = RARITY_TIERS[r];
    assert.ok(t, `tier ${r} must exist`);
    for (const k of ['fishSpeed', 'barSize', 'fillRate', 'drainRate', 'weight', 'discoveryBonus']) {
      assert.equal(typeof t[k], 'number', `tier ${r}.${k} must be a number`);
    }
  }
  assert.ok(RARITY_TIERS[1].weight > RARITY_TIERS[5].weight, 'commons must be weighted heavier than legendaries');
  assert.ok(RARITY_TIERS[5].barSize < RARITY_TIERS[1].barSize, 'legendary bar must be smaller');
});

const { rollEncounter, rollCastWait, CAST_WAIT_MIN, CAST_WAIT_MAX, HOOK_WINDOW_SECONDS } = ENGINE;

// Minimal fixture table; real roster arrives in fish-data.js (Task 8).
const TABLE = [
  { id: 'common-a', name: 'Common A', rarity: 1, behavior: 'drifter', family: 'test', sizeRange: [10, 20], coinBase: 10 },
  { id: 'common-b', name: 'Common B', rarity: 1, behavior: 'drifter', family: 'test', sizeRange: [10, 20], coinBase: 10 },
  { id: 'rare-a', name: 'Rare A', rarity: 3, behavior: 'darter', family: 'test', sizeRange: [30, 60], coinBase: 90 },
  { id: 'legend-a', name: 'Legend A', rarity: 5, behavior: 'tempest', family: 'test', sizeRange: [300, 800], coinBase: 1200 },
];

test('rollEncounter only ever returns fish from the table', () => {
  const rng = mulberry32(7);
  const ids = new Set(TABLE.map(f => f.id));
  for (let i = 0; i < 2000; i++) {
    const f = rollEncounter(TABLE, rng);
    assert.ok(ids.has(f.id), `returned ${f.id} which is not in the table`);
  }
});

test('rollEncounter weights commons far above legendaries', () => {
  const rng = mulberry32(99);
  const counts = {};
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const f = rollEncounter(TABLE, rng);
    counts[f.id] = (counts[f.id] || 0) + 1;
  }
  const commons = (counts['common-a'] || 0) + (counts['common-b'] || 0);
  const legends = counts['legend-a'] || 0;
  assert.ok(commons / N > 0.7, `commons share ${(commons / N).toFixed(3)} should exceed 0.7`);
  assert.ok(legends / N < 0.02, `legendary share ${(legends / N).toFixed(3)} should be under 0.02`);
});

test('rollCastWait stays within the configured bounds', () => {
  const rng = mulberry32(3);
  for (let i = 0; i < 1000; i++) {
    const w = rollCastWait(rng);
    assert.ok(w >= CAST_WAIT_MIN && w <= CAST_WAIT_MAX, `cast wait ${w} out of [${CAST_WAIT_MIN}, ${CAST_WAIT_MAX}]`);
  }
});

test('HOOK_WINDOW_SECONDS is a positive constant', () => {
  assert.ok(HOOK_WINDOW_SECONDS > 0, 'hook window must be positive');
});

const { rollSize, rollFloat, floatToGrade, rollShiny, createSpecimen, SHINY_RATE } = ENGINE;

const FISH = { id: 'trout', name: 'Trout', rarity: 2, behavior: 'drifter', family: 'trout', sizeRange: [18, 42], coinBase: 32 };
const CAPPED = { ...FISH, id: 'pristine-only', floatRange: [0.0, 0.1] };

test('rollSize stays within sizeRange', () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 1000; i++) {
    const s = rollSize(FISH, rng);
    assert.ok(s >= 18 && s <= 42, `size ${s} out of [18,42]`);
  }
});

test('rollFloat stays in [0,1] and respects per-species cap', () => {
  const rng = mulberry32(8);
  for (let i = 0; i < 1000; i++) {
    const f = rollFloat(FISH, rng);
    assert.ok(f >= 0 && f <= 1, `float ${f} out of [0,1]`);
    const capped = rollFloat(CAPPED, rng);
    assert.ok(capped >= 0 && capped <= 0.1, `capped float ${capped} exceeded [0,0.1]`);
  }
});

test('rollFloat skews toward mid-condition (tails are rarer)', () => {
  const rng = mulberry32(11);
  let mid = 0, ends = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const f = rollFloat(FISH, rng);
    if (f > 0.4 && f < 0.6) mid++;
    if (f < 0.1 || f > 0.9) ends++;
  }
  assert.ok(mid > ends, `mid band (${mid}) should beat the extreme tails (${ends})`);
});

test('floatToGrade maps bucket boundaries exactly', () => {
  assert.equal(floatToGrade(0.00), 'Prime');
  assert.equal(floatToGrade(0.069), 'Prime');
  assert.equal(floatToGrade(0.07), 'Vivid');
  assert.equal(floatToGrade(0.149), 'Vivid');
  assert.equal(floatToGrade(0.15), 'Healthy');
  assert.equal(floatToGrade(0.379), 'Healthy');
  assert.equal(floatToGrade(0.38), 'Faded');
  assert.equal(floatToGrade(0.449), 'Faded');
  assert.equal(floatToGrade(0.45), 'Scarred');
  assert.equal(floatToGrade(1.00), 'Scarred');
});

test('rollShiny triggers near the configured rate and is boolean', () => {
  const rng = mulberry32(42);
  let hits = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const s = rollShiny(rng);
    assert.equal(typeof s, 'boolean');
    if (s) hits++;
  }
  const rate = hits / N;
  assert.ok(rate > SHINY_RATE * 0.6 && rate < SHINY_RATE * 1.6, `shiny rate ${rate} should be near ${SHINY_RATE}`);
});

test('createSpecimen returns a valid specimen with matching grade', () => {
  const rng = mulberry32(21);
  const sp = createSpecimen(FISH, rng);
  assert.equal(sp.species, 'trout');
  assert.ok(sp.size >= 18 && sp.size <= 42);
  assert.ok(sp.float >= 0 && sp.float <= 1);
  assert.equal(sp.grade, floatToGrade(sp.float), 'grade must agree with floatToGrade');
  assert.equal(typeof sp.shiny, 'boolean');
});

test('createSpecimen is deterministic for a fixed seed', () => {
  const a = createSpecimen(FISH, mulberry32(1));
  const b = createSpecimen(FISH, mulberry32(1));
  assert.deepEqual(a, b);
});

const { computeCoins } = ENGINE;
const COINFISH = { id: 'koi', name: 'Koi', rarity: 3, behavior: 'feintingDrifter', family: 'koi', sizeRange: [30, 70], coinBase: 150 };

test('computeCoins returns an integer', () => {
  const c = computeCoins(COINFISH, 50, 0.3, false, false);
  assert.equal(Number.isInteger(c), true);
});

test('computeCoins rises with size', () => {
  const small = computeCoins(COINFISH, 30, 0.3, false, false);
  const big = computeCoins(COINFISH, 70, 0.3, false, false);
  assert.ok(big > small, `bigger fish (${big}) should pay more than smaller (${small})`);
});

test('computeCoins rises as float improves (float -> 0)', () => {
  const worn = computeCoins(COINFISH, 50, 0.9, false, false);
  const prime = computeCoins(COINFISH, 50, 0.02, false, false);
  assert.ok(prime > worn, `prime (${prime}) should beat worn (${worn})`);
});

test('computeCoins applies a large shiny bonus', () => {
  const normal = computeCoins(COINFISH, 50, 0.3, false, false);
  const shiny = computeCoins(COINFISH, 50, 0.3, true, false);
  assert.ok(shiny >= normal * 4, `shiny (${shiny}) should be far above normal (${normal})`);
});

test('computeCoins adds the discovery bonus exactly once for new species', () => {
  const repeat = computeCoins(COINFISH, 50, 0.3, false, false);
  const discovered = computeCoins(COINFISH, 50, 0.3, false, true);
  assert.equal(discovered - repeat, RARITY_TIERS[3].discoveryBonus, 'discovery delta must equal the tier bonus');
});

const { PRIMITIVES } = ENGINE;

function freshState() { return { pos: 0.5, vel: 0, target: null, since: 0, t: 0, dir: 1 }; }
function runPrimitive(name, p, steps, seed) {
  const s = freshState();
  const rng = mulberry32(seed);
  const trace = [];
  for (let i = 0; i < steps; i++) trace.push(PRIMITIVES[name](s, 1 / 60, rng, p));
  return trace;
}

test('every primitive keeps the marker inside [0,1]', () => {
  const cfgs = {
    drift: { lo: 0.2, hi: 0.8, retarget: 2.5, ease: 2.5 },
    dart: { lo: 0.0, hi: 1.0, retarget: 0.8, ease: 7 },
    oscillate: { lo: 0.1, hi: 0.9, omega: 1.6 },
    hold: { lo: 0.6, hi: 0.95, stiffness: 2.2 },
    sweep: { lo: 0.05, hi: 0.95, speed: 0.35 },
    pulse: { lo: 0.1, hi: 0.9, interval: 1.2, hopEase: 8 },
    walk: { lo: 0, hi: 1, step: 0.6 },
  };
  for (const [name, p] of Object.entries(cfgs)) {
    for (const pos of runPrimitive(name, p, 600, 13)) {
      assert.ok(pos >= 0 && pos <= 1, `${name} produced ${pos} outside [0,1]`);
    }
  }
});

test('hold stays near its zone center', () => {
  const trace = runPrimitive('hold', { lo: 0.6, hi: 0.95, stiffness: 2.5 }, 600, 4);
  const tail = trace.slice(300);
  const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
  assert.ok(avg > 0.7, `hold-top average ${avg.toFixed(3)} should settle high`);
});

test('oscillate is periodic (revisits its mid level)', () => {
  const trace = runPrimitive('oscillate', { lo: 0.2, hi: 0.8, omega: 2.0 }, 600, 1);
  const max = Math.max(...trace), min = Math.min(...trace);
  assert.ok(max - min > 0.4, `oscillate should sweep a wide range, got span ${(max - min).toFixed(3)}`);
});

test('dart retargets faster than drift (more movement over time)', () => {
  const travel = (name, p) => {
    const t = runPrimitive(name, p, 600, 77);
    let d = 0;
    for (let i = 1; i < t.length; i++) d += Math.abs(t[i] - t[i - 1]);
    return d;
  };
  const driftTravel = travel('drift', { lo: 0.2, hi: 0.8, retarget: 2.5, ease: 2.5 });
  const dartTravel = travel('dart', { lo: 0.0, hi: 1.0, retarget: 0.8, ease: 7 });
  assert.ok(dartTravel > driftTravel, `dart travel ${dartTravel.toFixed(2)} should exceed drift ${driftTravel.toFixed(2)}`);
});

const { BEHAVIORS, resolveBehavior, createBehaviorState, stepFish } = ENGINE;

function fishWith(behavior, rarity = 2) {
  return { id: 'x', name: 'X', rarity, behavior, family: 'test', sizeRange: [10, 20], coinBase: 10 };
}

test('every BEHAVIORS entry references a real primitive', () => {
  const valid = new Set(Object.keys(ENGINE.PRIMITIVES));
  for (const [name, def] of Object.entries(BEHAVIORS)) {
    assert.ok(valid.has(def.primitive), `behavior ${name} uses unknown primitive ${def.primitive}`);
    if (def.mods && def.mods.phase) {
      assert.ok(valid.has(def.mods.phase.alt), `behavior ${name} phase.alt ${def.mods.phase.alt} is not a primitive`);
    }
  }
});

test('the roster of named behaviors is at least 30', () => {
  assert.ok(Object.keys(BEHAVIORS).length >= 30, `expected >=30 behaviors, got ${Object.keys(BEHAVIORS).length}`);
});

test('resolveBehavior folds rarity speed (legendary faster than common)', () => {
  const slow = resolveBehavior(fishWith('darter', 1)).speedMul;
  const fast = resolveBehavior(fishWith('darter', 5)).speedMul;
  assert.ok(fast > slow, `legendary speedMul ${fast} should exceed common ${slow}`);
});

test('stepFish keeps position in [0,1] for all behaviors', () => {
  for (const name of Object.keys(BEHAVIORS)) {
    const s = createBehaviorState(fishWith(name, 3));
    const rng = mulberry32(31);
    for (let i = 0; i < 400; i++) {
      const pos = stepFish(s, 1 / 60, rng, i / 400);
      assert.ok(pos >= 0 && pos <= 1, `${name} produced ${pos} outside [0,1]`);
    }
  }
});

test('mirror behaviors move continuously (no teleport at period boundaries)', () => {
  // mirage uses the mirror modifier (period 2.5s). Step across several periods
  // and assert no single frame jumps more than a generous speed-based bound.
  const fish = { id: 'm', name: 'M', rarity: 3, behavior: 'mirage', family: 'test', sizeRange: [10, 20], coinBase: 10 };
  const s = createBehaviorState(fish);
  const rng = mulberry32(17);
  let prev = stepFish(s, 1 / 60, rng, 0.5);
  let maxJump = 0;
  for (let i = 0; i < 1200; i++) { // 20 seconds, crosses 8 mirror periods
    const pos = stepFish(s, 1 / 60, rng, 0.5);
    maxJump = Math.max(maxJump, Math.abs(pos - prev));
    prev = pos;
  }
  assert.ok(maxJump < 0.25, `mirror motion should be continuous; max single-frame jump was ${maxJump.toFixed(3)}`);
});

test('pause modifier produces zero-velocity windows', () => {
  const s = createBehaviorState(fishWith('pausingBouncer', 3));
  const rng = mulberry32(2);
  let frozenFrames = 0, prev = s.pos;
  for (let i = 0; i < 600; i++) {
    const pos = stepFish(s, 1 / 60, rng, 0);
    if (Math.abs(pos - prev) < 1e-6) frozenFrames++;
    prev = pos;
  }
  assert.ok(frozenFrames > 20, `expected some frozen frames from pause, got ${frozenFrames}`);
});

test('crescendo speeds up as progress approaches 1', () => {
  const travel = (progress) => {
    const s = createBehaviorState(fishWith('tempest', 4));
    const rng = mulberry32(5);
    let d = 0, prev = s.pos;
    for (let i = 0; i < 300; i++) { const pos = stepFish(s, 1 / 60, rng, progress); d += Math.abs(pos - prev); prev = pos; }
    return d;
  };
  assert.ok(travel(0.95) > travel(0.05), 'crescendo behavior should move more at high progress');
});

test('createBehaviorState is reproducible for a fixed seed sequence', () => {
  const run = () => {
    const s = createBehaviorState(fishWith('trickster', 5));
    const rng = mulberry32(9);
    const trace = [];
    for (let i = 0; i < 100; i++) trace.push(stepFish(s, 1 / 60, rng, 0.5));
    return trace;
  };
  assert.deepEqual(run(), run());
});

const { createBarState, stepBar, isCaught, isEscaped } = ENGINE;
const BARFISH = { id: 'b', name: 'B', rarity: 1, behavior: 'drifter', family: 'test', sizeRange: [10, 20], coinBase: 10 };

test('progress rises while the bar overlaps the fish', () => {
  const st = createBarState(BARFISH);
  const rng = mulberry32(1);
  st.fish_.def.speedMul = 0; // freeze fish motion for the assertion
  st.fish_.def.mods = {}; // disable modifiers to prevent easing
  const before = st.progress;
  for (let i = 0; i < 30; i++) { stepBar(st, 1 / 60, true, rng); st.bar.pos = st.fish_.pos; }
  // keep bar glued to fish each frame
  assert.ok(st.progress > before, `progress ${st.progress} should rise from ${before} while overlapping`);
});

test('progress drains when the bar is far from the fish', () => {
  const st = createBarState(BARFISH);
  const rng = mulberry32(1);
  st.progress = 0.5;
  st.fish_.pos = 0.9;
  st.bar.pos = 0.0; // far apart, not holding -> bar falls further away
  for (let i = 0; i < 60; i++) stepBar(st, 1 / 60, false, rng);
  assert.ok(st.progress < 0.5, `progress ${st.progress} should drain below 0.5 when far apart`);
});

test('holding raises the bar, releasing drops it (gravity)', () => {
  const st = createBarState(BARFISH);
  const rng = mulberry32(1);
  st.bar.pos = 0.5; st.bar.vel = 0;
  for (let i = 0; i < 20; i++) stepBar(st, 1 / 60, true, rng);
  const lifted = st.bar.pos;
  for (let i = 0; i < 40; i++) stepBar(st, 1 / 60, false, rng);
  assert.ok(lifted > 0.5, `holding should lift bar above 0.5, got ${lifted}`);
  assert.ok(st.bar.pos < lifted, `releasing should drop the bar below ${lifted}, got ${st.bar.pos}`);
});

test('bar position clamps to [0, 1 - barSize]', () => {
  const st = createBarState(BARFISH);
  const rng = mulberry32(1);
  for (let i = 0; i < 600; i++) stepBar(st, 1 / 60, true, rng); // mash up
  const maxPos = 1 - st.tier.barSize;
  assert.ok(st.bar.pos <= maxPos + 1e-9, `bar pos ${st.bar.pos} exceeded ${maxPos}`);
  assert.ok(st.bar.pos >= 0, `bar pos ${st.bar.pos} below 0`);
});

test('isCaught true at progress>=1, isEscaped true at progress<=0', () => {
  const st = createBarState(BARFISH);
  st.progress = 1; assert.equal(isCaught(st), true); assert.equal(isEscaped(st), false);
  st.progress = 0; assert.equal(isEscaped(st), true); assert.equal(isCaught(st), false);
  st.progress = 0.5; assert.equal(isCaught(st), false); assert.equal(isEscaped(st), false);
});
