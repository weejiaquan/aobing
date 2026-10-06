'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(reduce = false) {
  const timers = new Map(), running = [], events = {}, documentEvents = {};
  let timerId = 0, focused = null;
  const media = {matches: reduce, addEventListener(_, fn) { this.change = fn; }};
  class Element {
    constructor(hidden = true) {
      this.hidden = hidden; this.inert = hidden; this.children = []; this.attributes = {};
      const classes = new Set();
      this.classList = {add: s => classes.add(s), remove: s => classes.delete(s), contains: s => classes.has(s)};
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    querySelectorAll() { return this.children; }
    querySelector() { return null; }
    focus() { focused = this; }
    animate(frames, options) {
      let resolve, reject;
      const animation = {frames, options, cancelled: false,
        finished: new Promise((a,b) => { resolve = a; reject = b; }),
        finish() { resolve(); }, cancel() { this.cancelled = true; reject(new Error('cancelled')); }};
      running.push(animation); return animation;
    }
  }
  const document = {hidden: false, querySelector() { return null; }, addEventListener(k, fn) { documentEvents[k] = fn; }};
  const window = {addEventListener(k, fn) { events[k] = fn; }};
  vm.runInNewContext(fs.readFileSync('ui-motion.js', 'utf8'), {window, document, matchMedia: () => media,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }});
  const screens = {select: new Element(false), game: new Element(), results: new Element(), calib: new Element()};
  screens.results.children = [new Element(), new Element(), new Element()];
  const panel = new Element(false);
  return {screens, panel, timers, running, media, document, events, documentEvents,
    show: name => window.UIMotion.showScreen(panel, screens, name), clear: () => window.UIMotion.clear(panel),
    get focused() { return focused; },
    flush() { [...timers.values()].forEach(fn => fn()); },
  };
}

test('gameplay and calibration activate synchronously without animation or input delay', () => {
  const f = fixture();
  f.show('game');
  assert.equal(f.screens.game.hidden, false);
  assert.equal(f.screens.game.inert, false);
  assert.equal(f.screens.select.inert, true);
  assert.equal(f.running.length, 0);
  assert.equal(f.timers.size, 0);
  f.show('calib');
  assert.equal(f.screens.calib.inert, false);
  assert.equal(f.running.length, 0);
});

test('round end blocks outgoing input, reveals results, then restores interaction and focus', async () => {
  const f = fixture(); f.show('game'); f.show('results');
  assert.equal(f.screens.game.hidden, true);
  assert.equal(f.screens.game.inert, true);
  assert.equal(f.screens.game.attributes['aria-hidden'], 'true');
  assert.equal(f.screens.results.hidden, false);
  assert.equal(f.screens.results.inert, true);
  assert.equal(f.screens.game.classList.contains('ui-screen-leaving'), true);
  f.running.forEach(a => a.finish()); await Promise.resolve();
  assert.equal(f.screens.results.inert, false);
  assert.equal(f.focused, f.screens.results);
  f.flush();
  assert.equal(f.screens.game.classList.contains('ui-screen-leaving'), false);
  assert.equal(f.timers.size, 0);
});

test('rapid Retry cancels the old result reveal without stale focus or input locks', async () => {
  const f = fixture(); f.show('game'); f.show('results');
  const oldTimers = [...f.timers.values()];
  f.running.forEach(a => a.finish());
  f.show('game');
  await Promise.resolve();
  // Even callbacks already queued before cancellation cannot steal focus.
  assert.equal(f.focused, null);
  assert.equal(f.screens.game.inert, false);
  assert.equal(f.screens.results.inert, true);
  assert.equal(f.screens.game.classList.contains('ui-screen-leaving'), false);
  assert.equal(f.timers.size, 0);
  assert.ok(f.running.every(a => a.cancelled));
  assert.equal(oldTimers.length, 1);
});

for (const cause of ['reduced motion', 'page hidden', 'mode exit', 'panel close']) {
  test(cause + ' cancels pending motion and releases incoming controls', () => {
    const f = fixture(); f.show('game'); f.show('results');
    if (cause === 'reduced motion') { f.media.matches = true; f.media.change(); }
    if (cause === 'page hidden') { f.document.hidden = true; f.documentEvents.visibilitychange(); }
    if (cause === 'mode exit') f.events.gamemodechange();
    if (cause === 'panel close') f.clear();
    assert.equal(f.timers.size, 0);
    assert.equal(f.screens.results.inert, false);
    assert.ok(f.running.every(a => a.cancelled));
    assert.equal(f.screens.game.classList.contains('ui-screen-leaving'), false);
  });
}

test('reduced motion uses the same screen and accessibility state with no timer', () => {
  const f = fixture(true); f.show('game'); f.show('results');
  assert.equal(f.screens.game.hidden, true);
  assert.equal(f.screens.results.hidden, false);
  assert.equal(f.screens.results.inert, false);
  assert.equal(f.running.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.focused, f.screens.results);
});

test('repeated menu changes keep a single cleanup and return to a usable selection', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) { f.show('game'); f.show('results'); f.show('select'); }
  assert.equal(f.timers.size, 1);
  f.flush();
  assert.equal(f.screens.select.hidden, false);
  assert.equal(f.screens.select.inert, false);
  assert.equal(f.screens.results.hidden, true);
  assert.equal(f.timers.size, 0);
});
