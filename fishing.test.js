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
