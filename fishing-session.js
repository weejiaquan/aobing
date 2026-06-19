'use strict';
// Pure fishing session reducer. No DOM, no audio. Inputs/dt/rng injected.
// Drives the lifecycle: idle -> casting -> waiting -> bite -> balancing -> result.
(function () {
var ENGINE = (typeof require === 'function') ? require('./fishing.js') : window.FishingEngine;
const {
  rollEncounter, rollCastWait, HOOK_WINDOW_SECONDS,
  createBarState, stepBar, isCaught, isEscaped, BALANCE_GRACE_SECONDS,
  createSpecimen, computeCoins,
} = ENGINE;

const CAST_ANIM_SECONDS = 0.4;

function createSession() {
  return { phase: 'idle', fish: null, waitDur: 0, timer: 0, bar: null, result: null };
}

// Returns { state, events }. `input` = { cast, holding }. `ctx` = { table, hasCaught }.
function step(state, dt, input, rng, ctx) {
  const events = [];
  const s = Object.assign({}, state);

  switch (s.phase) {
    case 'idle': {
      if (input.cast) {
        s.fish = rollEncounter(ctx.table, rng);
        s.waitDur = rollCastWait(rng);
        s.timer = 0;
        s.phase = 'casting';
        s.result = null;
        events.push({ type: 'cast' });
      }
      break;
    }
    case 'casting': {
      s.timer += dt;
      if (s.timer >= CAST_ANIM_SECONDS) { s.phase = 'waiting'; s.timer = 0; }
      break;
    }
    case 'waiting': {
      s.timer += dt;
      if (s.timer >= s.waitDur) { s.phase = 'bite'; s.timer = 0; events.push({ type: 'bite' }); }
      break;
    }
    case 'bite': {
      s.timer += dt;
      if (input.cast) {
        s.bar = createBarState(s.fish);
        s.timer = 0;
        s.phase = 'balancing';
        events.push({ type: 'hooked' });
      } else if (s.timer >= HOOK_WINDOW_SECONDS) {
        s.phase = 'idle';
        s.fish = null;
        events.push({ type: 'missed' });
      }
      break;
    }
    case 'balancing': {
      // clone the bar substate so stepBar's in-place mutations don't touch the
      // caller's previous state snapshot (keeps this reducer pure).
      const barCopy = Object.assign({}, s.bar, {
        bar: Object.assign({}, s.bar.bar),
        fish_: Object.assign({}, s.bar.fish_),
      });
      // grace period: meter frozen for the first BALANCE_GRACE_SECONDS so the player
      // can spot the bar and start tracking before catch/escape can trigger.
      const inGrace = s.timer < BALANCE_GRACE_SECONDS;
      s.bar = stepBar(barCopy, dt, input.holding, rng, inGrace);
      s.timer += dt;
      if (isCaught(s.bar)) {
        const specimen = createSpecimen(s.fish, rng);
        const isNew = !ctx.hasCaught(s.fish.id);
        const coins = computeCoins(s.fish, specimen.size, specimen.float, specimen.shiny, isNew);
        s.phase = 'result';
        s.result = { outcome: 'caught', specimen, coins, isNew, fish: s.fish };
        events.push({ type: 'caught', fish: s.fish, specimen, coins, isNew });
      } else if (isEscaped(s.bar)) {
        s.phase = 'result';
        s.result = { outcome: 'escaped', fish: s.fish };
        events.push({ type: 'escaped', fish: s.fish });
      }
      break;
    }
    case 'result': {
      if (input.cast) { s.phase = 'idle'; s.fish = null; s.bar = null; s.result = null; }
      break;
    }
  }

  return { state: s, events };
}

const API = { createSession, step, CAST_ANIM_SECONDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.FishingSession = API;
})();
