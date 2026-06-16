'use strict';

// Unit tests for the PURE layer exported by presence.js.
// Run: `node --test presence.test.js`
// No DOM, no Firebase, no Discord SDK — the exported layer is framework-agnostic.
// Tests are intentionally verbose so failures double as debugging output.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('./presence.js');
const { resolveLeaderboardPhoto, photoOptionsFor, buildRows } = P;

// =========================================================================
// resolveLeaderboardPhoto(profile)
// =========================================================================
test('resolveLeaderboardPhoto: default (no pref) → google photoURL', () => {
  assert.equal(resolveLeaderboardPhoto({ photoURL: 'g.png', discordPhotoURL: 'd.png' }), 'g.png');
});

test("resolveLeaderboardPhoto: 'discord' → discordPhotoURL", () => {
  assert.equal(
    resolveLeaderboardPhoto({ leaderboardPhoto: 'discord', photoURL: 'g.png', discordPhotoURL: 'd.png' }),
    'd.png'
  );
});

test("resolveLeaderboardPhoto: 'discord' but no discordPhotoURL → '' (never undefined)", () => {
  assert.equal(resolveLeaderboardPhoto({ leaderboardPhoto: 'discord', photoURL: 'g.png' }), '');
});

test("resolveLeaderboardPhoto: 'none' → '' even when photos exist (hidden)", () => {
  assert.equal(
    resolveLeaderboardPhoto({ leaderboardPhoto: 'none', photoURL: 'g.png', discordPhotoURL: 'd.png' }),
    ''
  );
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

test('photoOptionsFor: neither → [none] (hide always offered)', () => {
  assert.deepEqual(photoOptionsFor({ hasGoogle: false, hasDiscord: false }), ['none']);
  assert.deepEqual(photoOptionsFor(null), ['none']);
});

// =========================================================================
// buildRows(nodes, selfDiscordId) — pure-RTDB participant rows
// =========================================================================
// Keyed by uid; each node carries its own Discord identity + in-game identity.
const NODES = {
  ua: { discordId: '1', discordName: 'Aoba', discordPhotoURL: 'a.png', name: 'AobaGame', photoURL: 'ag.png', totalClicks: 1234, sessionClicks: 56, active: true },
  ub: { discordId: '2', discordName: 'Mari', discordPhotoURL: 'm.png', name: 'MariGame', photoURL: 'mg.png', totalClicks: 8901, sessionClicks: 12, active: true },
  uc: { discordId: '3', discordName: 'Miyu', discordPhotoURL: 'y.png', name: 'MiyuGame', photoURL: 'yg.png', totalClicks: 12000, sessionClicks: 203, active: true },
};

test('buildRows: active members sorted by sessionClicks desc', () => {
  const rows = buildRows(NODES, '1');
  assert.deepEqual(rows.map((r) => r.discordName), ['Miyu', 'Aoba', 'Mari']);
  assert.deepEqual(rows.map((r) => r.sessionClicks), [203, 56, 12]);
});

test('buildRows: self tagged by discordId; carries both identities', () => {
  const rows = buildRows(NODES, '1');
  const me = rows.find((r) => r.isSelf);
  assert.equal(me.discordId, '1');
  assert.equal(me.discordName, 'Aoba');   // row 1 (Discord)
  assert.equal(me.name, 'AobaGame');       // row 2 (in-game)
  assert.equal(me.totalClicks, 1234);
  assert.equal(me.sessionClicks, 56);
  assert.equal(me.active, true);
  assert.equal(rows.filter((r) => r.isSelf).length, 1);
});

test('buildRows: self wins a sessionClicks tie among active members', () => {
  const nodes = {
    ua: { discordId: '1', discordName: 'A', sessionClicks: 10, active: true },
    ub: { discordId: '2', discordName: 'M', sessionClicks: 10, active: true },
  };
  const rows = buildRows(nodes, '2');
  assert.equal(rows[0].discordId, '2');
  assert.equal(rows[0].isSelf, true);
});

test('buildRows: left members sort BELOW all active, most-recently-left first', () => {
  const nodes = {
    ua: { discordId: '1', discordName: 'Active', sessionClicks: 5, active: true },
    ub: { discordId: '2', discordName: 'LeftEarly', sessionClicks: 999, active: false, leftAt: 100 },
    uc: { discordId: '3', discordName: 'LeftLate', sessionClicks: 1, active: false, leftAt: 500 },
  };
  const rows = buildRows(nodes, '1');
  // Active always first (even though LeftEarly has way more session clicks).
  assert.equal(rows[0].discordName, 'Active');
  assert.equal(rows[0].active, true);
  // Then left members, most recent departure first.
  assert.deepEqual(rows.slice(1).map((r) => r.discordName), ['LeftLate', 'LeftEarly']);
  assert.equal(rows[1].active, false);
});

test('buildRows: missing `active` field counts as active (backward compatible)', () => {
  const nodes = { ua: { discordId: '1', discordName: 'Old', sessionClicks: 3 } };
  const rows = buildRows(nodes, null);
  assert.equal(rows[0].active, true);
});

test('buildRows: falls back to in-game name when no Discord name present', () => {
  const nodes = { ua: { discordId: '9', name: 'JustGame', sessionClicks: 1, active: true } };
  const rows = buildRows(nodes, null);
  assert.equal(rows[0].discordName, '');
  assert.equal(rows[0].name, 'JustGame');
});

test('buildRows: numeric vs string selfDiscordId both match', () => {
  assert.equal(buildRows(NODES, 1).find((r) => r.isSelf).discordId, '1');
  assert.equal(buildRows(NODES, '1').find((r) => r.isSelf).discordId, '1');
});

test('buildRows: empty/missing nodes → empty array, no throw', () => {
  assert.deepEqual(buildRows(null, null), []);
  assert.deepEqual(buildRows({}, '1'), []);
});
