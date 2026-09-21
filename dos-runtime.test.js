'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateWad, wadFilename, keyCode, savePaths, patchConfig, MAX_WAD_BYTES } = require('./dos-runtime');

test('migrates saved fire/use bindings without discarding unrelated settings or saves', () => {
  const old = new TextEncoder().encode('sfx_volume 7\r\nkey_fire 157\r\nkey_up 17\r\n');
  const updated = new TextDecoder().decode(patchConfig(old, { key_fire: 57, key_use: 18 }));
  assert.match(updated, /^key_fire 57$/m);
  assert.match(updated, /^key_use 18$/m);
  assert.match(updated, /^sfx_volume 7\r?$/m);
  assert.match(updated, /^key_up 17\r?$/m);
  assert.equal((updated.match(/key_fire/g) || []).length, 1);
  assert.equal(new TextDecoder().decode(patchConfig(new TextEncoder().encode(updated), { key_fire: 57, key_use: 18 })), updated);
});

function wad(name = 'E1M1') {
  const bytes = new Uint8Array(28);
  bytes.set(Buffer.from('IWAD'));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true); view.setUint32(8, 12, true);
  bytes.set(Buffer.from(name), 20);
  return bytes;
}
test('accepts episode and Doom II map directories, including sliced byte buffers', () => {
  assert.equal(validateWad(wad()), true);
  const backing = new Uint8Array(40); backing.set(wad('MAP01'), 8);
  assert.equal(validateWad(backing.subarray(8, 36)), true);
});
test('rejects mods, unrelated IWADs, oversized files and malformed directory/lump ranges', () => {
  const mod = wad(); mod.set(Buffer.from('PWAD'));
  const offset = wad(); new DataView(offset.buffer).setUint32(8, 0xffffffff, true);
  const count = wad(); new DataView(count.buffer).setUint32(4, 0xffffffff, true);
  const lump = wad(); new DataView(lump.buffer).setUint32(16, 1000, true);
  for (const bytes of [new Uint8Array(0), new Uint8Array(MAX_WAD_BYTES + 1), mod, wad('TITLEPIC'), offset, count, lump]) {
    assert.throws(() => validateWad(bytes), /dos.invalid_wad/);
  }
});
test('maps physical keyboard codes to DOS keys, not browser keyCode values', () => {
  assert.equal(keyCode('ArrowUp'), 265); assert.equal(keyCode('Enter'), 257);
  assert.equal(keyCode('ControlLeft'), 341); assert.equal(keyCode('F2'), 291);
  assert.equal(keyCode('F3'), 292); assert.equal(keyCode('KeyW'), 87);
  assert.equal(keyCode('Digit7'), 55); assert.equal(keyCode('MetaLeft'), null);
});
test('selects the engine IWAD name from content, not an untrusted upload filename', () => {
  const make = (...names) => {
    const bytes = new Uint8Array(12 + names.length * 16);
    bytes.set(Buffer.from('IWAD')); const view = new DataView(bytes.buffer);
    view.setUint32(4, names.length, true); view.setUint32(8, 12, true);
    names.forEach((name, i) => bytes.set(Buffer.from(name), 20 + i * 16));
    return bytes;
  };
  assert.equal(wadFilename(make('E1M1')), 'DOOM1.WAD');
  assert.equal(wadFilename(make('E1M1', 'E3M1')), 'DOOM.WAD');
  assert.equal(wadFilename(make('E1M1', 'E4M1')), 'DOOMU.WAD');
  assert.equal(wadFilename(make('MAP01')), 'DOOM2.WAD');
  assert.equal(wadFilename(make('E1M1', 'FREEDOOM')), 'FREEDM1.WAD');
  assert.equal(wadFilename(make('MAP01', 'FREEDOOM')), 'FREEDM2.WAD');
});
test('local saves contain config and saved games, never IWADs or executables', () => {
  const file = (name, size = 20) => ({ name, size, nodes: null });
  const tree = { nodes: [file('SMMU.CFG'), file('GAME.WAD'), file('SMMU.EXE'), file('doomsav0.dsg'),
    file('oversized.dsg', 5 * 1024 * 1024), { name: '.jsdos', nodes: [file('dosbox.cfg')] },
    { name: 'saves', nodes: [file('doomsav1.dsg')] }] };
  assert.deepEqual(savePaths(tree), ['SMMU.CFG', 'doomsav0.dsg', 'saves/doomsav1.dsg']);
});
