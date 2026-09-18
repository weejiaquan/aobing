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

test('missing the hook window shows a missed beat, then returns to idle', () => {
  const rng = mulberry32(3);
  let { state } = run(createSession(), rng, 1, CAST, NEW_CTX);
  // reach the bite phase
  let guard = 0;
  while (state.phase !== 'bite' && guard++ < 1000) state = step(state, 1 / 60, NONE, rng, NEW_CTX).state;
  assert.equal(state.phase, 'bite');
  // never press cast through the whole hook window -> miss
  const r = run(state, rng, Math.ceil(HOOK_WINDOW_SECONDS * 60) + 2, NONE, NEW_CTX);
  assert.ok(r.events.some(e => e.type === 'missed'));
  assert.equal(r.state.phase, 'missed');
  const after = run(r.state, rng, Math.ceil(S.MISS_SECONDS * 60) + 1, NONE, NEW_CTX);
  assert.equal(after.state.phase, 'idle');
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
  assert.equal(state.phase, 'landing');
  assert.equal(state.result.outcome, 'caught');
  assert.equal(step(state, .1, CAST, rng, NEW_CTX).state.phase, 'landing', 'an early press does not skip landing');
  const landed = run(state, rng, Math.ceil(S.LANDING_SECONDS * 60) + 1, NONE, NEW_CTX);
  assert.equal(landed.state.phase, 'result');
  assert.equal(landed.events.filter(e => e.type === 'caught').length, 0, 'landing cannot pay twice');
  assert.equal(landed.events.filter(e => e.type === 'reveal').length, 1);
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
  assert.equal(state.phase, 'landing');
});

test('cast from an escaped result still begins the next cast directly', () => {
  const rng = mulberry32(9);
  const resultState = { phase: 'result', fish: TABLE[0], waitDur: 0, timer: 0, bar: null, result: { outcome: 'escaped', fish: TABLE[0] } };
  const r = step(resultState, 1 / 60, CAST, rng, NEW_CTX);
  assert.equal(r.state.phase, 'casting');
  assert.equal(r.state.result, null);
  assert.equal(r.events.filter(e => e.type === 'cast').length, 1);
});

test('caught popup ignores spam and held input, then times out to idle without recasting', () => {
  const result={outcome:'caught',fish:TABLE[0],coins:25,specimen:{species:'trout'}};
  const original={...createSession(),phase:'result',fish:TABLE[0],result};
  const rng=()=>{throw new Error('reveal must not roll another encounter');};
  let state=original;
  for(let i=0;i<9;i++){
    const r=step(state,S.CATCH_REVEAL_SECONDS/10,{cast:true,holding:i%2===0},rng,NEW_CTX);
    state=r.state;
    assert.equal(state.phase,'result');assert.equal(state.result,result);assert.deepEqual(r.events,[]);
  }
  assert.equal(original.timer,0,'previous snapshot remains unchanged');
  const expired=step(state,S.CATCH_REVEAL_SECONDS/5,{cast:true,holding:true},rng,NEW_CTX);
  assert.deepEqual(expired.state,createSession());assert.deepEqual(expired.events,[]);
  const held=step(expired.state,.1,{cast:false,holding:true},rng,NEW_CTX);
  assert.equal(held.state.phase,'idle','a held key must not restart fishing');
});

test('caught popup expires without any input and a fresh press can cast afterward', () => {
  const state={...createSession(),phase:'result',result:{outcome:'caught'}};
  const rng=mulberry32(19);
  const expired=step(state,S.CATCH_REVEAL_SECONDS,NONE,rng,NEW_CTX);
  assert.equal(expired.state.phase,'idle');
  assert.equal(step(expired.state,1/60,CAST,rng,NEW_CTX).state.phase,'casting');
});

test('hold prepares a bounded charge; only releasing rolls an encounter', () => {
  let calls = 0;
  const rng = () => { calls++; return .5; };
  const hold = { cast: true, holding: true };
  const original = createSession();
  let r = step(original, 1/60, hold, rng, NEW_CTX);
  assert.equal(original.phase, 'idle', 'reducer does not mutate caller');
  assert.equal(r.state.phase, 'charging');
  assert.equal(calls, 0, 'preparing does not roll fish');
  r = run(r.state, rng, 180, {cast:false,holding:true}, NEW_CTX);
  assert.equal(r.state.charge, 1);
  assert.equal(r.state.phase, 'charging', 'a long hold never casts by itself');
  r = step(r.state, 1/60, NONE, rng, NEW_CTX);
  assert.equal(r.state.phase, 'casting');
  assert.equal(r.events.filter(e => e.type === 'cast').length, 1);
  assert.ok(calls > 0);
  r = run(r.state, rng, Math.ceil(CAST_ANIM_SECONDS * 60) + 1, NONE, NEW_CTX);
  assert.equal(r.events.filter(e => e.type === 'splash').length, 1);
});
