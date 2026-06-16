'use strict';

/*
 * typing.js — Typing Game mode for aobing.
 *
 * This file has two halves:
 *   1. A PURE engine (no DOM, no Firebase) — unit-tested in typing.test.js.
 *   2. Browser wiring exposing window.TypingGame.init(deps) — added below the
 *      engine and guarded by `typeof document`. The host (app.js) injects every
 *      dependency it needs; typing.js never reaches into app.js's closure.
 *
 * The engine is exported via module.exports for Node tests and attached to
 * window.TypingEngine in the browser.
 */

// =========================================================================
// Word-pack registry
// =========================================================================
// One bundled English pack for v1. Themed/purchasable packs append here later
// with an `unlock` key; getActivePack() gates on ownership at that point.
const WORD_PACKS = [
  {
    id: 'english-common',
    name: 'English',
    words: [
      'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
      'not', 'on', 'with', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
      'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will',
      'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up', 'out',
      'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can',
      'like', 'time', 'no', 'just', 'him', 'know', 'take', 'people', 'into', 'year',
      'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now',
      'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use',
      'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want',
      'because', 'any', 'these', 'give', 'day', 'most', 'us', 'world', 'life', 'hand',
      'part', 'child', 'eye', 'woman', 'place', 'week', 'case', 'point', 'company', 'number',
      'group', 'problem', 'fact', 'water', 'money', 'story', 'month', 'home', 'room', 'school',
      'never', 'again', 'great', 'little', 'right', 'still', 'should', 'mean', 'keep', 'last',
      'high', 'every', 'much', 'before', 'move', 'thing', 'place', 'where', 'help', 'through',
      'line', 'turn', 'cause', 'same', 'mean', 'differ', 'small', 'large', 'open', 'close',
      'begin', 'change', 'follow', 'start', 'might', 'show', 'around', 'often', 'until', 'while',
      'house', 'paper', 'music', 'color', 'green', 'light', 'sound', 'plant', 'cover', 'food',
      'river', 'four', 'carry', 'state', 'once', 'book', 'hear', 'stop', 'without', 'second',
      'later', 'miss', 'idea', 'enough', 'eat', 'face', 'watch', 'far', 'really', 'almost',
      'above', 'girl', 'sometimes', 'mountain', 'cut', 'young', 'talk', 'soon', 'list', 'song',
      'being', 'leave', 'family', 'body', 'music', 'stand', 'study', 'learn', 'plant', 'cover',
      'against', 'pattern', 'slow', 'center', 'love', 'person', 'money', 'serve', 'appear', 'road',
      'map', 'science', 'rule', 'govern', 'pull', 'cold', 'notice', 'voice', 'fall', 'power',
      'town', 'fine', 'certain', 'fly', 'unit', 'lead', 'cry', 'dark', 'machine', 'note',
      'wait', 'plan', 'figure', 'star', 'box', 'noun', 'field', 'rest', 'correct', 'able',
      'pound', 'done', 'beauty', 'drive', 'stood', 'contain', 'front', 'teach', 'final', 'gave',
      'green', 'oh', 'quick', 'develop', 'sleep', 'warm', 'free', 'minute', 'strong', 'special',
      'mind', 'behind', 'clear', 'tail', 'produce', 'street', 'inch', 'nothing', 'course', 'stay',
      'wheel', 'full', 'force', 'blue', 'object', 'decide', 'surface', 'deep', 'moon', 'island',
      'foot', 'yet', 'busy', 'test', 'record', 'common', 'gold', 'plane', 'dry', 'wonder',
    ],
  },
];

function getActivePack(packId) {
  for (let i = 0; i < WORD_PACKS.length; i++) {
    if (WORD_PACKS[i].id === packId) return WORD_PACKS[i];
  }
  return WORD_PACKS[0];
}

// Deterministic PRNG (mulberry32) so nextWords is reproducible in tests and
// resumable across the endless stream by passing a monotonic seedIndex.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextWords(pack, count, seedIndex) {
  const usable = pack && Array.isArray(pack.words) && pack.words.length ? pack : WORD_PACKS[0];
  const words = usable.words;
  const rng = mulberry32(seedIndex >>> 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(words[Math.floor(rng() * words.length)]);
  }
  return out;
}

// =========================================================================
// Run state + input reducer
// =========================================================================
function createRunState(words, mode, mods, scoring) {
  scoring = scoring || {};
  return {
    words: words.slice(),
    wordIndex: 0,
    buffer: '',        // chars typed for the current word
    correctChars: 0,   // cumulative correctly-typed chars (incl. inter-word spaces) — WPM unit
    completedWords: 0,
    errors: 0,
    mode: mode,
    mods: mods || {},
    finished: false,
    lastAction: null,  // ephemeral: result of the most recent applyKey
    // --- combo economy scoring ---
    subMode: scoring.subMode || 'casual',          // 'casual' | 'ranked'
    comboPowerLevel: scoring.comboPowerLevel || 1,  // coins added to wordBuffer per correct keystroke
    casualComboCap: scoring.casualComboCap || 0,    // 0 = uncapped (ranked); >0 caps the casual multiplier
    commitOnSpace: !!scoring.commitOnSpace,         // ranked: space commits even an incorrect word
    comboCount: 0,     // the ×multiplier; +1 per correct keystroke; reset rules in applyKey
    wordBuffer: 0,     // accrues comboPowerLevel per correct keystroke; reset each word
    runScore: 0,       // sum of word payouts this run (typingScore board unit)
  };
}

function commonPrefixLen(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function matchingChars(buffer, target) {
  let n = 0;
  const len = Math.min(buffer.length, target.length);
  for (let i = 0; i < len; i++) if (buffer[i] === target[i]) n++;
  return n;
}

function clone(state) {
  return Object.assign({}, state);
}

// completeWord — advance past the current target word. Returns { state, correct }
// where `correct` is whether the typed buffer exactly matched the target. Credits
// matched chars toward WPM, plus one space if the word was fully correct.
function completeWord(state) {
  const s = clone(state);
  const target = s.words[s.wordIndex] || '';
  const correct = s.buffer === target;
  s.correctChars += matchingChars(s.buffer, target) + (correct ? 1 : 0);
  s.completedWords += 1;
  s.wordIndex += 1;
  s.buffer = '';
  return { state: s, correct: correct };
}

// applyKey — the heart of the engine. Pure: returns a new state with an
// ephemeral `lastAction` describing what this keystroke did. `mods` selects the
// branch (default / freedom / noBackspace / stopOnError).
function applyKey(state, key, mods) {
  mods = mods || {};
  const s = clone(state);
  const target = s.words[s.wordIndex] || '';

  // Backspace
  if (key === 'Backspace') {
    if (mods.noBackspace || s.buffer.length === 0) {
      s.lastAction = { type: 'noop' };
      return s;
    }
    s.buffer = s.buffer.slice(0, -1);
    s.lastAction = { type: 'backspace' };
    return s;
  }

  // Clear the whole current word (Ctrl+Backspace / Ctrl+A then Backspace).
  if (key === 'ClearWord') {
    if (mods.noBackspace || s.buffer.length === 0) {
      s.lastAction = { type: 'noop' };
      return s;
    }
    s.buffer = '';
    s.lastAction = { type: 'backspace' };
    return s;
  }

  // Word boundary
  if (key === ' ') {
    if (s.buffer.length === 0) {
      s.lastAction = { type: 'noop' };
      return s;
    }
    const matches = (s.buffer === target);
    // Default casual keeps the fix-first rule (noop on incorrect). No-backspace
    // locks mistakes in. Ranked commitOnSpace lets a *fully-typed* word commit even
    // when wrong (so the bad word breaks the streak) — but an unfinished word is a
    // no-op, so space can't skip a half-typed word.
    const fullyTyped = (s.buffer.length >= target.length);
    const willCommit = matches || mods.noBackspace || (s.commitOnSpace && fullyTyped);
    if (!willCommit) {
      s.lastAction = { type: 'noop' };
      return s;
    }
    const effMul = (s.subMode === 'casual' && s.casualComboCap > 0)
      ? Math.min(s.comboCount, s.casualComboCap)
      : s.comboCount;
    const payout = s.wordBuffer * effMul;
    const res = completeWord(s);
    const ns = res.state;
    ns.wordBuffer = 0;                                 // reset score buffer for next word
    ns.runScore += payout;
    if (ns.subMode === 'ranked' && !res.correct) ns.comboCount = 0; // streak broken
    ns.lastAction = { type: 'word', correct: res.correct, payout: payout };
    return ns;
  }

  // Ignore non-printable keys (Shift, Enter, arrows, …)
  if (typeof key !== 'string' || key.length !== 1) {
    s.lastAction = { type: 'noop' };
    return s;
  }

  const m = commonPrefixLen(s.buffer, target);

  // Stop-on-error: cannot advance while the buffer already holds an error.
  if (mods.stopOnError && m < s.buffer.length) {
    s.lastAction = { type: 'noop' };
    return s;
  }

  // Freedom: the next correct character snaps the buffer back into alignment,
  // discarding any incorrect tail instead of requiring backspace.
  if (mods.freedom) {
    const expected = target[m];
    if (key === expected) {
      s.buffer = target.slice(0, m) + key;
      s.comboCount += 1;
      s.wordBuffer += s.comboPowerLevel;
      s.lastAction = { type: 'char', correct: true };
      return s;
    }
    s.buffer = s.buffer + key;
    s.errors += 1;
    s.lastAction = { type: 'char', correct: false };
    return s;
  }

  // Default (monkeytype): append the char; overshoot beyond target keeps adding
  // wrong chars that must be backspaced.
  const correct = key === target[s.buffer.length];
  s.buffer = s.buffer + key;
  if (!correct) {
    s.errors += 1;
  } else {
    s.comboCount += 1;
    s.wordBuffer += s.comboPowerLevel;
  }
  s.lastAction = { type: 'char', correct: correct };
  return s;
}

// =========================================================================
// Scoring
// =========================================================================
// No human sustains >400 wpm; clamp so sub-second runs can't post absurd scores.
const MAX_WPM = 400;
function wpm(correctChars, elapsedMs) {
  if (!(correctChars > 0) || !(elapsedMs > 0)) return 0;
  const val = (correctChars / 5) / (elapsedMs / 60000);
  return Math.min(MAX_WPM, Math.round(val * 100) / 100);
}

// A run counts toward the WPM (ranked) board only if no assist modifier was
// active. QoL modifiers are ranked-safe and do not disqualify.
function rankedEligible(mods) {
  mods = mods || {};
  return !(mods.freedom || mods.noBackspace || mods.stopOnError);
}

// =========================================================================
// Exports
// =========================================================================
const ENGINE = {
  WORD_PACKS: WORD_PACKS,
  getActivePack: getActivePack,
  nextWords: nextWords,
  createRunState: createRunState,
  applyKey: applyKey,
  completeWord: completeWord,
  wpm: wpm,
  rankedEligible: rankedEligible,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ENGINE;
}
if (typeof window !== 'undefined') {
  window.TypingEngine = ENGINE;
}

// =========================================================================
// Browser wiring — window.TypingGame.init(deps). DOM/Firebase live here and
// are NOT exercised by typing.test.js (verified manually in the running app).
// =========================================================================
if (typeof document !== 'undefined') {
  const api = { init: initBrowser };
  const MODE_SECONDS = { s15: 15, s30: 30, s60: 60, endless: 0 };
  const STREAM_REFILL = 40;                       // words drawn per refill
  const VISIBLE_WORDS = 14;                       // words shown in the stream

  let inited = false;

  function initBrowser(deps) {
    if (inited) return;
    const btn = document.getElementById('typing-btn');
    const panel = document.getElementById('typing-panel');
    if (!btn || !panel) return; // markup not present yet — bail quietly
    inited = true;

    const db = deps.db;
    const settings = deps.settings;
    const t = deps.t || ((k) => k);
    const esc = deps.escapeHtml || ((s) => String(s));
    const flag = deps.flagFromCountry || (() => '');
    const activityImg = deps.activityImg || ((u) => u);

    const streamEl = document.getElementById('typing-stream');
    const inputEl = document.getElementById('typing-input');
    const liveEl = document.getElementById('typing-live');
    const stopBtn = document.getElementById('typing-stop');
    const resultEl = document.getElementById('typing-result');
    const modesEl = document.getElementById('typing-modes');
    const modsEl = document.getElementById('typing-mods');
    const togglesEl = document.getElementById('typing-toggles');
    const boardWordsBtn = document.getElementById('typing-board-words');
    const boardWpmBtn = document.getElementById('typing-board-wpm');
    const boardListEl = document.getElementById('typing-board-list');
    const closeBtn = document.getElementById('typing-close');
    const restartBtn = document.getElementById('typing-restart');

    let run = null;
    let running = false;
    let panelOpen = false;
    let startMs = 0;
    let endsAt = 0;
    let timerId = null;
    let seedCounter = 0;
    let lastElapsed = 0;
    let selectAllPending = false; // true after Ctrl+A, until the next key
    let awaitingRestart = false;  // run ended (e.g. time's up) — keys won't auto-start a new run

    function freshSeed() {
      seedCounter += 1;
      return (seedCounter * 2654435761) >>> 0;
    }

    function drawWords() {
      const pack = ENGINE.getActivePack(settings.typingPack);
      return ENGINE.nextWords(pack, STREAM_REFILL, freshSeed());
    }

    // Modifiers are locked at run start (toggling mid-run can't change ranked
    // eligibility). Only owned + toggled-on assists count.
    function activeMods() {
      const shop = deps.getUserShop();
      return {
        freedom:     !!(shop.typingFreedom && settings.typingFreedomOn),
        noBackspace: !!(shop.typingNoBackspace && settings.typingNoBackspaceOn),
        stopOnError: !!(shop.typingStopOnError && settings.typingStopOnErrorOn),
        qol:         !!shop.typingQol,
      };
    }

    // Combo-economy scoring config, locked at run start. Ranked = uncapped +
    // commit-on-space (bad word breaks the streak); Casual = capped safe farm.
    function scoringConfig() {
      const ranked = (settings.typingSubMode === 'ranked');
      return {
        subMode: ranked ? 'ranked' : 'casual',
        comboPowerLevel: deps.comboPowerLevel ? deps.comboPowerLevel() : 1,
        casualComboCap: ranked ? 0 : (deps.casualComboCap ? deps.casualComboCap() : 0),
        commitOnSpace: ranked,
      };
    }

    function clearTimer() {
      if (timerId) { clearInterval(timerId); timerId = null; }
    }

    function startRun() {
      clearTimer();
      run = ENGINE.createRunState(drawWords(), settings.typingMode || 's30', activeMods(), scoringConfig());
      running = true;
      startMs = 0;
      endsAt = 0;
      awaitingRestart = false;
      if (deps.resetTypingCombo) deps.resetTypingCombo();
      resultEl.hidden = true;
      streamEl.classList.remove('typing-dim');
      stopBtn.hidden = (MODE_SECONDS[run.mode] !== 0); // stop button only for endless
      renderStream();
      updateLive(true);
    }

    function beginTiming() {
      startMs = performance.now();
      const secs = MODE_SECONDS[run.mode];
      if (secs > 0) {
        endsAt = startMs + secs * 1000;
        timerId = setInterval(() => {
          if (performance.now() >= endsAt) finishRun('timeup');
          else updateLive();
        }, 100);
      } else {
        timerId = setInterval(updateLive, 200);
      }
    }

    function finishRun(reason) {
      if (!running) return;
      running = false;
      clearTimer();
      lastElapsed = startMs ? (performance.now() - startMs) : 0;
      const w = ENGINE.wpm(run.correctChars, lastElapsed);
      const ranked = ENGINE.rankedEligible(run.mods);
      const isRankedMode = (settings.typingSubMode === 'ranked');
      // WPM + score boards accept only ranked-eligible, timed runs (s15/s30/s60).
      if (ranked && MODE_SECONDS[run.mode] > 0) {
        const opts = { mode: run.mode };
        if (w > 0) opts.bestWpm = w;
        if (isRankedMode && run.runScore > 0) opts.runScore = run.runScore;
        if (opts.bestWpm || opts.runScore) deps.creditTyping(0, 0, opts);
      }
      showResult(w, ranked, reason === 'timeup');
      streamEl.classList.add('typing-dim');
      stopBtn.hidden = true;
      startMs = 0;
      // After a finished run the stream is frozen until an explicit restart, so a
      // fast typist doesn't blow straight past the result into a new run.
      awaitingRestart = (reason !== 'close');
    }

    function showResult(w, ranked, timedUp) {
      const acc = (run.correctChars + run.errors) > 0
        ? Math.round((100 * run.correctChars) / (run.correctChars + run.errors))
        : 100;
      const head = timedUp
        ? '<div class="typing-result-head">' + t('typing.times_up') + '</div>' : '';
      resultEl.innerHTML = head +
        '<div class="typing-result-row"><b>' + w + '</b> ' + t('typing.wpm') + '</div>' +
        '<div class="typing-result-row"><b>' + acc + '%</b> ' + t('typing.accuracy') + '</div>' +
        '<div class="typing-result-row"><b>' + run.completedWords + '</b> ' + t('typing.words') + '</div>' +
        '<div class="typing-result-tag">' + (ranked ? t('typing.ranked') : t('typing.casual')) + '</div>' +
        '<div class="typing-result-hint">' + t('typing.restart_hint') + '</div>';
      resultEl.hidden = false;
    }

    function updateLive(reset) {
      if (reset) { liveEl.textContent = ''; return; }
      const elapsed = startMs ? (performance.now() - startMs) : 0;
      const secs = MODE_SECONDS[run.mode];
      const parts = [];
      if (secs > 0) parts.push(Math.max(0, Math.ceil((endsAt - performance.now()) / 1000)) + 's');
      else parts.push(Math.floor(elapsed / 1000) + 's');
      parts.push(run.completedWords + ' ' + t('typing.words'));
      if (deps.getUserShop().typingQol) parts.push(ENGINE.wpm(run.correctChars, elapsed) + ' ' + t('typing.wpm'));
      liveEl.textContent = parts.join('  ·  ');
    }

    function renderCurrentWord(target, buffer) {
      let out = '';
      const n = Math.max(target.length, buffer.length);
      for (let i = 0; i < n; i++) {
        const tc = target[i];
        const bc = buffer[i];
        if (bc == null) {
          out += '<span class="tc' + (i === buffer.length ? ' tc-caret' : '') + '">' + esc(tc || '') + '</span>';
        } else if (tc == null) {
          out += '<span class="tc tc-extra">' + esc(bc) + '</span>';
        } else if (bc === tc) {
          out += '<span class="tc tc-ok">' + esc(tc) + '</span>';
        } else {
          out += '<span class="tc tc-bad">' + esc(tc) + '</span>';
        }
      }
      return out;
    }

    function renderStream() {
      const cur = run.wordIndex;
      const end = Math.min(cur + VISIBLE_WORDS, run.words.length);
      const parts = [];
      for (let i = cur; i < end; i++) {
        if (i === cur) parts.push('<span class="tw tw-cur">' + renderCurrentWord(run.words[i], run.buffer) + '</span>');
        else parts.push('<span class="tw">' + esc(run.words[i]) + '</span>');
      }
      streamEl.innerHTML = parts.join(' ');
    }

    function ensureWords() {
      if (run.words.length - run.wordIndex < 20) {
        const pack = ENGINE.getActivePack(settings.typingPack);
        run.words = run.words.concat(ENGINE.nextWords(pack, STREAM_REFILL, freshSeed()));
      }
    }

    function step(key) {
      if (awaitingRestart) return;   // run finished — wait for an explicit restart
      if (!running) startRun();
      if (startMs === 0) beginTiming();
      run = ENGINE.applyKey(run, key, run.mods);
      const act = run.lastAction;
      if (act && act.type === 'word') {
        deps.creditTyping(act.payout || 0, 1);
        if (settings.typingClickOnWord) deps.reactCharacter();
        if (deps.renderTypingCombo) deps.renderTypingCombo(run.comboCount);
        ensureWords();
      } else if (act && act.type === 'char') {
        if (act.correct && deps.renderTypingCombo) deps.renderTypingCombo(run.comboCount);
        if (settings.typingClickPerKey) deps.reactCharacter();
      }
      // Every typed character counts as a keyboard input in the global click count
      // (same as keyboard mashing in clicker mode — global/keyboard only, not rank).
      if (act && act.type === 'char' && deps.recordKeyboard) deps.recordKeyboard();
      renderStream();
      updateLive();
    }

    function onKey(e) {
      const k = e.key;
      if (k === 'Tab') return;                 // let focus move out
      if (k === 'Escape') return;              // handled by the document Esc listener
      // Enter restarts after a finished run (time's up); ignored mid-run.
      if (k === 'Enter') { if (awaitingRestart) { e.preventDefault(); startRun(); } return; }
      // Ctrl/Cmd shortcuts: clear the whole current word.
      if (e.ctrlKey || e.metaKey) {
        if (k === 'Backspace') { e.preventDefault(); selectAllPending = false; step('ClearWord'); return; }
        if (k === 'a' || k === 'A') { e.preventDefault(); selectAllPending = true; return; } // arm Ctrl+A
        return;                                // ignore other ctrl combos (don't type the letter)
      }
      const isChar = k.length === 1;
      if (!isChar && k !== 'Backspace') return; // ignore Shift/arrows/etc.
      e.preventDefault();
      // Ctrl+A then Backspace = select-all delete -> clear the buffer.
      if (k === 'Backspace' && selectAllPending) { selectAllPending = false; step('ClearWord'); return; }
      selectAllPending = false;
      step(k);
    }

    function renderModes() {
      const buttons = modesEl.querySelectorAll('button[data-mode]');
      for (let i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle('sel', buttons[i].getAttribute('data-mode') === settings.typingMode);
      }
    }

    const MOD_DEFS = [
      { key: 'typingFreedom', label: 'typing.mod.freedom', toggle: 'typingFreedomOn',
        desc: 'Wrong letters snap back as you keep typing — no backspacing needed. (assist)' },
      { key: 'typingNoBackspace', label: 'typing.mod.nobackspace', toggle: 'typingNoBackspaceOn',
        desc: 'Backspace is disabled — mistakes lock in. (assist)' },
      { key: 'typingStopOnError', label: 'typing.mod.stoponerror', toggle: 'typingStopOnErrorOn',
        desc: "Can't move past a wrong letter until you fix it. (assist)" },
      { key: 'typingQol', label: 'typing.mod.qol', toggle: null,
        desc: 'Quality-of-life: live WPM readout and a smoother caret. (ranked-safe)' },
    ];

    function renderMods() {
      const shop = deps.getUserShop();
      modsEl.innerHTML = '';
      MOD_DEFS.forEach((d) => {
        const row = document.createElement('div');
        row.className = 'typing-mod';
        const info = document.createElement('div');
        info.className = 'typing-mod-info';
        const name = document.createElement('span');
        name.className = 'typing-mod-name';
        name.textContent = t(d.label);
        info.appendChild(name);
        if (d.desc) {
          const desc = document.createElement('span');
          desc.className = 'typing-mod-desc';
          desc.textContent = d.desc;
          info.appendChild(desc);
        }
        row.appendChild(info);
        const owned = !!shop[d.key];
        if (!owned) {
          const buy = document.createElement('button');
          buy.className = 'typing-buy';
          buy.textContent = (deps.typingCosts[d.key] || '?');
          buy.addEventListener('click', async (e) => {
            e.stopPropagation();
            buy.disabled = true;
            const ok = await deps.buyTypingMod(d.key);
            if (ok) renderMods();
            else { buy.disabled = false; buy.classList.add('typing-buy-err'); }
          });
          row.appendChild(buy);
        } else if (d.toggle) {
          const tg = document.createElement('button');
          tg.className = 'settings-toggle' + (settings[d.toggle] ? ' on' : '');
          tg.addEventListener('click', (e) => {
            e.stopPropagation();
            settings[d.toggle] = !settings[d.toggle];
            tg.classList.toggle('on', settings[d.toggle]);
            deps.saveSettings();
          });
          row.appendChild(tg);
        } else {
          const ok = document.createElement('span');
          ok.className = 'typing-owned';
          ok.textContent = '✓';
          row.appendChild(ok);
        }
        modsEl.appendChild(row);
      });
    }

    const TOGGLE_DEFS = [
      { key: 'typingClickOnWord', label: 'typing.toggle.on_word' },
      { key: 'typingClickPerKey', label: 'typing.toggle.per_key' },
    ];

    function renderToggles() {
      togglesEl.innerHTML = '';
      TOGGLE_DEFS.forEach((d) => {
        const row = document.createElement('div');
        row.className = 'typing-mod';
        const name = document.createElement('span');
        name.textContent = t(d.label);
        const tg = document.createElement('button');
        tg.className = 'settings-toggle' + (settings[d.key] ? ' on' : '');
        tg.addEventListener('click', (e) => {
          e.stopPropagation();
          settings[d.key] = !settings[d.key];
          tg.classList.toggle('on', settings[d.key]);
          deps.saveSettings();
        });
        row.appendChild(name);
        row.appendChild(tg);
        togglesEl.appendChild(row);
      });
    }

    function upgradeRow(label, cost, key, atMax) {
      const row = document.createElement('div');
      row.className = 'typing-mod';
      const name = document.createElement('span');
      name.textContent = label;
      row.appendChild(name);
      if (atMax) {
        const max = document.createElement('span');
        max.className = 'typing-owned';
        max.textContent = t('typing.upg.max');
        row.appendChild(max);
      } else {
        const buy = document.createElement('button');
        buy.className = 'typing-buy';
        buy.textContent = cost;
        buy.addEventListener('click', async (e) => {
          e.stopPropagation();
          buy.disabled = true;
          const ok = await deps.buyTypingUpgrade(key);
          if (ok) renderUpgrades();
          else { buy.disabled = false; buy.classList.add('typing-buy-err'); }
        });
        row.appendChild(buy);
      }
      return row;
    }

    function renderUpgrades() {
      const el = document.getElementById('typing-upgrades');
      if (!el) return;
      const lvl = deps.comboPowerLevel ? deps.comboPowerLevel() : 1;
      const cap = deps.casualComboCap ? deps.casualComboCap() : 0;
      const maxLvl = deps.comboPowerMax || 100;
      const tiers = deps.casualCapTiers || [];
      const capIdx = tiers.indexOf(cap);
      el.innerHTML = '';
      const powerAtMax = lvl >= maxLvl;
      el.appendChild(upgradeRow(
        t('typing.upg.power') + ' ×' + lvl,
        powerAtMax ? null : (deps.comboPowerCost ? deps.comboPowerCost(lvl + 1) : 0),
        'comboPowerLevel', powerAtMax));
      const capAtMax = capIdx === -1 || capIdx >= tiers.length - 1;
      el.appendChild(upgradeRow(
        t('typing.upg.cap') + ' ×' + cap,
        capAtMax ? null : (deps.casualCapCost ? deps.casualCapCost(capIdx + 1) : 0),
        'casualComboCap', capAtMax));
    }

    async function loadBoard(kind) {
      boardWordsBtn.classList.toggle('sel', kind === 'words');
      boardWpmBtn.classList.toggle('sel', kind === 'wpm');
      const boardScoreBtn = document.getElementById('typing-board-score');
      if (boardScoreBtn) boardScoreBtn.classList.toggle('sel', kind === 'score');
      boardListEl.textContent = t('typing.loading');
      const path = kind === 'wpm' ? 'leaderboard/typingWpm'
        : kind === 'score' ? 'leaderboard/typingScore'
        : 'leaderboard/typingWords';
      const order = kind === 'wpm' ? 'wpm' : kind === 'score' ? 'score' : 'typingWords';
      try {
        const snap = await db.ref(path).orderByChild(order).limitToLast(50).once('value');
        const rows = [];
        snap.forEach((c) => { const v = c.val(); if (v && v.hidden !== true) rows.push(v); });
        rows.sort((a, b) => (
          kind === 'wpm'   ? (b.wpm || 0) - (a.wpm || 0)
          : kind === 'score' ? (b.score || 0) - (a.score || 0)
          : (b.typingWords || 0) - (a.typingWords || 0)
        ));
        if (!rows.length) { boardListEl.innerHTML = '<div class="typing-empty">' + t('typing.board_empty') + '</div>'; return; }
        // Render with the SAME row UI as the clicker board (.lb-row) for consistency.
        boardListEl.innerHTML = rows.map((v, i) => {
          const val = kind === 'wpm'
            ? ((v.wpm || 0) + ' ' + t('typing.wpm') + (v.mode ? ' (' + esc(v.mode) + ')' : ''))
            : kind === 'score'
            ? ((v.score || 0).toLocaleString() + (v.mode ? ' (' + esc(v.mode) + ')' : ''))
            : ((v.typingWords || 0) + ' ' + t('typing.words'));
          const avatar = v.photoURL
            ? '<img class="lb-avatar" src="' + esc(activityImg(v.photoURL)) + '" alt="">'
            : '<div class="lb-avatar lb-avatar-fallback">' + esc((v.name || '?').slice(0, 1)) + '</div>';
          return '<div class="lb-row lb-row-typing">' +
            '<span class="lb-rank">#' + (i + 1) + '</span>' +
            avatar +
            '<span class="lb-flag">' + (flag(v.country) || '') + '</span>' +
            '<span class="lb-name">' + esc(v.name || '') + '</span>' +
            '<span class="lb-clicks">' + esc(val) + '</span></div>';
        }).join('');
      } catch (err) {
        boardListEl.textContent = t('typing.board_error');
      }
    }

    // --- Play overlay (pure floating text over the character) ----------------
    function openPanel() {
      panel.classList.add('open');
      panelOpen = true;
      if (!run || !running) startRun();
      setTimeout(() => inputEl.focus({ preventScroll: true }), 0);
    }
    function closePanel() {
      panel.classList.remove('open');
      panelOpen = false;
      deps.setTypingActive(false);
      if (deps.resetTypingCombo) deps.resetTypingCombo();
      if (settings.gameMode === 'typing') {
        settings.gameMode = 'clicker';
        deps.saveSettings();
        window.dispatchEvent(new CustomEvent('gamemodechange'));
      }
      if (running) finishRun('close');
    }
    function restartRun() {
      startRun();
      setTimeout(() => inputEl.focus({ preventScroll: true }), 0);
    }

    btn.addEventListener('click', (e) => { e.stopPropagation(); panelOpen ? closePanel() : openPanel(); });
    // Click the word stream to type; click anywhere else in the play area to
    // unfocus (stop typing). There's no close button — leave via the mode menu/Esc.
    panel.addEventListener('click', (e) => {
      if (streamEl.contains(e.target)) inputEl.focus({ preventScroll: true });
      else inputEl.blur();
    });
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });

    // Esc restarts an in-progress/finished run (keeping focus); on a fresh run that
    // hasn't started yet, Esc exits keyboard mode. Ignored while a modal is up.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !panelOpen) return;
      if (document.activeElement !== inputEl && !awaitingRestart) return; // a modal has focus — let it handle Esc
      if (startMs > 0 || awaitingRestart) restartRun();
      else closePanel();
    });

    inputEl.addEventListener('keydown', onKey);
    inputEl.addEventListener('focus', () => deps.setTypingActive(true));
    inputEl.addEventListener('blur', () => deps.setTypingActive(false));
    stopBtn.addEventListener('click', (e) => { e.stopPropagation(); finishRun('manual'); });
    if (restartBtn) restartBtn.addEventListener('click', (e) => { e.stopPropagation(); restartRun(); });

    streamEl.addEventListener('click', (e) => { e.stopPropagation(); inputEl.focus({ preventScroll: true }); });
    modesEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      settings.typingMode = b.getAttribute('data-mode');
      deps.saveSettings();
      renderModes();                        // applied on the next run (settings close)
    });
    boardWordsBtn.addEventListener('click', (e) => { e.stopPropagation(); loadBoard('words'); });
    boardWpmBtn.addEventListener('click', (e) => { e.stopPropagation(); loadBoard('wpm'); });
    const boardScoreBtn = document.getElementById('typing-board-score');
    if (boardScoreBtn) boardScoreBtn.addEventListener('click', (e) => { e.stopPropagation(); loadBoard('score'); });

    // The typing config (modes/modifiers/upgrades/toggles) now lives inline in the
    // left accordion's Keyboard section, so render it once on init and on language
    // change — not only when a modal opens.
    function refreshKeyboardPanel() {
      renderModes(); renderMods(); renderToggles(); renderUpgrades();
    }
    refreshKeyboardPanel();
    window.addEventListener('i18nchange', refreshKeyboardPanel);

    api.open = openPanel;
    api.close = closePanel;
    api.loadBoard = loadBoard;
    api.refreshKeyboardPanel = refreshKeyboardPanel;
    api.setSubMode = function (sm) {
      if (running) finishRun();                 // finalize under the run's own submode first
      settings.typingSubMode = (sm === 'ranked') ? 'ranked' : 'casual';
      deps.saveSettings();
      if (panelOpen) startRun();
      if (panelOpen) setTimeout(() => inputEl.focus({ preventScroll: true }), 0);
    };
  }

  window.TypingGame = api;
  if (window.__typingDeps) initBrowser(window.__typingDeps);
}
