'use strict';
// Determinism + trait-validity for the procedural sprite spec.
// Run: `node --test fish-sprite.test.js`
const { test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('./fish-sprite.js');
const { FISH, FAMILIES } = require('./fish-data.js');
const { fishSpriteSpec, BODY_SHAPES, PATTERNS, PALETTES, SHINY_PALETTES, ACCENTS } = S;

const COMMON = { id: 'river-minnow', name: 'River Minnow', rarity: 1, behavior: 'drifter', family: 'Minnows', sizeRange: [6, 14], coinBase: 10 };
const LEGEND = { id: 'storm-mythic', name: 'Storm Mythic', rarity: 5, behavior: 'tempest', family: 'Mythic', sizeRange: [300, 800], coinBase: 1400 };

test('swim rigs preserve the rest pose and remain bounded through complete cycles', () => {
  for (const family of FAMILIES) {
    const spec=fishSpriteSpec({...COMMON,family});
    for (let x=0;x<=1;x+=.25) for(let y=0;y<=1;y+=.25) {
      assert.deepEqual(S.swimPoint(spec,x,y,0),{x,y});
      for(let t=.1;t<8;t+=.2){
        const p=S.swimPoint(spec,x,y,t),next=S.swimPoint(spec,x,y,t+.001);
        assert.ok(Math.abs(p.x-x)<.09 && Math.abs(p.y-y)<.1, family+' displacement');
        assert.ok(Math.hypot(next.x-p.x,next.y-p.y)<.002, family+' continuity');
      }
    }
  }
});

test('side-profile fish keep the face fixed while the tail flexes', () => {
  const spec=fishSpriteSpec(COMMON);
  assert.deepEqual(S.swimPoint(spec,.9,.5,1.5),{x:.9,y:.5});
  const tail=S.swimPoint(spec,.1,.5,1.5);
  assert.ok(Math.hypot(tail.x-.1,tail.y-.5)>.001);
});

test('all 151 species have explicit family anatomy and distinct seeded details', () => {
  assert.deepEqual(Object.keys(S.FAMILY_PROFILES).sort(), [...FAMILIES].sort());
  const identities = new Set();
  for (const fish of FISH) {
    const normal = fishSpriteSpec(fish, { float: 0.2 });
    const shiny = fishSpriteSpec(fish, { float: 0.2, shiny: true });
    assert.equal(normal.family, fish.family);
    identities.add(JSON.stringify([normal.family, normal.variation]));
    // Alternate finishes never turn a specimen into a different animal.
    for (const key of ['family', 'variation', 'bodyShape', 'finShape', 'tailShape', 'pattern', 'eye'])
      assert.deepEqual(shiny[key], normal[key], fish.id + ': ' + key);
  }
  assert.equal(identities.size, 151);
});

test('fishSpriteSpec is deterministic in (id, float, shiny)', () => {
  const a = fishSpriteSpec(COMMON, { float: 0.3, shiny: false });
  const b = fishSpriteSpec(COMMON, { float: 0.3, shiny: false });
  assert.deepEqual(a, b);
});

test('every family maps to a complete painted atlas region', () => {
  for (const family of FAMILIES) {
    const rect = S.ATLAS_RECTS[family];
    assert.ok(rect, family);
    const [x, y, w, h] = rect;
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0);
    assert.ok(x + w <= 1254 && y + h <= 1254, family + ' must stay inside the atlas');
  }
  assert.ok(S.ATLAS_RECTS.Angelfish, 'second tropical illustration');
});

test('every chosen trait comes from its pool', () => {
  const spec = fishSpriteSpec(COMMON, { float: 0.2, shiny: false });
  assert.ok(BODY_SHAPES.includes(spec.bodyShape));
  assert.ok(PATTERNS.includes(spec.pattern));
  const palInPool = (pal, pool) => pool.some(p => p.length === pal.length && p.every((c, i) => c === pal[i]));
  assert.ok(palInPool(spec.palette, PALETTES) || palInPool(spec.palette, SHINY_PALETTES),
    'palette must be value-equal to a pool entry');
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
