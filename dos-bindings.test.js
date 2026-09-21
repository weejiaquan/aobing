const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('./dos-bindings');
const { patchConfig } = require('./dos-runtime');

test('defaults compile to native Doom scan codes with browser-safe fire', () => {
  assert.deepEqual(B.overrides(B.fresh()), { key_up: 17, key_down: 31, key_strafeleft: 30, key_straferight: 32,
    key_left: 75, key_right: 77, key_fire: 57, key_use: 18, key_speed: 54 });
});
test('remaps letters and normalizes Shift while rejecting collisions and reserved keys', () => {
  const value = B.fresh();
  assert.equal(B.assign(value, 'fire', 'KeyW'), 'dos.remap_duplicate');
  for (const code of ['ControlLeft', 'AltLeft', 'MetaLeft', 'F2', 'Enter', 'Escape', 'Digit1']) {
    assert.equal(B.assign(value, 'fire', code), 'dos.remap_reserved');
  }
  assert.equal(B.assign(value, 'fire', 'KeyF'), '');
  assert.equal(B.assign(value, 'run', 'ShiftRight'), '');
  assert.equal(B.overrides(value).key_fire, 33);
  assert.equal(B.overrides(value).key_speed, 54);
});
test('corrupt storage falls back safely and valid drafts do not mutate saved controls', () => {
  for (const bad of [null, {}, { keys: {}, mouse: [] }, { ...B.fresh(), mouse: ['evil', 'none', 'none'] }]) {
    assert.deepEqual(B.restore(bad), B.fresh());
  }
  const saved = B.fresh(), draft = B.restore(saved);
  draft.keys.fire = 'KeyF'; draft.mouse[2] = 'use';
  assert.equal(saved.keys.fire, 'Space'); assert.equal(saved.mouse[2], 'none');
  assert.deepEqual(B.restore(JSON.parse(JSON.stringify(draft))), draft);
});
test('custom bindings patch saved configs without removing audio settings', () => {
  const value = B.fresh(); B.assign(value, 'forward', 'KeyI'); B.assign(value, 'fire', 'KeyF');
  const source = new TextEncoder().encode('sfx_volume 7\r\nkey_fire 57\r\nkey_up 17\r\n');
  const text = new TextDecoder().decode(patchConfig(source, B.overrides(value)));
  assert.match(text, /^key_up 23$/m); assert.match(text, /^key_fire 33$/m);
  assert.match(text, /^sfx_volume 7\r?$/m);
});
