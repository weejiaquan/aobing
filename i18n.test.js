'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const I18N = require('./i18n.js');

const PLACEHOLDER = /\{\w+\}/g;
// Keys built at runtime from data ids (I18N.t('character.' + id + '.name')), so the
// literal in the source is only a prefix and cannot be looked up as-is.
const DYNAMIC_PREFIXES = ['character.', 'skin.', 'tag.', 'stats.source.'];

function referencedKeys() {
  const keys = new Map(); // key -> where it came from
  const html = fs.readFileSync('index.html', 'utf8');
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) keys.set(match[1], 'index.html data-i18n');
  for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(',')) {
      const key = pair.slice(pair.indexOf(':') + 1).trim();
      keys.set(key, 'index.html data-i18n-attr');
    }
  }
  for (const file of ['app.js', 'game-shell.js', 'typing.js', 'ui-panels.js', 'multiplayer.js']) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:I18N\.t|[^.\w]t)\(\s*'([a-z][\w.]*)'/g)) {
      keys.set(match[1], file);
    }
  }
  return [...keys].filter(([key]) => !DYNAMIC_PREFIXES.includes(key));
}

test('i18n: every supported language has the exact English key set', () => {
  const english = Object.keys(I18N.T.en);
  assert.ok(english.length > 0, 'English dictionary must not be empty');
  for (const lang of I18N.SUPPORTED) {
    const dictionary = I18N.T[lang];
    assert.ok(dictionary, `missing dictionary for ${lang}`);
    const missing = english.filter((key) => dictionary[key] === undefined);
    const extra = Object.keys(dictionary).filter((key) => I18N.T.en[key] === undefined);
    assert.deepEqual(missing, [], `${lang} is missing ${missing.length} key(s): ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${lang} has ${extra.length} key(s) absent from English: ${extra.join(', ')}`);
    for (const key of english) {
      assert.equal(typeof dictionary[key], 'string', `${lang}.${key} must be a string`);
      assert.notEqual(dictionary[key].trim(), '', `${lang}.${key} must not be blank`);
    }
  }
});

test('i18n: translations keep the placeholders their English source uses', () => {
  for (const [key, english] of Object.entries(I18N.T.en)) {
    const expected = (english.match(PLACEHOLDER) || []).slice().sort();
    for (const lang of I18N.SUPPORTED) {
      const actual = (I18N.T[lang][key].match(PLACEHOLDER) || []).slice().sort();
      assert.deepEqual(actual, expected,
        `${lang}.${key} placeholders ${JSON.stringify(actual)} do not match English ${JSON.stringify(expected)}`);
    }
  }
});

test('i18n: every language has native-script label in the picker', () => {
  for (const lang of I18N.SUPPORTED) {
    assert.equal(typeof I18N.NATIVE[lang], 'string', `no native label for ${lang}`);
    assert.notEqual(I18N.NATIVE[lang].trim(), '', `native label for ${lang} is blank`);
  }
  assert.deepEqual(Object.keys(I18N.NATIVE).sort(), [...I18N.SUPPORTED].sort(),
    'NATIVE labels and SUPPORTED languages must cover the same codes');
});

test('i18n: t() interpolates every occurrence of each parameter', () => {
  I18N.T.en['test.interpolate'] = '{a} and {b}, then {a} again';
  try {
    assert.equal(I18N.t('test.interpolate', { a: 'one', b: 'two' }), 'one and two, then one again');
    assert.equal(I18N.t('test.interpolate', { a: 'x' }), 'x and {b}, then x again',
      'unsupplied parameters are left as-is so the gap is visible');
  } finally {
    delete I18N.T.en['test.interpolate'];
  }
});

test('i18n: real keys interpolate their documented parameters', () => {
  assert.equal(I18N.t('lobby.welcome_name', { name: 'Aoba' }), 'Aoba.');
  assert.equal(I18N.t('leaderboard.your_rank', { rank: 3, total: 40 }), 'Your rank: #3 of 40 players');
  assert.match(I18N.t('bond.count', { n: 2 }), /2/);
});

test('i18n: t() falls back to English, then to the key itself', () => {
  I18N.T.en['test.fallback'] = 'English only';
  try {
    I18N.set('ja');
    assert.equal(I18N.current, 'ja');
    assert.equal(I18N.t('test.fallback'), 'English only', 'untranslated keys fall back to English');
    assert.equal(I18N.t('test.no_such_key'), 'test.no_such_key', 'unknown keys return the key');
    assert.equal(I18N.t('settings.title'), I18N.T.ja['settings.title'], 'translated keys use the active language');
  } finally {
    delete I18N.T.en['test.fallback'];
    I18N.set('en');
  }
});

test('i18n: set() rejects unsupported languages and falls back to English', () => {
  try {
    I18N.set('de');
    assert.equal(I18N.current, 'en', 'unsupported language resolves to English');
    for (const lang of I18N.SUPPORTED) {
      I18N.set(lang);
      assert.equal(I18N.current, lang, `set('${lang}') must activate that language`);
    }
  } finally {
    I18N.set('en');
  }
});

test('i18n: detect() honours a saved choice and maps browser locales', () => {
  for (const lang of I18N.SUPPORTED) {
    assert.equal(I18N.detect(lang), lang, `saved choice ${lang} must win`);
  }
  const cases = {
    'ja-JP': 'ja', 'ko-KR': 'ko', 'th-TH': 'th', 'vi-VN': 'vi', 'ar-EG': 'ar',
    'zh-CN': 'zh-Hans', 'zh': 'zh-Hans', 'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant',
    'zh-Hant': 'zh-Hant', 'zh-Hans': 'zh-Hans', 'en-GB': 'en', 'de-DE': 'en',
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const [locale, expected] of Object.entries(cases)) {
      Object.defineProperty(globalThis, 'navigator', { value: { language: locale }, configurable: true });
      assert.equal(I18N.detect(undefined), expected, `navigator.language ${locale} must resolve to ${expected}`);
      assert.equal(I18N.detect('de'), expected, `an unsupported saved choice falls back to detection (${locale})`);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

test('i18n: every key referenced by the markup and game code exists', () => {
  const referenced = referencedKeys();
  assert.ok(referenced.length > 100, `expected the UI to reference many keys, found ${referenced.length}`);
  const missing = referenced.filter(([key]) => I18N.T.en[key] === undefined);
  assert.deepEqual(missing, [],
    'keys used by the UI but absent from the table:\n' +
    missing.map(([key, where]) => `  ${key} (${where})`).join('\n'));
});

test('i18n: the redesigned hub, boot and panel copy is translated everywhere', () => {
  // Guards the surfaces added with the game-hub redesign: a new English-only
  // string here would ship an untranslated lobby again.
  // Prose must read differently from English in every language; short names may
  // legitimately keep a Latin term (Vietnamese "Clicker", "Diva", ...).
  const prose = ['boot.enter', 'boot.loading', 'boot.error', 'lobby.welcome_back', 'lobby.welcome_sub',
    'lobby.tap_to_play', 'library.title', 'library.launch_title', 'library.card.clicker.desc',
    'library.footer_note', 'counter.clicks', 'settings.section.sound', 'settings.character_background',
    'skins.desc', 'shop.wallet', 'shop.kicker.clicker', 'shop.kicker.typing', 'shop.typing_hint',
    'modifiers.owned', 'typing.no_mods_owned', 'typing.always_active', 'typing.off_ranked',
    'profile.kicker', 'leaderboard.kicker', 'analytics.kicker',
    'sky.title', 'sky.device_time', 'sky.sunrise', 'sky.night', 'sky.local_time',
    'sky.tour', 'sky.tour_hint', 'mp.lobbies_title', 'mp.create_lobby', 'mp.leave',
    'mp.library_empty', 'mp.downloading', 'mp.saved', 'mp.offline'];
  const names = ['mp.title', 'mp.kicker', 'mode.clicker', 'mode.typing', 'mode.osu', 'mode.mania',
    'mode.diva', 'mode.casual', 'mode.ranked', 'mode.fishing', 'library.tag.rhythm'];
  for (const key of prose.concat(names)) {
    assert.notEqual(I18N.T.en[key], undefined, `${key} must exist in English`);
    for (const lang of I18N.SUPPORTED.filter((l) => l !== 'en')) {
      assert.notEqual(I18N.T[lang][key], undefined, `${key} must be translated for ${lang}`);
      if (prose.includes(key)) {
        assert.notEqual(I18N.T[lang][key], I18N.T.en[key], `${lang}.${key} is still the English string`);
      }
    }
  }
});
