'use strict';
// index.html ships a Content-Security-Policy <meta> without 'unsafe-inline' for scripts.
// Any inline <script> or on*= handler added to the page would be silently blocked by the
// browser, so these tests fail loudly instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);

function directive(name) {
  const part = cspMatch[1].split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' '));
  return part ? part.split(/\s+/).slice(1) : null;
}

test('index.html declares a CSP before any script runs', () => {
  assert.ok(cspMatch, 'CSP meta tag missing from index.html');
  const cspAt = html.indexOf(cspMatch[0]);
  const firstScript = html.search(/<script\b/);
  console.log('CSP meta at offset', cspAt, '; first <script> at offset', firstScript);
  assert.ok(firstScript === -1 || cspAt < firstScript, 'CSP must come before the first <script> or earlier scripts are not covered');
});

test('script-src forbids inline script and eval', () => {
  const scriptSrc = directive('script-src');
  console.log('script-src:', scriptSrc.join(' '));
  for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", '*', 'https:', 'data:']) {
    assert.ok(!scriptSrc.includes(forbidden), 'script-src must not allow ' + forbidden);
  }
  assert.deepEqual(directive('object-src'), ["'none'"]);
  assert.deepEqual(directive('base-uri'), ["'self'"]);
});

test('index.html has no inline <script> blocks (the CSP would block them)', () => {
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc=/.test(m[1]) && m[2].trim() !== '')
    .map((m) => 'line ' + html.slice(0, m.index).split('\n').length + ': ' + m[2].trim().slice(0, 60));
  console.log('inline scripts found:', inline);
  assert.deepEqual(inline, [], 'move inline scripts into a .js file');
});

test('index.html has no inline on*= event handler attributes (the CSP would block them)', () => {
  const handlers = [...html.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)]
    .map((m) => 'line ' + html.slice(0, m.index).split('\n').length + ': ' + m[1]);
  console.log('inline handlers found:', handlers);
  assert.deepEqual(handlers, [], 'use addEventListener instead of on*= attributes');
});

test('every <script src> in index.html is same-origin or an allowed script-src host', () => {
  const allowed = directive('script-src').filter((s) => s.startsWith('https://'));
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  console.log('script srcs:', srcs);
  for (const src of srcs) {
    if (!/^https?:\/\//.test(src)) {
      assert.ok(fs.existsSync(src.split('?')[0]), 'local script missing: ' + src);
      continue;
    }
    const host = new URL(src).origin;
    assert.ok(allowed.some((a) => a === host || (a.includes('*.') && host.endsWith(a.split('*')[1]))), src + ' is not allowed by script-src');
  }
});
