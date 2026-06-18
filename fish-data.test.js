'use strict';
// Roster integrity for fish-data.js. Run: `node --test fish-data.test.js`
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FISH, FISH_BY_ID, FAMILIES } = require('./fish-data.js');
const { BEHAVIORS, RARITY_TIERS } = require('./fishing.js');

test('roster has exactly 151 fish', () => {
  assert.equal(FISH.length, 151);
});

test('tier counts are 50/45/35/16/5', () => {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const f of FISH) counts[f.rarity]++;
  assert.deepEqual(counts, { 1: 50, 2: 45, 3: 35, 4: 16, 5: 5 });
});

test('every fish id is unique', () => {
  const ids = new Set();
  for (const f of FISH) {
    assert.ok(!ids.has(f.id), `duplicate id ${f.id}`);
    ids.add(f.id);
  }
  assert.equal(Object.keys(FISH_BY_ID).length, 151);
});

test('every fish references a known behavior and a valid rarity', () => {
  for (const f of FISH) {
    assert.ok(BEHAVIORS[f.behavior], `${f.id} uses unknown behavior ${f.behavior}`);
    assert.ok(RARITY_TIERS[f.rarity], `${f.id} has invalid rarity ${f.rarity}`);
  }
});

test('every fish has a sane sizeRange and positive coinBase', () => {
  for (const f of FISH) {
    assert.ok(Array.isArray(f.sizeRange) && f.sizeRange.length === 2, `${f.id} bad sizeRange`);
    assert.ok(f.sizeRange[0] > 0 && f.sizeRange[1] > f.sizeRange[0], `${f.id} sizeRange not ascending`);
    assert.ok(f.coinBase > 0, `${f.id} coinBase must be positive`);
    assert.ok(FAMILIES.includes(f.family), `${f.id} family ${f.family} not in FAMILIES`);
  }
});

test('legendaries are concentrated in boss-class behaviors', () => {
  const boss = new Set(['trickster', 'tempest', 'tyrant']);
  const legends = FISH.filter(f => f.rarity === 5);
  assert.ok(legends.every(f => boss.has(f.behavior)), 'all legendaries should use boss behaviors');
});

test('behavior variety: at least 12 distinct behaviors used across the roster', () => {
  const used = new Set(FISH.map(f => f.behavior));
  assert.ok(used.size >= 12, `expected >=12 distinct behaviors, got ${used.size}`);
});
