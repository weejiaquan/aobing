'use strict';
// Unit tests for the PURE fishing session reducer.
// Run: `node --test fishing-session.test.js`
// No DOM, no audio, no mocks. Inputs (cast/holding), dt and rng are injected.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('./fishing-session.js');
const { createSession, step, CAST_ANIM_SECONDS } = S;
const ENGINE = require('./fishing.js');
const { mulberry32, HOOK_WINDOW_SECONDS } = ENGINE;

// A one-fish table so encounters are deterministic regardless of rng.
const TABLE = [{ id: 'trout', name: 'Trout', rarity: 1, behavior: 'drifter', family: 'test', sizeRange: [10, 20], coinBase: 10 }];
const NEW_CTX = { table: TABLE, hasCaught: () => false };
const NONE = { cast: false, holding: false };
const CAST = { cast: true, holding: false };

// Drive the session N frames with a fixed input, collecting events.
function run(state, rng, frames, input, ctx) {
  const events = [];
  for (let i = 0; i < frames; i++) {
    const r = step(state, 1 / 60, input, rng, ctx);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

test('a fresh session starts idle', () => {
  assert.equal(createSession().phase, 'idle');
});

test('cast from idle enters casting then waiting, emitting a cast event', () => {
  const rng = mulberry32(1);
  let r = step(createSession(), 1 / 60, CAST, rng, NEW_CTX);
  assert.equal(r.state.phase, 'casting');
  assert.ok(r.events.some(e => e.type === 'cast'));
  assert.ok(r.state.fish, 'a fish should be rolled at cast time');
  // advance past the cast animation
  const after = run(r.state, rng, Math.ceil(CAST_ANIM_SECONDS * 60) + 1, NONE, NEW_CTX);
  assert.equal(after.state.phase, 'waiting');
});

test('waiting transitions to bite after the rolled wait, emitting bite', () => {
  const rng = mulberry32(2);
  let { state } = run(createSession(), rng, 1, CAST, NEW_CTX); // start cast
  // run long enough to exhaust cast-anim + max wait (5s) + a margin
  const r = run(state, rng, 60 * 7, NONE, NEW_CTX);
  assert.ok(r.events.some(e => e.type === 'bite'), 'should emit a bite within 7s');
});

test('missing the hook window returns to idle with a missed event', () => {
  const rng = mulberry32(3);
  let { state } = run(createSession(), rng, 1, CAST, NEW_CTX);
  // reach the bite phase
  let guard = 0;
  while (state.phase !== 'bite' && guard++ < 1000) state = step(state, 1 / 60, NONE, rng, NEW_CTX).state;
  assert.equal(state.phase, 'bite');
  // never press cast through the whole hook window -> miss
  const r = run(state, rng, Math.ceil(HOOK_WINDOW_SECONDS * 60) + 2, NONE, NEW_CTX);
  assert.ok(r.events.some(e => e.type === 'missed'));
  assert.equal(r.state.phase, 'idle');
});

test('hooking enters balancing; holding to fill yields a caught event with specimen + coins', () => {
  const rng = mulberry32(1);
  let { state } = run(createSession(), rng, 1, CAST, NEW_CTX);
  let guard = 0;
  while (state.phase !== 'bite' && guard++ < 1000) state = step(state, 1 / 60, NONE, rng, NEW_CTX).state;
  // hook on the next frame
  let r = step(state, 1 / 60, CAST, rng, NEW_CTX);
  assert.equal(r.state.phase, 'balancing');
  assert.ok(r.events.some(e => e.type === 'hooked'));
  state = r.state;
  // play realistically: track the fish — hold to rise when the bar sits below it.
  let caught = null;
  for (let i = 0; i < 60 * 30 && state.phase === 'balancing'; i++) {
    const b = state.bar;
    const holding = (b.bar.pos + b.tier.barSize / 2) < b.fish_.pos;
    const rr = step(state, 1 / 60, { cast: false, holding: holding }, rng, NEW_CTX);
    state = rr.state;
    const c = rr.events.find(e => e.type === 'caught');
    if (c) caught = c;
  }
  assert.ok(caught, 'should land a caught event');
  assert.equal(caught.specimen.species, 'trout');
  assert.ok(caught.coins > 0, 'caught event must carry positive coins');
  assert.equal(caught.isNew, true, 'first catch of a species is new (hasCaught=false)');
  assert.equal(state.phase, 'result');
  assert.equal(state.result.outcome, 'caught');
});

test('isNew is false when ctx.hasCaught reports the species already caught', () => {
  const rng = mulberry32(7);
  const ctx = { table: TABLE, hasCaught: () => true };
  let { state } = run(createSession(), rng, 1, CAST, ctx);
  let guard = 0;
  while (state.phase !== 'bite' && guard++ < 1000) state = step(state, 1 / 60, NONE, rng, ctx).state;
  state = step(state, 1 / 60, CAST, rng, ctx).state; // hook
  let caught = null;
  for (let i = 0; i < 60 * 30 && state.phase === 'balancing'; i++) {
    const b = state.bar;
    const holding = (b.bar.pos + b.tier.barSize / 2) < b.fish_.pos;
    const rr = step(state, 1 / 60, { cast: false, holding: holding }, rng, ctx);
    state = rr.state;
    caught = rr.events.find(e => e.type === 'caught') || caught;
  }
  assert.ok(caught);
  assert.equal(caught.isNew, false);
  assert.equal(caught.specimen.species, 'trout');
  assert.ok(caught.coins > 0, 'caught event must carry positive coins');
  assert.equal(state.phase, 'result');
});

test('cast from result returns to idle (dismiss)', () => {
  // Build a result state directly and dismiss it.
  const rng = mulberry32(9);
  const resultState = { phase: 'result', fish: TABLE[0], waitDur: 0, timer: 0, bar: null, result: { outcome: 'escaped', fish: TABLE[0] } };
  const r = step(resultState, 1 / 60, CAST, rng, NEW_CTX);
  assert.equal(r.state.phase, 'idle');
});
