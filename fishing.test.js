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
