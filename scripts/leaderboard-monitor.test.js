'use strict';
// Proves the detector catches the real attack and, just as importantly, does NOT
// fire on legitimate data (names with quotes, hearts, non-Latin scripts, real
// Google avatars). A monitor that cries wolf gets muted, so the no-false-positive
// cases are first-class tests, not afterthoughts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanRow, scanBoard } = require('./leaderboard-monitor');

// The exact value pulled from the poisoned leaderboard row on 2026-11-22.
const REAL_PAYLOAD =
  'https://lh3.googleusercontent.com/a/default-user" onload="if(!window.__zz){document.documentElement.innerHTML=\'<iframe src=https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1 allow=autoplay></iframe>\'}" x="';

test('flags the real Nov-2026 photoURL XSS payload', () => {
  const f = scanRow('leaderboard/topClicks', 'X90S1GZS60QwHT9wnKZUMA5Ix4E2',
    { name: 'Desmond Tan', country: 'SG', photoURL: REAL_PAYLOAD, totalClicks: 0 });
  console.log('findings:', f.map(x => `${x.field}: ${x.reason}`));
  assert.ok(f.some(x => x.field === 'photoURL'), 'the payload photoURL must be flagged');
});

test('does NOT flag legitimate rows (punctuation names, real avatars, non-Latin)', () => {
  const f = scanBoard('leaderboard/topClicks', {
    a: { name: "O'Brien", country: 'IE', photoURL: 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c', totalClicks: 5 },
    b: { name: 'Søren <3 clicking', country: 'NO', photoURL: '', totalClicks: 9 },
    c: { name: 'あおば "the best"', country: 'JP', totalClicks: 3 },
    d: { name: 'Jean-Luc & co', country: 'FR', photoURL: 'https://cdn.discordapp.com/avatars/1/a.png', totalClicks: 1 },
  });
  console.log('false positives:', f);
  assert.deepEqual(f, [], 'legitimate rows must not be flagged');
});

test('flags tag/handler/scheme injections in any string field', () => {
  const cases = [
    { name: '<svg onload=alert(1)>' },
    { name: '" onmouseover=alert(1) x="' },
    { name: 'javascript:alert(document.domain)' },
    { country: '<img src=x onerror=alert(1)>' },
  ];
  for (const row of cases) {
    const f = scanRow('b', 'u', row);
    console.log(JSON.stringify(row), '->', f.length, 'finding(s)');
    assert.ok(f.length > 0, 'should flag: ' + JSON.stringify(row));
  }
});

test('flags scanner markers (Dalfox dlx/xld, XSStrike v3dm0s)', () => {
  for (const v of ['<svg onload=alert(1) class=dlx1a2b3c4d>', 'prefix xld9f8e7d6 suffix', 'alert(v3dm0s)']) {
    const f = scanRow('b', 'u', { name: v });
    console.log(v, '->', f.length);
    assert.ok(f.length > 0, 'should flag scanner marker: ' + v);
  }
});

test('flags a non-https or broken photoURL even without obvious HTML', () => {
  for (const url of ['http://cdn.discordapp.com/avatars/1/a.png', 'https://x/a.png?q=<', 'data:text/html,hi', 'https://x/a b.png']) {
    const f = scanRow('b', 'u', { photoURL: url });
    console.log(url, '->', f.length);
    assert.ok(f.length > 0, 'should flag bad photoURL: ' + url);
  }
});

// --- kei-bot owner alert ------------------------------------------------------
// A real local HTTP server stands in for kei-bot's /internal/notify, so these tests
// exercise the actual fetch, headers and body the monitor sends.
const http = require('node:http');
const { formatAlert, notifyKei } = require('./leaderboard-monitor');

function finding(i) {
  return { board: 'leaderboard/topClicks', uid: `uid${i}`, field: 'photoURL',
           reason: 'photoURL is not a clean https URL', value: `https://x/a.png" onload="alert(${i})` };
}

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('notifyKei sends the secret header and a bounded alert body', async () => {
  let seen;
  const server = await listen((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen = { method: req.method, secret: req.headers['x-internal-secret'], body: JSON.parse(raw) };
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"id":1}');
    });
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/internal/notify`;
    const status = await notifyKei(Array.from({ length: 40 }, (_, i) => finding(i)), { url, secret: 's3cret' });
    console.log('status', status, 'kind', seen.body.kind, 'text length', seen.body.text.length);
    assert.equal(status, 202);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.secret, 's3cret');
    assert.equal(seen.body.kind, 'leaderboard-injection');
    assert.ok(seen.body.text.includes('leaderboard/topClicks/uid0'), 'names the poisoned row');
    assert.ok(seen.body.text.length <= 1800, 'fits kei-bot\'s 1800-char limit');
  } finally { server.close(); }
});

test('notifyKei swallows an unreachable endpoint', async () => {
  const server = await listen(() => {});
  const port = server.address().port;
  await new Promise(r => server.close(r));  // the port is now closed
  const status = await notifyKei([finding(1)], { url: `http://127.0.0.1:${port}/internal/notify`, secret: 's' });
  console.log('unreachable ->', status);
  assert.equal(status, null);
});

test('notifyKei reports a rejected secret without throwing', async () => {
  const server = await listen((req, res) => { req.resume(); res.writeHead(401).end('{"detail":"Bad internal secret."}'); });
  try {
    const status = await notifyKei([finding(1)], { url: `http://127.0.0.1:${server.address().port}/`, secret: 'wrong' });
    console.log('wrong secret ->', status);
    assert.equal(status, 401);
  } finally { server.close(); }
});

test('formatAlert lists at most 10 findings and the total count', () => {
  const text = formatAlert(Array.from({ length: 15 }, (_, i) => finding(i)));
  const bullets = text.split('\n').filter(line => line.startsWith('•'));
  console.log(text.split('\n')[0], '| bullets:', bullets.length);
  assert.equal(bullets.length, 10);
  assert.ok(text.includes('15 suspicious value(s)'));
});
