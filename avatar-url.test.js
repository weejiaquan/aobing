'use strict';
// activityImg (app.js) is the single place stored avatar URLs are turned into display URLs.
// It runs here exactly as written in app.js, sliced out and evaluated with the real
// KEI_BASE, on the normal web and inside the Discord Activity.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('app.js', 'utf8');
const keiBase = app.match(/const KEI_BASE = '([^']+)';/)[1];
const start = app.indexOf('    const DISCORD_AVATAR_URL');
const end = app.indexOf('\n    }', app.indexOf('function activityImg(url)', start)) + '\n    }'.length;

function loadActivityImg(activity) {
  assert.ok(start > 0 && end > start, 'activityImg not found in app.js');
  const context = vm.createContext({ window: { __ACTIVITY__: activity }, KEI_BASE: keiBase });
  vm.runInContext(app.slice(start, end) + '\nthis.activityImg = activityImg;', context);
  return context.activityImg;
}

const DISCORD_ID = '533899805680730113';
const STALE_DISCORD = 'https://cdn.discordapp.com/avatars/' + DISCORD_ID + '/1e9cbd83a1e9d53e0a74c983767c1dee.png';
const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c';

test('web: stored Discord avatar URLs point at the kei current-avatar redirect', () => {
  const activityImg = loadActivityImg(undefined);
  const out = activityImg(STALE_DISCORD);
  console.log(STALE_DISCORD, '->', out);
  assert.equal(out, keiBase + '/api/discord/avatar/' + DISCORD_ID);
});

test('web: non-Discord and empty URLs are unchanged', () => {
  const activityImg = loadActivityImg(undefined);
  for (const url of [GOOGLE, 'https://cdn.discordapp.com/embed/avatars/3.png', '', undefined]) {
    console.log(JSON.stringify(url), '->', JSON.stringify(activityImg(url)));
    assert.equal(activityImg(url), url);
  }
});

test('web: only real cdn.discordapp.com avatar paths with a snowflake id are rewritten', () => {
  const activityImg = loadActivityImg(undefined);
  for (const url of [
    'https://evil.example/cdn.discordapp.com/avatars/' + DISCORD_ID + '/x.png',
    'https://cdn.discordapp.com.evil.example/avatars/' + DISCORD_ID + '/x.png',
    'https://cdn.discordapp.com/avatars/123/x.png',
    'http://cdn.discordapp.com/avatars/' + DISCORD_ID + '/x.png',
  ]) {
    console.log(url, '->', activityImg(url));
    assert.equal(activityImg(url), url);
  }
});

test('Activity: Discord avatars go through the same-origin kei proxy path to the redirect', () => {
  const activityImg = loadActivityImg({ instanceId: 'i-1' });
  const out = activityImg(STALE_DISCORD);
  console.log(STALE_DISCORD, '->', out);
  assert.equal(out, '/.proxy/kei/api/discord/avatar/' + DISCORD_ID);
});

test('Activity: other external images still use the kei image proxy; Discord CDN stays direct', () => {
  const activityImg = loadActivityImg({ instanceId: 'i-1' });
  const google = activityImg(GOOGLE);
  const defaultDiscord = activityImg('https://cdn.discordapp.com/embed/avatars/3.png');
  console.log(GOOGLE, '->', google, '|', 'default avatar ->', defaultDiscord);
  assert.equal(google, '/.proxy/kei/api/img?url=' + encodeURIComponent(GOOGLE));
  assert.equal(defaultDiscord, 'https://cdn.discordapp.com/embed/avatars/3.png');
});
