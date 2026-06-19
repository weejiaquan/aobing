'use strict';
// Tests for the pv_db text parser. Committed tests use a synthetic DB excerpt
// (the real layout, no copyrighted song data); a guarded block parses the user's
// real mod_pv_db.txt when present (gitignored). Run: `node --test divapvdb.test.js`
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('./divapvdb.js');

const SAMPLE = [
  '# a comment line',
  '',
  'pv_0999.song_name=テスト',
  'pv_0999.song_name_en=Test Song',
  'pv_0999.song_file_name=rom/sound/song/pv_0999.ogg',
  'pv_0999.bpm=160',
  'pv_0999.songinfo.music=Composer X',
  'pv_0999.difficulty.easy.0.script_file_name=rom/script/pv_0999_easy.dsc',
  'pv_0999.difficulty.easy.0.level=PV_LV_03_0',
  'pv_0999.difficulty.extreme.0.script_file_name=rom/script/pv_0999_extreme.dsc',
  'pv_0999.difficulty.extreme.0.level=PV_LV_09_5',
  'pv_0888.song_name=日本語のみ',          // JP-only title → falls back to JP
  'pv_0888.bpm=200',
  'pv_0888.difficulty.hard.0.script_file_name=rom/script/pv_0888_hard.dsc',
  'pv_0888.difficulty.hard.0.level=PV_LV_06_5',
].join('\n');

test('parse: fields, English title, bpm, audio, artist, difficulties', () => {
  const songs = P.parse(SAMPLE);
  assert.equal(songs.length, 2);
  const s = songs.find((x) => x.id === 'pv_0999');
  assert.equal(s.title, 'Test Song');
  assert.equal(s.titleJp, 'テスト');
  assert.equal(s.bpm, 160);
  assert.equal(s.audio, 'rom/sound/song/pv_0999.ogg');
  assert.equal(s.artist, 'Composer X');
  assert.equal(s.diffs.easy.script, 'rom/script/pv_0999_easy.dsc');
  assert.equal(s.diffs.easy.stars, 3.0);
  assert.equal(s.diffs.extreme.stars, 9.5);
});

test('parse: JP-only song falls back to the JP title', () => {
  const s = P.parse(SAMPLE).find((x) => x.id === 'pv_0888');
  assert.equal(s.title, '日本語のみ');
  assert.equal(s.diffs.hard.stars, 6.5);
});

test('levelToStars: PV_LV parsing', () => {
  assert.equal(P._levelToStars('PV_LV_07_5'), 7.5);
  assert.equal(P._levelToStars('PV_LV_03_0'), 3.0);
  assert.equal(P._levelToStars('PV_LV_10_0'), 10.0);
  assert.equal(P._levelToStars('garbage'), null);
});

test('playableDiffs: ordered, only those with a script', () => {
  const s = P.parse(SAMPLE).find((x) => x.id === 'pv_0999');
  assert.deepEqual(P.playableDiffs(s), ['easy', 'extreme']);   // easy(0) before extreme(3)
});

test('parse: ignores comments and malformed lines', () => {
  const songs = P.parse('# c\nnonsense\npv_1.song_name_en=A\npv_1.difficulty.hard.0.script_file_name=x.dsc');
  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, 'A');
});

// --- guarded: parse the user's real mod_pv_db.txt when present ------------------
const FIX = path.join(__dirname, 'test', 'fixtures', 'divaft', 'mod_pv_db.txt');
test('parse: real mod_pv_db.txt (skipped if absent)', { skip: fs.existsSync(FIX) ? false : 'no local fixture' }, () => {
  const songs = P.parse(fs.readFileSync(FIX, 'utf8'));
  assert.ok(songs.length >= 1, 'found songs');
  const withChart = songs.filter((s) => P.playableDiffs(s).length > 0);
  assert.ok(withChart.length >= 1, 'at least one song has a playable difficulty');
  for (const s of withChart) {
    assert.ok(s.title, s.id + ' has a title');
    for (const d of P.playableDiffs(s)) assert.ok(/\.dsc$/.test(s.diffs[d].script), s.id + '/' + d + ' script path');
  }
});
