'use strict';

// Unit tests for the PURE layer exported by presence.js.
// Run: `node --test presence.test.js`
// No DOM, no Firebase, no Discord SDK — the exported layer is framework-agnostic.
// Tests are intentionally verbose so failures double as debugging output.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('./presence.js');
const { resolveLeaderboardPhoto, photoOptionsFor, mergeParticipants } = P;

// =========================================================================
// resolveLeaderboardPhoto(profile)
// =========================================================================
test('resolveLeaderboardPhoto: default (no pref) → google photoURL', () => {
  assert.equal(
    resolveLeaderboardPhoto({ photoURL: 'g.png', discordPhotoURL: 'd.png' }),
    'g.png'
  );
});

test("resolveLeaderboardPhoto: 'google' → photoURL", () => {
  assert.equal(
    resolveLeaderboardPhoto({ leaderboardPhoto: 'google', photoURL: 'g.png', discordPhotoURL: 'd.png' }),
    'g.png'
  );
});

test("resolveLeaderboardPhoto: 'discord' → discordPhotoURL", () => {
  assert.equal(
    resolveLeaderboardPhoto({ leaderboardPhoto: 'discord', photoURL: 'g.png', discordPhotoURL: 'd.png' }),
    'd.png'
  );
});

test("resolveLeaderboardPhoto: 'discord' but no discordPhotoURL → '' (placeholder, never undefined)", () => {
  assert.equal(
    resolveLeaderboardPhoto({ leaderboardPhoto: 'discord', photoURL: 'g.png' }),
    ''
  );
});

test("resolveLeaderboardPhoto: 'none' → '' even when photos exist (hidden)", () => {
  assert.equal(
    resolveLeaderboardPhoto({ leaderboardPhoto: 'none', photoURL: 'g.png', discordPhotoURL: 'd.png' }),
    ''
  );
});

test('resolveLeaderboardPhoto: missing photoURL on google → empty string', () => {
  assert.equal(resolveLeaderboardPhoto({ leaderboardPhoto: 'google' }), '');
});

test('resolveLeaderboardPhoto: null/undefined profile → empty string', () => {
  assert.equal(resolveLeaderboardPhoto(null), '');
  assert.equal(resolveLeaderboardPhoto(undefined), '');
});

// =========================================================================
// photoOptionsFor(identity) — 'none' is ALWAYS last and ALWAYS present.
// =========================================================================
test('photoOptionsFor: linked (google+discord) → [google, discord, none]', () => {
  assert.deepEqual(photoOptionsFor({ hasGoogle: true, hasDiscord: true }), ['google', 'discord', 'none']);
});

test('photoOptionsFor: google-only → [google, none]', () => {
  assert.deepEqual(photoOptionsFor({ hasGoogle: true, hasDiscord: false }), ['google', 'none']);
});

test('photoOptionsFor: discord-only → [discord, none]', () => {
  assert.deepEqual(photoOptionsFor({ hasGoogle: false, hasDiscord: true }), ['discord', 'none']);
});

test('photoOptionsFor: neither identity → [none] (hide always offered)', () => {
  assert.deepEqual(photoOptionsFor({ hasGoogle: false, hasDiscord: false }), ['none']);
  assert.deepEqual(photoOptionsFor(null), ['none']);
});

// =========================================================================
// mergeParticipants(roster, nodes, selfDiscordId)
// =========================================================================
const ROSTER = [
  { discordId: '1', username: 'Aoba', avatarURL: 'a.png' },
  { discordId: '2', username: 'Mari', avatarURL: 'm.png' },
  { discordId: '3', username: 'Miyu', avatarURL: 'y.png' },
];
const NODES = {
  '1': { name: 'AobaGame', photoURL: 'ag.png', totalClicks: 1234, sessionClicks: 56 },
  '2': { name: 'MariGame', photoURL: 'mg.png', totalClicks: 8901, sessionClicks: 12 },
  '3': { name: 'MiyuGame', photoURL: 'yg.png', totalClicks: 12000, sessionClicks: 203 },
};

test('mergeParticipants: sorts by sessionClicks descending', () => {
  const rows = mergeParticipants(ROSTER, NODES, '1');
  assert.deepEqual(rows.map((r) => r.username), ['Miyu', 'Aoba', 'Mari']);
  assert.deepEqual(rows.map((r) => r.sessionClicks), [203, 56, 12]);
});

test('mergeParticipants: tags self by discordId, merges identity + game state', () => {
  const rows = mergeParticipants(ROSTER, NODES, '1');
  const me = rows.find((r) => r.isSelf);
  assert.equal(me.discordId, '1');
  assert.equal(me.username, 'Aoba');        // Discord identity from roster
  assert.equal(me.name, 'AobaGame');         // in-game identity from RTDB node
  assert.equal(me.totalClicks, 1234);
  assert.equal(me.sessionClicks, 56);
  assert.equal(me.hasGame, true);
  assert.equal(rows.filter((r) => r.isSelf).length, 1);
});

test('mergeParticipants: self wins a sessionClicks tie', () => {
  const roster = [
    { discordId: '1', username: 'Aoba', avatarURL: '' },
    { discordId: '2', username: 'Mari', avatarURL: '' },
  ];
  const nodes = {
    '1': { name: 'A', totalClicks: 5, sessionClicks: 10 },
    '2': { name: 'M', totalClicks: 5, sessionClicks: 10 },
  };
  const rows = mergeParticipants(roster, nodes, '2');
  assert.equal(rows[0].discordId, '2');
  assert.equal(rows[0].isSelf, true);
});

test('mergeParticipants: roster entry with no RTDB node → hasGame false, zeros, no row2 data', () => {
  const rows = mergeParticipants(ROSTER, { '1': NODES['1'] }, '1');
  const mari = rows.find((r) => r.username === 'Mari');
  assert.equal(mari.hasGame, false);
  assert.equal(mari.name, '');
  assert.equal(mari.totalClicks, 0);
  assert.equal(mari.sessionClicks, 0);
});

test('mergeParticipants: orphan node (in RTDB, absent from roster) is still shown', () => {
  // Roster unavailable / mid-sync: only RTDB knows about player 9.
  const rows = mergeParticipants([], { '9': { name: 'Ghost', photoURL: 'gh.png', totalClicks: 7, sessionClicks: 3 } }, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discordId, '9');
  assert.equal(rows[0].username, 'Ghost');   // synthesised from the game node's name
  assert.equal(rows[0].avatarURL, 'gh.png');
  assert.equal(rows[0].hasGame, true);
  assert.equal(rows[0].sessionClicks, 3);
});

test('mergeParticipants: roster + an extra orphan node coexist without duplication', () => {
  const nodes = Object.assign({}, NODES, { '9': { name: 'Ghost', totalClicks: 1, sessionClicks: 999 } });
  const rows = mergeParticipants(ROSTER, nodes, '1');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].username, 'Ghost');  // 999 session clicks → top
  // no discordId appears twice
  const ids = rows.map((r) => r.discordId).sort();
  assert.deepEqual(ids, ['1', '2', '3', '9']);
});

test('mergeParticipants: numeric vs string selfDiscordId both match', () => {
  assert.equal(mergeParticipants(ROSTER, NODES, 1).find((r) => r.isSelf).discordId, '1');
  assert.equal(mergeParticipants(ROSTER, NODES, '1').find((r) => r.isSelf).discordId, '1');
});

test('mergeParticipants: empty inputs → empty array, no throw', () => {
  assert.deepEqual(mergeParticipants(null, null, null), []);
  assert.deepEqual(mergeParticipants([], {}, '1'), []);
});
