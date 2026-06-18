'use strict';
// Determinism + trait-validity for the procedural sprite spec.
// Run: `node --test fish-sprite.test.js`
const { test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('./fish-sprite.js');
const { fishSpriteSpec, BODY_SHAPES, PATTERNS, PALETTES, SHINY_PALETTES, ACCENTS } = S;

const COMMON = { id: 'river-minnow', name: 'River Minnow', rarity: 1, behavior: 'drifter', family: 'Minnows', sizeRange: [6, 14], coinBase: 10 };
const LEGEND = { id: 'storm-mythic', name: 'Storm Mythic', rarity: 5, behavior: 'tempest', family: 'Mythic', sizeRange: [300, 800], coinBase: 1400 };

test('fishSpriteSpec is deterministic in (id, float, shiny)', () => {
  const a = fishSpriteSpec(COMMON, { float: 0.3, shiny: false });
  const b = fishSpriteSpec(COMMON, { float: 0.3, shiny: false });
  assert.deepEqual(a, b);
});

test('every chosen trait comes from its pool', () => {
  const spec = fishSpriteSpec(COMMON, { float: 0.2, shiny: false });
  assert.ok(BODY_SHAPES.includes(spec.bodyShape));
  assert.ok(PATTERNS.includes(spec.pattern));
  assert.ok(PALETTES.includes(spec.palette) || SHINY_PALETTES.includes(spec.palette));
  for (const a of spec.accents) assert.ok(ACCENTS.includes(a));
});

test('condition tracks float (lower float = better condition)', () => {
  const prime = fishSpriteSpec(COMMON, { float: 0.02, shiny: false });
  const scarred = fishSpriteSpec(COMMON, { float: 0.95, shiny: false });
  assert.ok(prime.condition > scarred.condition, `condition should fall as float rises (${prime.condition} vs ${scarred.condition})`);
});

test('shiny selects from the shiny palette pool', () => {
  const spec = fishSpriteSpec(COMMON, { float: 0.2, shiny: true });
  assert.equal(spec.shiny, true);
  assert.ok(SHINY_PALETTES.includes(spec.palette), 'shiny must use a shiny palette');
});

test('legendary-only accents never appear on commons', () => {
  // "glow" is rarity>=4 gated.
  let sawGlowOnCommon = false;
  for (let i = 0; i < 50; i++) {
    const f = { ...COMMON, id: 'c' + i };
    if (fishSpriteSpec(f, { float: 0.2, shiny: false }).accents.includes('glow')) sawGlowOnCommon = true;
  }
  assert.equal(sawGlowOnCommon, false, 'commons must never roll the glow accent');
  // legendaries are allowed glow; ensure it is at least possible across ids.
  let sawGlowOnLegend = false;
  for (let i = 0; i < 50; i++) {
    const f = { ...LEGEND, id: 'L' + i };
    if (fishSpriteSpec(f, { float: 0.2, shiny: false }).accents.includes('glow')) sawGlowOnLegend = true;
  }
  assert.equal(sawGlowOnLegend, true, 'legendaries should be able to roll glow');
});
