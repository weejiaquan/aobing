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
