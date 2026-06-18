'use strict';
// Pure fishing engine. No DOM, no audio, no Firebase, no Math.random/Date.
// Randomness is injected as rng() -> [0,1); time is injected as dt (seconds).

// --- Seeded RNG (tests inject this; production passes Math.random) ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Rarity → difficulty tiers (positions/fractions of the track per second) ---
const RARITY_TIERS = {
  1: { fishSpeed: 0.30, barSize: 0.28, fillRate: 0.55, drainRate: 0.30, weight: 100, discoveryBonus: 25 },
  2: { fishSpeed: 0.42, barSize: 0.24, fillRate: 0.50, drainRate: 0.38, weight: 38, discoveryBonus: 80 },
  3: { fishSpeed: 0.56, barSize: 0.20, fillRate: 0.45, drainRate: 0.46, weight: 12, discoveryBonus: 220 },
  4: { fishSpeed: 0.74, barSize: 0.16, fillRate: 0.42, drainRate: 0.55, weight: 3, discoveryBonus: 650 },
  5: { fishSpeed: 0.94, barSize: 0.13, fillRate: 0.40, drainRate: 0.66, weight: 0.6, discoveryBonus: 2500 },
};

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

const API = { mulberry32, RARITY_TIERS, clamp01 };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.FishingEngine = API;
