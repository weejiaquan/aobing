'use strict';

// Unit tests for the PURE typing engine exported by typing.js.
// Run: `node --test typing.test.js`
// No DOM, no Firebase, no mocks — the engine is framework-agnostic by design.
// Tests are intentionally verbose so failures double as debugging output.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./typing.js');
const {
  WORD_PACKS,
  getActivePack,
  nextWords,
  createRunState,
  applyKey,
  completeWord,
  wpm,
  rankedEligible,
} = T;

// --- helpers ---------------------------------------------------------------
// Drive a sequence of keystrokes through applyKey and return the final state.
function typeKeys(state, keys, mods) {
  return keys.reduce((s, k) => applyKey(s, k, mods), state);
}
const NO_MODS = { freedom: false, noBackspace: false, stopOnError: false };

// =========================================================================
// wpm(correctChars, elapsedMs)
// =========================================================================
test('wpm: 25 correct chars in 60s = 5 wpm', () => {
  assert.equal(wpm(25, 60000), 5);
});

test('wpm: 50 correct chars in 30s = 20 wpm', () => {
  assert.equal(wpm(50, 30000), 20);
});

test('wpm: zero elapsed time guards to 0 (no divide-by-zero)', () => {
  assert.equal(wpm(10, 0), 0);
});

test('wpm: negative/zero correctChars guards to 0', () => {
  assert.equal(wpm(0, 1000), 0);
  assert.equal(wpm(-5, 1000), 0);
});

test('wpm: clamps absurd values from sub-second runs to a human ceiling', () => {
  // 25 correct chars in 10ms = ~30000 wpm — clamp to 400.
  assert.equal(wpm(25, 10), 400);
  // A realistic score stays untouched.
  assert.equal(wpm(50, 30000), 20);
});

// =========================================================================
// rankedEligible(mods) — any assist modifier disqualifies; QoL does not.
// =========================================================================
test('rankedEligible: pure run (no mods) is eligible', () => {
  assert.equal(rankedEligible(NO_MODS), true);
  assert.equal(rankedEligible({}), true);
});

test('rankedEligible: each assist modifier disqualifies', () => {
  assert.equal(rankedEligible({ freedom: true }), false);
  assert.equal(rankedEligible({ noBackspace: true }), false);
  assert.equal(rankedEligible({ stopOnError: true }), false);
});

test('rankedEligible: QoL flag alone stays eligible', () => {
  assert.equal(rankedEligible({ qol: true }), true);
});

// =========================================================================
// createRunState scoring fields
// =========================================================================
test('createRunState: scoring defaults when no scoring arg', () => {
  const s = createRunState(['cat'], 's30', NO_MODS);
  assert.equal(s.subMode, 'casual');
  assert.equal(s.comboPowerLevel, 1);
  assert.equal(s.casualComboCap, 0);
  assert.equal(s.commitOnSpace, false);
  assert.equal(s.comboCount, 0);
  assert.equal(s.wordBuffer, 0);
  assert.equal(s.runScore, 0);
});

test('createRunState: scoring arg is applied', () => {
  const s = createRunState(['cat'], 's30', NO_MODS, {
    subMode: 'ranked', comboPowerLevel: 5, casualComboCap: 20, commitOnSpace: true,
  });
  assert.equal(s.subMode, 'ranked');
  assert.equal(s.comboPowerLevel, 5);
  assert.equal(s.casualComboCap, 20);
  assert.equal(s.commitOnSpace, true);
});

// =========================================================================
// Word pack registry + nextWords determinism / fallback
// =========================================================================
test('WORD_PACKS has a default english-common pack with words', () => {
  assert.ok(Array.isArray(WORD_PACKS) && WORD_PACKS.length >= 1);
  const def = WORD_PACKS[0];
  assert.equal(def.id, 'english-common');
  assert.ok(Array.isArray(def.words) && def.words.length >= 100);
});

test('getActivePack returns the matching pack, falls back to default', () => {
  assert.equal(getActivePack('english-common').id, 'english-common');
  assert.equal(getActivePack('does-not-exist').id, 'english-common');
  assert.equal(getActivePack(undefined).id, 'english-common');
});

test('nextWords is deterministic for the same seed index', () => {
  const pack = { id: 'tiny', name: 'Tiny', words: ['alpha', 'bravo', 'charlie', 'delta', 'echo'] };
  const a = nextWords(pack, 5, 7);
  const b = nextWords(pack, 5, 7);
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
  a.forEach((w) => assert.ok(pack.words.includes(w)));
});

test('nextWords differs across seed indices (stream advances)', () => {
  const pack = { id: 'tiny', name: 'Tiny', words: ['alpha', 'bravo', 'charlie', 'delta', 'echo'] };
  assert.notDeepEqual(nextWords(pack, 5, 0), nextWords(pack, 5, 100));
});

test('nextWords falls back to default pack when given empty/missing pack', () => {
  const fromEmpty = nextWords({ id: 'x', words: [] }, 3, 0);
  const fromNull = nextWords(null, 3, 0);
  assert.equal(fromEmpty.length, 3);
  assert.equal(fromNull.length, 3);
  fromEmpty.forEach((w) => assert.equal(typeof w, 'string'));
  fromNull.forEach((w) => assert.equal(typeof w, 'string'));
});

// =========================================================================
// applyKey — DEFAULT mode (monkeytype): overshoot allowed, backspace fixes.
// =========================================================================
test('applyKey default: correct char appends, flags correct, no error', () => {
  let s = createRunState(['test'], 's30', NO_MODS);
  s = applyKey(s, 't', NO_MODS);
  assert.equal(s.buffer, 't');
  assert.equal(s.errors, 0);
  assert.deepEqual(s.lastAction, { type: 'char', correct: true });
});

test('applyKey default: wrong char appends and increments errors', () => {
  let s = createRunState(['test'], 's30', NO_MODS);
  s = applyKey(s, 't', NO_MODS);
  s = applyKey(s, 'x', NO_MODS); // expected 'e'
  assert.equal(s.buffer, 'tx');
  assert.equal(s.errors, 1);
  assert.deepEqual(s.lastAction, { type: 'char', correct: false });
});

test('applyKey default: overshoot beyond target length keeps appending wrong', () => {
  let s = createRunState(['hi'], 's30', NO_MODS);
  s = typeKeys(s, ['h', 'i', 'x', 'y'], NO_MODS);
  assert.equal(s.buffer, 'hixy');
  assert.equal(s.errors, 2); // x and y are both past the target
});

test('applyKey default: backspace removes last char', () => {
  let s = createRunState(['test'], 's30', NO_MODS);
  s = typeKeys(s, ['t', 'x'], NO_MODS);
  s = applyKey(s, 'Backspace', NO_MODS);
  assert.equal(s.buffer, 't');
  assert.deepEqual(s.lastAction, { type: 'backspace' });
});

test('applyKey: backspace on empty buffer is a no-op', () => {
  let s = createRunState(['test'], 's30', NO_MODS);
  s = applyKey(s, 'Backspace', NO_MODS);
  assert.equal(s.buffer, '');
  assert.deepEqual(s.lastAction, { type: 'noop' });
});

test('applyKey: non-printable keys (Shift) are ignored', () => {
  let s = createRunState(['test'], 's30', NO_MODS);
  s = applyKey(s, 'Shift', NO_MODS);
  assert.equal(s.buffer, '');
  assert.deepEqual(s.lastAction, { type: 'noop' });
});

// =========================================================================
// applyKey — NO-BACKSPACE / Confidence: mistakes lock in.
// =========================================================================
test('applyKey noBackspace: backspace is a no-op, buffer unchanged', () => {
  const mods = { ...NO_MODS, noBackspace: true };
  let s = createRunState(['test'], 's30', mods);
  s = typeKeys(s, ['t', 'x'], mods);
  s = applyKey(s, 'Backspace', mods);
  assert.equal(s.buffer, 'tx');
  assert.deepEqual(s.lastAction, { type: 'noop' });
});

// =========================================================================
// applyKey — STOP-ON-ERROR: cursor cannot advance past an incorrect char.
// =========================================================================
test('applyKey stopOnError: one wrong char lands, further input blocked', () => {
  const mods = { ...NO_MODS, stopOnError: true };
  let s = createRunState(['cat'], 's30', mods);
  s = applyKey(s, 'c', mods); // correct
  s = applyKey(s, 'x', mods); // wrong (expected 'a') — lands, errors++
  assert.equal(s.buffer, 'cx');
  assert.equal(s.errors, 1);
  s = applyKey(s, 'y', mods); // blocked: buffer is not a correct prefix
  assert.equal(s.buffer, 'cx');
  assert.deepEqual(s.lastAction, { type: 'noop' });
});

test('applyKey stopOnError: correcting the error unblocks input', () => {
  const mods = { ...NO_MODS, stopOnError: true };
  let s = createRunState(['cat'], 's30', mods);
  s = typeKeys(s, ['c', 'x'], mods);
  s = applyKey(s, 'Backspace', mods); // remove the wrong char
  s = applyKey(s, 'a', mods); // now correct again
  assert.equal(s.buffer, 'ca');
  assert.deepEqual(s.lastAction, { type: 'char', correct: true });
});

// =========================================================================
// applyKey — FREEDOM: next correct char snaps the buffer back into alignment.
// =========================================================================
test('applyKey freedom: typing the correct next char drops the wrong tail', () => {
  const mods = { ...NO_MODS, freedom: true };
  let s = createRunState(['test'], 's30', mods);
  s = typeKeys(s, ['t', 'e'], mods); // 'te' aligned (matchedLen 2)
  s = applyKey(s, 'x', mods);        // wrong; expected 's' -> append -> 'tex', errors 1
  assert.equal(s.buffer, 'tex');
  assert.equal(s.errors, 1);
  s = applyKey(s, 's', mods);        // correct next char snaps back to alignment
  assert.equal(s.buffer, 'tes');
  assert.deepEqual(s.lastAction, { type: 'char', correct: true });
});

// =========================================================================
// completeWord — word boundary advances, reports correctness, credits chars.
// =========================================================================
test('completeWord: fully-correct word advances and credits chars + space', () => {
  let s = createRunState(['cat', 'dog'], 's30', NO_MODS);
  s = typeKeys(s, ['c', 'a', 't'], NO_MODS);
  const res = completeWord(s);
  assert.equal(res.correct, true);
  assert.equal(res.state.wordIndex, 1);
  assert.equal(res.state.completedWords, 1);
  assert.equal(res.state.buffer, '');
  // 3 correct chars + 1 space credit
  assert.equal(res.state.correctChars, 4);
});

test('completeWord: incorrect word still advances but credits only matches, no space', () => {
  let s = createRunState(['cat', 'dog'], 's30', NO_MODS);
  s = typeKeys(s, ['c', 'o', 't'], NO_MODS); // 'cot' vs 'cat' -> c,t match
  const res = completeWord(s);
  assert.equal(res.correct, false);
  assert.equal(res.state.completedWords, 1);
  assert.equal(res.state.correctChars, 2); // c + t, no space credit
});

test('applyKey space: completes the current word (delegates to completeWord)', () => {
  let s = createRunState(['cat', 'dog'], 's30', NO_MODS);
  s = typeKeys(s, ['c', 'a', 't'], NO_MODS);
  s = applyKey(s, ' ', NO_MODS);
  assert.equal(s.wordIndex, 1);
  assert.equal(s.completedWords, 1);
  assert.equal(s.buffer, '');
  assert.deepEqual(s.lastAction, { type: 'word', correct: true });
});

test('applyKey space: space on empty buffer is a no-op (no empty words)', () => {
  let s = createRunState(['cat'], 's30', NO_MODS);
  s = applyKey(s, ' ', NO_MODS);
  assert.equal(s.wordIndex, 0);
  assert.equal(s.completedWords, 0);
  assert.deepEqual(s.lastAction, { type: 'noop' });
});

// =========================================================================
// createRunState — sane initial shape.
// =========================================================================
test('createRunState: initial run state shape', () => {
  const s = createRunState(['a', 'b'], 's15', NO_MODS);
  assert.deepEqual(s.words, ['a', 'b']);
  assert.equal(s.wordIndex, 0);
  assert.equal(s.buffer, '');
  assert.equal(s.correctChars, 0);
  assert.equal(s.completedWords, 0);
  assert.equal(s.errors, 0);
  assert.equal(s.mode, 's15');
  assert.equal(s.finished, false);
});

// =========================================================================
// No-skip-on-error: space must NOT advance an unfinished/incorrect word in
// modes where the player can still backspace. No-backspace is the exception.
// =========================================================================
test('applyKey space (default): incorrect word does NOT advance — must correct it', () => {
  let s = createRunState(['test', 'next'], 's30', NO_MODS);
  s = typeKeys(s, ['t', 'e', 'x'], NO_MODS); // 'tex' is wrong
  s = applyKey(s, ' ', NO_MODS);
  assert.equal(s.wordIndex, 0, 'stays on the same word');
  assert.equal(s.buffer, 'tex', 'buffer preserved so it can be backspaced');
  assert.deepEqual(s.lastAction, { type: 'noop' });
});

test('applyKey space (default): incomplete-but-correct word does NOT advance', () => {
  let s = createRunState(['test'], 's30', NO_MODS);
  s = typeKeys(s, ['t', 'e', 's'], NO_MODS); // 'tes' — correct so far but unfinished
  s = applyKey(s, ' ', NO_MODS);
  assert.equal(s.wordIndex, 0);
  assert.deepEqual(s.lastAction, { type: 'noop' });
});

test('applyKey space (default): a fully-correct word advances', () => {
  let s = createRunState(['test', 'next'], 's30', NO_MODS);
  s = typeKeys(s, ['t', 'e', 's', 't'], NO_MODS);
  s = applyKey(s, ' ', NO_MODS);
  assert.equal(s.wordIndex, 1);
  assert.deepEqual(s.lastAction, { type: 'word', correct: true });
});

test('applyKey space (noBackspace): incorrect word DOES advance (mistakes lock in)', () => {
  const mods = { ...NO_MODS, noBackspace: true };
  let s = createRunState(['test', 'next'], 's30', mods);
  s = typeKeys(s, ['t', 'e', 'x'], mods);
  s = applyKey(s, ' ', mods);
  assert.equal(s.wordIndex, 1, 'advances despite the error');
  assert.deepEqual(s.lastAction, { type: 'word', correct: false });
});

// =========================================================================
// ClearWord (Ctrl+Backspace / Ctrl+A then Backspace) — wipe the current buffer.
// =========================================================================
test('applyKey ClearWord: clears the whole current buffer', () => {
  let s = createRunState(['hello'], 's30', NO_MODS);
  s = typeKeys(s, ['h', 'e', 'l'], NO_MODS);
  s = applyKey(s, 'ClearWord', NO_MODS);
  assert.equal(s.buffer, '');
  assert.deepEqual(s.lastAction, { type: 'backspace' });
});

test('applyKey ClearWord: no-op under no-backspace', () => {
  const mods = { ...NO_MODS, noBackspace: true };
  let s = createRunState(['hello'], 's30', mods);
  s = typeKeys(s, ['h', 'e', 'l'], mods);
  s = applyKey(s, 'ClearWord', mods);
  assert.equal(s.buffer, 'hel');
  assert.deepEqual(s.lastAction, { type: 'noop' });
});

test('applyKey ClearWord: no-op on an empty buffer', () => {
  let s = createRunState(['hello'], 's30', NO_MODS);
  s = applyKey(s, 'ClearWord', NO_MODS);
  assert.equal(s.buffer, '');
  assert.deepEqual(s.lastAction, { type: 'noop' });
});
