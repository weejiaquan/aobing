const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function player() {
  const buffers = [], starts = [];
  class AudioContext {
    constructor() { this.currentTime = 1; this.state = 'running'; }
    createGain() { return { connect() {} }; }
    resume() { return Promise.resolve(); }
    createBuffer(channels, frames, rate) {
      const data = new Float32Array(frames);
      const buffer = { channels, frames, rate, duration: frames / rate, getChannelData: () => data };
      buffers.push(buffer); return buffer;
    }
    createBufferSource() { return { connect() {}, disconnect() {}, start(at) { starts.push(at); } }; }
  }
  const window = { AudioContext };
  vm.runInNewContext(fs.readFileSync('dos-runtime.js', 'utf8'), { window, AbortController });
  const runtime = new window.DosRuntime.Runtime({});
  runtime.paused = false; runtime.ci = { soundFrequency: () => 44100 };
  return { runtime, buffers, starts };
}

test('DOS mono samples retain their order, pitch and full duration', () => {
  const { runtime, buffers } = player();
  const samples = Float32Array.from({ length: 441 }, (_, i) => Math.sin(i / 10));
  runtime.sound(samples);
  assert.equal(buffers[0].channels, 1);
  assert.equal(buffers[0].duration, .01);
  assert.deepEqual(buffers[0].getChannelData(0), samples);
});

test('DOS audio joins chunks without gaps and prebuffers after underruns', () => {
  const { runtime, starts } = player();
  const samples = new Float32Array(441);
  runtime.sound(samples);
  assert.equal(starts[0], 1.04);
  runtime.audio.currentTime = 1.045;
  runtime.sound(samples);
  assert.equal(starts[1], starts[0] + .01);
  runtime.audio.currentTime = 2;
  runtime.sound(samples);
  assert.equal(starts[2], 2.04);
});

test('DOS audio remains bounded and ignores paused or empty chunks', () => {
  const { runtime, buffers } = player();
  runtime.sound(new Float32Array());
  runtime.paused = true; runtime.sound(new Float32Array(441));
  runtime.paused = false; runtime.nextSound = 2; runtime.sound(new Float32Array(441));
  assert.equal(buffers.length, 0);
});
