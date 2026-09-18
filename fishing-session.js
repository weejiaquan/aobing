'use strict';
// Pure fishing session reducer. No DOM, no audio. Inputs/dt/rng injected.
// Drives charge -> cast -> bite -> reel -> landing -> reveal. No rendering timers.
(function () {
var ENGINE = (typeof require === 'function') ? require('./fishing.js') : window.FishingEngine;
const {
  rollEncounter, rollCastWait, HOOK_WINDOW_SECONDS,
  createBarState, stepBar, isCaught, isEscaped, BALANCE_GRACE_SECONDS,
  createSpecimen, computeCoins,
} = ENGINE;

const CAST_ANIM_SECONDS = 0.8;
const CHARGE_SECONDS = 1.2;
const LANDING_SECONDS = 0.85;
const MISS_SECONDS = 1.1;
const CATCH_REVEAL_SECONDS = 1;

function createSession() {
  return { phase: 'idle', fish: null, waitDur: 0, timer: 0, bar: null, result: null, charge: 0 };
}

function beginCast(s, rng, ctx, events) {
  s.fish = rollEncounter(ctx.table, rng);
  s.waitDur = rollCastWait(rng);
  s.timer = 0;
  s.phase = 'casting';
  s.result = null;
  events.push({ type: 'cast' });
}

// Returns { state, events }. `input` = { cast, holding }. `ctx` = { table, hasCaught }.
function step(state, dt, input, rng, ctx) {
  const events = [];
  const s = Object.assign({}, state);

  switch (s.phase) {
    case 'idle': {
      if (input.cast) {
        s.charge = 0.25;
        if (input.holding) { s.phase = 'charging'; s.timer = 0; }
        else beginCast(s, rng, ctx, events);
      }
      break;
    }
    case 'charging': {
      s.timer += dt;
      s.charge = Math.min(1, 0.25 + s.timer / CHARGE_SECONDS * 0.75);
      if (!input.holding) beginCast(s, rng, ctx, events);
      break;
    }
    case 'casting': {
      s.timer += dt;
      if (s.timer >= CAST_ANIM_SECONDS) { s.phase = 'waiting'; s.timer = 0; events.push({ type: 'splash' }); }
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
        s.phase = 'missed';
        s.timer = 0;
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
        s.phase = 'landing';
        s.timer = 0;
        s.result = { outcome: 'caught', specimen, coins, isNew, fish: s.fish };
        events.push({ type: 'caught', fish: s.fish, specimen, coins, isNew });
      } else if (isEscaped(s.bar)) {
        s.phase = 'result';
        s.timer = 0;
        s.result = { outcome: 'escaped', fish: s.fish };
        events.push({ type: 'escaped', fish: s.fish });
      }
      break;
    }
    case 'landing': {
      s.timer += dt;
      if (s.timer >= LANDING_SECONDS) { s.phase = 'result'; s.timer = 0; events.push({ type: 'reveal' }); }
      break;
    }
    case 'missed': {
      s.timer += dt;
      if (s.timer >= MISS_SECONDS) { s.phase = 'idle'; s.fish = null; }
      break;
    }
    case 'result': {
      if (s.result && s.result.outcome === 'caught') {
        // A catch is a protected timed reveal. Never consume or queue cast input.
        s.timer += dt;
        if (s.timer >= CATCH_REVEAL_SECONDS) return { state: createSession(), events };
        break;
      }
      // A fresh press starts the next cast directly; no redundant dismiss press.
      if (input.cast) {
        s.bar = null; s.result = null; s.charge = 0.25;
        if (input.holding) { s.phase = 'charging'; s.timer = 0; }
        else beginCast(s, rng, ctx, events);
      }
      break;
    }
  }

  return { state: s, events };
}

const API = { createSession, step, CAST_ANIM_SECONDS, CHARGE_SECONDS, LANDING_SECONDS, MISS_SECONDS, CATCH_REVEAL_SECONDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.FishingSession = API;
})();
