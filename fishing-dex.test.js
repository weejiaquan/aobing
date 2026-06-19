'use strict';
// Unit tests for the PURE fishing dex/inventory data module.
// Run: `node --test fishing-dex.test.js`
const { test } = require('node:test');
const assert = require('node:assert/strict');

const D = require('./fishing-dex.js');
const { dexEntries, dexSummary, groupByFamily, specimenView, sortSpecimens, filterSpecimens } = D;

const FISH = [
  { id: 'bluegill', name: 'Bluegill', rarity: 1, behavior: 'drifter', family: 'Minnows', sizeRange: [10, 22], coinBase: 9 },
  { id: 'smelt', name: 'Smelt', rarity: 1, behavior: 'meanderer', family: 'Minnows', sizeRange: [6, 14], coinBase: 11 },
  { id: 'koi', name: 'Koi', rarity: 3, behavior: 'feintingDrifter', family: 'Koi', sizeRange: [30, 70], coinBase: 150 },
];
const FISH_BY_ID = {}; for (const f of FISH) FISH_BY_ID[f.id] = f;

const FISHDEX = {
  bluegill: { count: 4, maxSize: 20, bestFloat: 0.05, shinyCaught: false },
  koi: { count: 1, maxSize: 52, bestFloat: 0.40, shinyCaught: true },
};

test('dexEntries returns one entry per species, in roster order, with caught flags', () => {
  const e = dexEntries(FISHDEX, FISH);
  assert.equal(e.length, 3);
  assert.deepEqual(e.map(x => x.fish.id), ['bluegill', 'smelt', 'koi']);
  assert.equal(e[0].caught, true);
  assert.equal(e[0].count, 4);
  assert.equal(e[0].grade, 'Prime');       // float 0.05 -> Prime
  assert.equal(e[1].caught, false);          // smelt uncaught
  assert.equal(e[1].count, 0);
  assert.equal(e[2].caught, true);
  assert.equal(e[2].shiny, true);
  assert.equal(e[2].grade, 'Faded');         // float 0.40 -> Faded
});

test('dexSummary counts caught/total overall and per family', () => {
  const s = dexSummary(FISHDEX, FISH);
  assert.equal(s.total, 3);
  assert.equal(s.caught, 2);
  assert.deepEqual(s.byFamily.Minnows, { caught: 1, total: 2 });
  assert.deepEqual(s.byFamily.Koi, { caught: 1, total: 1 });
});

test('groupByFamily groups entries in first-appearance order', () => {
  const g = groupByFamily(dexEntries(FISHDEX, FISH));
  assert.deepEqual(g.map(x => x.family), ['Minnows', 'Koi']);
  assert.equal(g[0].entries.length, 2);
});

test('specimenView derives name + grade', () => {
  const v = specimenView({ species: 'koi', size: 52, float: 0.40, shiny: true, caughtAt: 1000 }, FISH_BY_ID);
  assert.equal(v.name, 'Koi');
  assert.equal(v.grade, 'Faded');
  assert.equal(v.shiny, true);
});

test('sortSpecimens orders correctly and does not mutate input', () => {
  const specs = [
    { species: 'a', size: 10, float: 0.5, caughtAt: 100 },
    { species: 'b', size: 30, float: 0.1, caughtAt: 300 },
    { species: 'c', size: 20, float: 0.2, caughtAt: 200 },
  ];
  const frozen = JSON.stringify(specs);
  assert.deepEqual(sortSpecimens(specs, 'recent').map(s => s.species), ['b', 'c', 'a']);
  assert.deepEqual(sortSpecimens(specs, 'size').map(s => s.species), ['b', 'c', 'a']);
  assert.deepEqual(sortSpecimens(specs, 'float').map(s => s.species), ['b', 'c', 'a']); // best (low) first
  assert.equal(JSON.stringify(specs), frozen, 'input array must not be mutated');
});

test('filterSpecimens filters by species and shinyOnly', () => {
  const specs = [
    { species: 'koi', shiny: true }, { species: 'koi', shiny: false }, { species: 'smelt', shiny: true },
  ];
  assert.equal(filterSpecimens(specs, { species: 'koi' }).length, 2);
  assert.equal(filterSpecimens(specs, { shinyOnly: true }).length, 2);
  assert.equal(filterSpecimens(specs, { species: 'koi', shinyOnly: true }).length, 1);
  assert.equal(filterSpecimens(specs, {}).length, 3);
});
