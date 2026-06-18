'use strict';
/*
 * cpk.js — read a CRI CPK archive (Project DIVA Mega Mix+) by BYTE RANGE only,
 * never loading the whole file (diva_main.cpk is ~24 GB). Decodes the `@UTF`
 * column tables (CpkHeader + TOC), indexes entries, and decrypts file content.
 *
 * Mega Mix+ stores file CONTENT AES-256-CBC encrypted; the `@UTF` index is only
 * CRI-XOR obfuscated. Key/IV are the published values from Project Heartbeat
 * (CPKArchive.gd) — the same legitimate Steam app the user runs reads their owned
 * Diva data this way. Decrypted content stays local (browser memory). Files are
 * NOT CRILAYLA-compressed here (FileSize === ExtractSize), so no decompressor is
 * needed; a compressed entry (should not occur) is reported, not silently mangled.
 *
 * Confirmed empirically (Phase-3 Task 0): a real .dsc entry decrypts to the
 * 0x14050921 magic and walks to END via divadsc.js.
 *
 * Usage (browser):  const toc = await Cpk.readToc(Cpk.fileReader(file));
 *                   const bytes = await Cpk.readEntry(Cpk.fileReader(file), toc.find('rom/script/pv_001_easy.dsc'));
 */
(function () {
  // Project Heartbeat's published MM+ content key/IV (AES-256-CBC).
  const KEY = [0xCF, 0x53, 0xBF, 0x9C, 0x37, 0x67, 0xAF, 0xB0, 0x35, 0x54, 0x4E, 0xB9, 0x96, 0xAA, 0x24, 0x39, 0x26, 0x5D, 0x40, 0x89, 0x7E, 0xD0, 0x1C, 0x3A, 0x6B, 0xA6, 0x5D, 0xD5, 0xFD, 0x6C, 0x19, 0xA3];
  const IV = [0xC2, 0x55, 0xFD, 0x73, 0xD8, 0x30, 0xFA, 0xEF, 0xD5, 0x32, 0x08, 0x54, 0xA2, 0x26, 0x44, 0x14];
  const UTF_MAGIC = 0x40555446;                 // '@UTF' big-endian
  const STORAGE_PERROW = 0x50, STORAGE_CONSTANT = 0x30;

  function subtle() {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
    if (!c || !c.subtle) throw new Error('Web Crypto (crypto.subtle) unavailable');
    return c.subtle;
  }

  // CRI @UTF XOR obfuscation (init 0x655f, mult 0x4115) — protects the index tables.
  function criXor(u8) {
    const o = u8.slice();
    let m = 0x655f;
    for (let i = 0; i < o.length; i++) { o[i] ^= (m & 0xff); m = (m * 0x4115) % 0x100000000; }
    return o;
  }

  // Parse a decrypted '@UTF' table (big-endian columnar) → { rows, columns }.
  function parseUtf(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const u8 = new Uint8Array(arrayBuffer);
    const td = new TextDecoder('utf-8');
    if (dv.getUint32(0) !== UTF_MAGIC) throw new Error('not an @UTF table');
    const base = 8;
    const rowsOffset = dv.getUint32(base);
    const stringsOffset = dv.getUint32(base + 4);
    const columnCount = dv.getUint16(base + 16);
    const rowWidth = dv.getUint16(base + 18);
    const rowCount = dv.getUint32(base + 20);
    const strBase = base + stringsOffset;
    const readStr = (rel) => { let p = strBase + rel, e = p; while (e < u8.length && u8[e] !== 0) e++; return td.decode(u8.subarray(p, e)); };
    const rd = (type, o) => {
      switch (type) {
        case 0: return [dv.getUint8(o), 1];
        case 1: return [dv.getInt8(o), 1];
        case 2: return [dv.getUint16(o), 2];
        case 3: return [dv.getInt16(o), 2];
        case 4: return [dv.getUint32(o), 4];
        case 5: return [dv.getInt32(o), 4];
        case 6: return [Number(dv.getBigUint64(o)), 8];
        case 7: return [Number(dv.getBigInt64(o)), 8];
        case 8: return [dv.getFloat32(o), 4];
        case 9: return [dv.getFloat64(o), 8];
        case 0xA: return [readStr(dv.getUint32(o)), 4];
        case 0xB: return [{ offset: dv.getUint32(o), size: dv.getUint32(o + 4) }, 8];
        default: throw new Error('@UTF type ' + type);
      }
    };
    const cols = []; let p = base + 24;
    for (let c = 0; c < columnCount; c++) {
      const flags = dv.getUint8(p); p += 1;
      const type = flags & 0x0f, storage = flags & 0xf0;
      const name = readStr(dv.getUint32(p)); p += 4;
      let constant = null;
      if (storage === STORAGE_CONSTANT) { const t = rd(type, p); constant = t[0]; p += t[1]; }
      cols.push({ name: name, type: type, storage: storage, constant: constant });
    }
    const rows = [];
    for (let r = 0; r < rowCount; r++) {
      const row = {}; let ro = base + rowsOffset + r * rowWidth;
      for (const col of cols) {
        if (col.storage === STORAGE_PERROW) { const t = rd(col.type, ro); row[col.name] = t[0]; ro += t[1]; }
        else if (col.storage === STORAGE_CONSTANT) row[col.name] = col.constant;
        else row[col.name] = 0;
      }
      rows.push(row);
    }
    return { rows: rows, columns: cols.map((c) => c.name) };
  }

  // make a self-contained ArrayBuffer from a Uint8Array view
  function ab(u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }

  // Read a CRI sub-chunk (CPK /TOC /…): magic(4) + u32 + u64 utfSize + @UTF block at +0x10.
  async function readChunk(read, pos) {
    const head = await read(pos, 0x10);
    const hv = new DataView(ab(head));
    const utfSize = Number(hv.getBigUint64(8, true));     // little-endian size
    let block = await read(pos + 0x10, utfSize);
    if (!(block[0] === 0x40 && block[1] === 0x55 && block[2] === 0x54 && block[3] === 0x46)) block = criXor(block);
    return parseUtf(ab(block));
  }

  const alignUp = (v, a) => (a > 1 ? Math.ceil(v / a) * a : v);

  // readToc(read) → { entries:[{name,offset,size,extractSize,compressed}], header, find(name) }.
  // `read(pos,len)` returns a Promise<Uint8Array> of that byte range (see fileReader).
  async function readToc(read) {
    const header = (await readChunk(read, 0)).rows[0];
    const tocOffset = header.TocOffset, contentOffset = header.ContentOffset, align = header.Align || 1;
    if (!tocOffset) throw new Error('CPK has no TOC (ITOC-only archives are not supported)');
    const baseOff = Math.min(contentOffset, tocOffset);
    const rows = (await readChunk(read, tocOffset)).rows;
    const entries = rows.map((r) => {
      const name = ((r.DirName ? r.DirName + '/' : '') + r.FileName).replace(/\\/g, '/');
      return { name: name, offset: alignUp(r.FileOffset + baseOff, align), size: r.FileSize, extractSize: r.ExtractSize, compressed: r.FileSize !== r.ExtractSize };
    });
    const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
    return {
      entries: entries, header: header,
      // exact path, else any entry ending in the given path (rom_steam/… prefixes vary)
      find: (n) => { const k = String(n).toLowerCase(); return byName.get(k) || entries.find((e) => e.name.toLowerCase().endsWith('/' + k)) || null; },
    };
  }

  let _key = null;
  async function aesKey() { if (!_key) _key = await subtle().importKey('raw', new Uint8Array(KEY), { name: 'AES-CBC' }, false, ['decrypt']); return _key; }

  // readEntry(read, entry) → Uint8Array of the decrypted file. Web Crypto AES-CBC
  // auto-strips the standard PKCS#7 padding. Throws on a (non-occurring) compressed entry.
  async function readEntry(read, entry) {
    if (!entry) throw new Error('no such entry');
    if (entry.compressed) throw new Error('compressed CPK entry not supported: ' + entry.name);
    const enc = await read(entry.offset, entry.size);
    const plain = await subtle().decrypt({ name: 'AES-CBC', iv: new Uint8Array(IV) }, await aesKey(), ab(enc));
    return new Uint8Array(plain);
  }

  // A range reader backed by a browser File/Blob (slices — never reads the whole file).
  function fileReader(file) {
    return (pos, len) => file.slice(pos, pos + len).arrayBuffer().then((b) => new Uint8Array(b));
  }

  const API = { parseUtf: parseUtf, criXor: criXor, readChunk: readChunk, readToc: readToc, readEntry: readEntry, fileReader: fileReader, KEY: KEY, IV: IV };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.Cpk = API;
})();
