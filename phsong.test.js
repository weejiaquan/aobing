'use strict';
// Tests for the Project Heartbeat song parser. Committed tests use synthetic PH JSON
// (the real schema, no copyrighted song data); a guarded block parses a real local PH
// song when present (gitignored). Run: `node --test phsong.test.js`
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PH = require('./phsong.js');
const E = require('./divaft.js');

test('youtubeId: pulls the id from every URL form', () => {
  assert.equal(PH.youtubeId('https://youtu.be/7zP-rlQJ5Pc'), '7zP-rlQJ5Pc');
  assert.equal(PH.youtubeId('https://www.youtube.com/watch?v=iSJL0dhDR-Q&t=3'), 'iSJL0dhDR-Q');
  assert.equal(PH.youtubeId('https://youtube.com/shorts/E0wpY8fgTWk'), 'E0wpY8fgTWk');
  assert.equal(PH.youtubeId(''), '');
});

test('parseSong: manifest fields + youtube id', () => {
  const s = PH.parseSong(JSON.stringify({
    title: 'Test PH ', artist: 'Composer', bpm: 155, youtube_url: 'https://youtu.be/7zP-rlQJ5Pc',
    charts: { hard: { file: 'hard.json', stars: 9 }, extreme: { file: 'extreme.json', stars: 10 } },
  }));
  assert.equal(s.title, 'Test PH');           // trimmed
  assert.equal(s.bpm, 155);
  assert.equal(s.youtubeId, '7zP-rlQJ5Pc');
  assert.deepEqual(Object.keys(s.charts), ['hard', 'extreme']);
  assert.equal(s.charts.hard.file, 'hard.json');
  assert.equal(s.charts.hard.stars, 9);
});

test('parsePosition: "Vector2( x, y )" string and object', () => {
  assert.deepEqual(PH._parsePosition('Vector2( 720, 552 )'), { x: 720, y: 552 });
  assert.deepEqual(PH._parsePosition('Vector2( 735.749, 457.762 )'), { x: 735.749, y: 457.762 });
  assert.deepEqual(PH._parsePosition({ x: 100, y: 200 }), { x: 100, y: 200 });
});

test('parseChart: note types → buttons, position normalised, flyTime = 4 beats', () => {
  const chart = {
    layers: [{
      timing_points: [
        { time: 1000, position: 'Vector2( 960, 540 )', note_type: 0, entry_angle: 270, oscillation_frequency: -2, type: 'Note' },  // UP → triangle, centre
        { time: 1200, position: 'Vector2( 1920, 1080 )', note_type: 3, entry_angle: 90, oscillation_frequency: 2, type: 'Note' },   // RIGHT → circle
        { time: 1400, position: 'Vector2( 0, 0 )', note_type: 1, entry_angle: 0, oscillation_frequency: 0, type: 'Note' },          // LEFT → square
        { time: 1600, position: 'Vector2( 480, 270 )', note_type: 2, entry_angle: 0, oscillation_frequency: 0, type: 'Note' },      // DOWN → cross
        { time: 5000, position: 'Vector2( 0, 0 )', note_type: 0, type: 'PerSongEditorSettings' },                                    // not a Note → ignored
      ],
    }],
  };
  const r = PH.parseChart(chart, 120);
  assert.equal(r.notes.length, 4);
  assert.deepEqual(r.notes.map((n) => n.button), ['triangle', 'circle', 'square', 'cross']);
  assert.ok(Math.abs(r.notes[0].x - 0.5) < 1e-9 && Math.abs(r.notes[0].y - 0.5) < 1e-9);
  assert.equal(r.notes[1].x, 1); assert.equal(r.notes[1].y, 1);
  assert.equal(r.notes[0].flyTime, 2000);   // 60000/120*4
  assert.equal(r.notes[0].frequency, -2);
});

test('parseChart: slide chain pieces share a slideChain id; flattens + sorts layers', () => {
  const chart = {
    layers: [
      { timing_points: [{ time: 200, position: 'Vector2(0,0)', note_type: 5, type: 'Note' }, { time: 300, position: 'Vector2(0,0)', note_type: 7, type: 'Note' }, { time: 400, position: 'Vector2(0,0)', note_type: 7, type: 'Note' }] },
      { timing_points: [{ time: 100, position: 'Vector2(0,0)', note_type: 0, type: 'Note' }] },   // earlier, different layer
    ],
  };
  const ns = PH.parseChart(chart, 160).notes;
  assert.equal(ns[0].time, 100);                  // sorted across layers
  assert.equal(ns[0].button, 'triangle');
  assert.equal(ns[1].button, 'slideR');           // 5 SLIDE_RIGHT
  assert.equal(ns[1].slideChain, ns[2].slideChain);  // 5 → 7 → 7 share a chain
  assert.equal(ns[2].slideChain, ns[3].slideChain);
});

test('parseChart output assembles into a playable Diva chart', () => {
  const chart = { layers: [{ timing_points: [
    { time: 1000, position: 'Vector2( 500, 500 )', note_type: 0, type: 'Note' },
    { time: 1000, position: 'Vector2( 1400, 500 )', note_type: 3, type: 'Note' },   // same time → a double
    { time: 2000, position: 'Vector2( 900, 600 )', note_type: 2, type: 'Note' },
  ] }] };
  const ch = E.assembleChart(Object.assign({ title: 'X', bpm: 150, audioFile: 'a.ogg' }, PH.parseChart(chart, 150)));
  assert.equal(ch.notes.length, 3);
  assert.equal(ch.notes[0].groupId, ch.notes[1].groupId);   // the two time=1000 notes group
  assert.notEqual(ch.notes[0].groupId, null);
});

// --- guarded: parse a real local PH song when present --------------------------
const FIX = path.join(__dirname, 'test', 'fixtures', 'divaft', 'ph');
const hasReal = fs.existsSync(path.join(FIX, 'song.json'));
test('parse a real PH song (skipped if fixture absent)', { skip: hasReal ? false : 'no local fixture' }, () => {
  const song = PH.parseSong(fs.readFileSync(path.join(FIX, 'song.json'), 'utf8'));
  assert.ok(song.title, 'has a title');
  assert.ok(Object.keys(song.charts).length >= 1, 'has a chart');
  for (const d in song.charts) {
    const cf = path.join(FIX, song.charts[d].file);
    if (!fs.existsSync(cf)) continue;
    const r = PH.parseChart(fs.readFileSync(cf, 'utf8'), song.bpm);
    assert.ok(r.notes.length > 50, d + ' has many notes');
    assert.ok(r.notes.every((n, i, a) => i === 0 || n.time >= a[i - 1].time), d + ' time-sorted');
    const buttons = new Set(r.notes.map((n) => n.button));
    assert.ok(buttons.size >= 2, d + ' has a mix of buttons');
    const ch = E.assembleChart(Object.assign({ title: song.title, bpm: song.bpm, audioFile: 'a.ogg' }, r));
    assert.ok(ch.stars > 0);
  }
});
