'use strict';
// Tests for cpk.js. The committed tests build a SYNTHETIC CPK in-code (real CPK/@UTF
// structure, AES-encrypted with the same key, no copyrighted data) and round-trip it
// through readToc/readEntry → divadsc/divapvdb. A guarded block reads the user's real
// diva_main.cpk when $DIVA_CPK points at it. Run: `node --test cpk.test.js`
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const C = require('./cpk.js');
const D = require('./divadsc.js');
const P = require('./divapvdb.js');

// --- minimal @UTF + CPK builders (all columns PERROW; types u32=4,u64=6,string=0xA) --
function u32be(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }
function buildUtf(columns, rows) {
  const strOff = new Map(); let pool = Buffer.from([0]);   // offset 0 = "" (table name)
  const addString = (s) => { if (strOff.has(s)) return strOff.get(s); const off = pool.length; pool = Buffer.concat([pool, Buffer.from(String(s) + '\0', 'utf8')]); strOff.set(s, off); return off; };
  const colSize = (t) => (t === 6 ? 8 : 4);
  let schema = Buffer.alloc(0);
  for (const col of columns) { const b = Buffer.alloc(5); b.writeUInt8(0x50 | col.type, 0); b.writeUInt32BE(addString(col.name), 1); schema = Buffer.concat([schema, b]); }
  const rowWidth = columns.reduce((s, c) => s + colSize(c.type), 0);
  const rowsBuf = Buffer.alloc(rowWidth * rows.length); let ro = 0;
  for (const row of rows) for (const col of columns) {
    const v = row[col.name];
    if (col.type === 0xA) { rowsBuf.writeUInt32BE(addString(v), ro); ro += 4; }
    else if (col.type === 6) { rowsBuf.writeBigUInt64BE(BigInt(v), ro); ro += 8; }
    else { rowsBuf.writeUInt32BE(v >>> 0, ro); ro += 4; }
  }
  const header = Buffer.alloc(24);
  const rowsOffset = 24 + schema.length, stringsOffset = rowsOffset + rowsBuf.length, dataOffset = stringsOffset + pool.length;
  header.writeUInt32BE(rowsOffset, 0); header.writeUInt32BE(stringsOffset, 4); header.writeUInt32BE(dataOffset, 8);
  header.writeUInt32BE(0, 12); header.writeUInt16BE(columns.length, 16); header.writeUInt16BE(rowWidth, 18); header.writeUInt32BE(rows.length, 20);
  const after = Buffer.concat([header, schema, rowsBuf, pool]);
  return Buffer.concat([Buffer.from('@UTF'), u32be(after.length), after]);
}
function chunk(magic, utf) { const h = Buffer.alloc(0x10); h.write(magic, 0, 'ascii'); h.writeUInt32BE(0xff, 4); h.writeBigUInt64LE(BigInt(utf.length), 8); return Buffer.concat([h, utf]); }
async function aesEncrypt(plain) {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(C.KEY), { name: 'AES-CBC' }, false, ['encrypt']);
  const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(C.IV) }, key, plain);
  return Buffer.from(enc);
}
// Build a CPK: TocOffset=2048, ContentOffset after TOC, Align=2048, baseOff=min=2048.
async function buildCpk(files) {                 // files: [{name, plain:Buffer}]
  const ALIGN = 2048, TOC_OFFSET = 2048;
  const encs = [];
  for (const f of files) encs.push({ name: f.name, enc: await aesEncrypt(f.plain) });
  // lay content out at aligned positions starting some way past the TOC
  const CONTENT_OFFSET = 0x8000;                 // 32KB, comfortably past header+toc
  let cur = CONTENT_OFFSET;
  const tocRows = [];
  const placements = [];
  for (const e of encs) {
    const pos = Math.ceil(cur / ALIGN) * ALIGN;
    const slash = e.name.lastIndexOf('/');
    tocRows.push({ DirName: slash >= 0 ? e.name.slice(0, slash) : '', FileName: slash >= 0 ? e.name.slice(slash + 1) : e.name, FileSize: e.enc.length, ExtractSize: e.enc.length, FileOffset: pos - TOC_OFFSET });
    placements.push({ pos: pos, enc: e.enc });
    cur = pos + e.enc.length;
  }
  const cpkUtf = buildUtf(
    [{ name: 'TocOffset', type: 6 }, { name: 'ContentOffset', type: 6 }, { name: 'Align', type: 4 }, { name: 'Files', type: 4 }],
    [{ TocOffset: TOC_OFFSET, ContentOffset: CONTENT_OFFSET, Align: ALIGN, Files: files.length }]);
  const tocUtf = buildUtf(
    [{ name: 'DirName', type: 0xA }, { name: 'FileName', type: 0xA }, { name: 'FileSize', type: 4 }, { name: 'ExtractSize', type: 4 }, { name: 'FileOffset', type: 6 }],
    tocRows);
  const total = cur;
  const buf = Buffer.alloc(total);
  chunk('CPK ', cpkUtf).copy(buf, 0);
  chunk('TOC ', tocUtf).copy(buf, TOC_OFFSET);
  for (const pl of placements) pl.enc.copy(buf, pl.pos);
  return buf;
}
const bufReader = (buf) => (pos, len) => Promise.resolve(new Uint8Array(buf.subarray(pos, pos + len)));

// a tiny real .dsc (signature + TIME + FLY + TARGET + END)
function tinyDsc() {
  const ints = [0x14050921, 0x01, 0, 0x3A, 500, 0x06, 0, 240000, 135000, 90000, 270000, 500, 2, 0x00];
  const b = Buffer.alloc(ints.length * 4); b.writeUInt32LE(ints[0] >>> 0, 0);
  for (let i = 1; i < ints.length; i++) b.writeInt32LE(ints[i], i * 4);
  return b;
}

test('parseUtf round-trips a built @UTF table', () => {
  const utf = buildUtf([{ name: 'A', type: 4 }, { name: 'Name', type: 0xA }, { name: 'Big', type: 6 }], [{ A: 7, Name: 'hello', Big: 5000000000 }, { A: 9, Name: 'x', Big: 1 }]);
  const out = C.parseUtf(utf.buffer.slice(utf.byteOffset, utf.byteOffset + utf.byteLength));
  assert.deepEqual(out.columns, ['A', 'Name', 'Big']);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].A, 7); assert.equal(out.rows[0].Name, 'hello'); assert.equal(out.rows[0].Big, 5000000000);
  assert.equal(out.rows[1].Name, 'x');
});

test('criXor is an involution (xor twice = identity)', () => {
  const x = new Uint8Array([0x40, 0x55, 0x54, 0x46, 1, 2, 3, 250]);
  assert.deepEqual(Array.from(C.criXor(C.criXor(x))), Array.from(x));
});

test('readToc + readEntry: synthetic CPK → decrypted .dsc decodes', async () => {
  const dsc = tinyDsc();
  const buf = await buildCpk([{ name: 'rom/script/pv_999_easy.dsc', plain: dsc }]);
  const read = bufReader(buf);
  const toc = await C.readToc(read);
  assert.equal(toc.entries.length, 1);
  const entry = toc.find('rom/script/pv_999_easy.dsc');
  assert.ok(entry, 'entry found');
  const bytes = await C.readEntry(read, entry);
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true), 0x14050921, 'decrypted .dsc magic');
  const decoded = D.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(decoded.ended, true);
  assert.equal(decoded.notes.length, 1);
  assert.equal(decoded.notes[0].button, 'triangle');
});

test('find matches by path suffix (rom_steam/… prefix)', async () => {
  const buf = await buildCpk([{ name: 'rom_steam/rom/pv_db.txt', plain: Buffer.from('pv_1.song_name_en=Hi\n') }]);
  const read = bufReader(buf);
  const toc = await C.readToc(read);
  const e = toc.find('rom/pv_db.txt');                    // suffix match across the rom_steam prefix
  assert.ok(e, 'suffix-matched the pv_db');
  const txt = new TextDecoder().decode(await C.readEntry(read, e));
  assert.equal(P.parse(txt)[0].title, 'Hi');
});

test('readToc fails fast on a non-CPK file (no huge read)', async () => {
  const junk = Buffer.alloc(64); junk.write('NOPE', 0); junk.writeBigUInt64LE(BigInt(0xffffffffff), 8);  // absurd utfSize
  await assert.rejects(() => C.readToc(bufReader(junk)), /not a readable CPK/);
});

test('readToc rejects a CPK header with an implausible @UTF size', async () => {
  const b = Buffer.alloc(64); b.write('CPK ', 0); b.writeBigUInt64LE(BigInt(500 * 1024 * 1024), 8);  // 500MB > cap
  await assert.rejects(() => C.readToc(bufReader(b)), /implausible @UTF table size/);
});

// --- guarded: read the user's real diva_main.cpk if $DIVA_CPK is set ----------------
const REAL = process.env.DIVA_CPK;
test('real diva_main.cpk: TOC + decrypt a chart (skipped unless $DIVA_CPK)', { skip: REAL && fs.existsSync(REAL) ? false : 'set DIVA_CPK to run' }, async () => {
  const fd = fs.openSync(REAL, 'r');
  try {
    const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return Promise.resolve(new Uint8Array(b)); };
    const toc = await C.readToc(read);
    assert.ok(toc.entries.length > 1000, 'thousands of entries');
    const dscEntry = toc.entries.find((e) => /rom\/script\/pv_\d+_easy\.dsc$/.test(e.name));
    assert.ok(dscEntry, 'has script charts');
    const bytes = await C.readEntry(read, dscEntry);
    const decoded = D.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(decoded.ended, true, dscEntry.name + ' decodes to END');
    assert.ok(decoded.notes.length > 20, dscEntry.name + ' has notes');
  } finally { fs.closeSync(fd); }
});
