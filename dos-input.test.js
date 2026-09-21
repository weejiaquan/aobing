const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { isFatalOutput } = require('./dos-runtime.js');

function fixture() {
  const frames = new Map(), moves = [], errors = [], keys = [];
  let id = 0, closed = 0, terminated = 0;
  class AudioContext {
    createGain() { return { connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { closed++; return Promise.resolve(); }
  }
  const window = { AudioContext };
  vm.runInNewContext(fs.readFileSync('dos-runtime.js', 'utf8'), {
    window, AbortController, document: { pointerLockElement: null }, clearInterval, clearTimeout,
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  const runtime = new window.DosRuntime.Runtime({}, { error: key => errors.push(key) });
  runtime.paused = false;
  runtime.worker = { terminate() { terminated++; } };
  runtime.ci = { sendMouseRelativeMotion: (x, y) => moves.push([x, y]),
    sendKeyEvent: (k, down) => keys.push([k, down]), sendMouseButton() {}, pause() {} };
  return { runtime, frames, moves, errors, keys, closed: () => closed, terminated: () => terminated,
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); } };
}

test('mouse events share one frame message and retain ordinary relative movement', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.runtime.moveMouse(1);
  assert.equal(f.frames.size, 1);
  f.flush(); assert.deepEqual(f.moves, [[100, 0]]);
  f.runtime.moveMouse(-4); f.runtime.moveMouse(2); f.flush();
  assert.deepEqual(f.moves.at(-1), [-2, 0]);
});

test('capture jumps are bounded and pausing drops pending mouse and held keys', () => {
  const f = fixture();
  f.runtime.moveMouse(Infinity); f.runtime.moveMouse(NaN);
  assert.equal(f.frames.size, 0);
  for (let i = 0; i < 1000; i++) f.runtime.moveMouse(1e6);
  f.flush(); assert.deepEqual(f.moves, [[200, 0]]);
  f.runtime.key('forward', 87, true); f.runtime.moveMouse(10); f.runtime.pause(); f.flush();
  assert.equal(f.moves.length, 1); assert.equal(f.runtime.held.size, 0);
  assert.deepEqual(f.keys, [[87, true], [87, false]]);
  f.runtime.moveMouse(10); assert.equal(f.frames.size, 0);
});

test('native exception dumps are failures, while normal DOS log output is not', () => {
  assert.equal(isFatalOutput('========================================================================APP/32=\r\n'), true);
  assert.equal(isFatalOutput('AOBING_FATAL: visplane capacity exceeded'), true);
  assert.equal(isFatalOutput('[panic] unknown exception'), true);
  assert.equal(isFatalOutput('[LOG_SB]DSP:Reset'), false);
  assert.equal(isFatalOutput('FastDoom version 1.3.0'), false);
});

test('a runtime failure releases inputs, worker and audio and reports retry once', () => {
  const f = fixture();
  f.runtime.key('fire', 32, true); f.runtime.moveMouse(10);
  f.runtime.fail(); f.runtime.fail(); f.flush();
  assert.equal(f.runtime.ci, null); assert.equal(f.frames.size, 0);
  assert.equal(f.terminated(), 1); assert.equal(f.closed(), 1);
  assert.deepEqual(f.errors, ['dos.runtime_error']);
  assert.deepEqual(f.keys, [[32, true], [32, false]]);
});
