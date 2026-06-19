'use strict';
// Procedural fish sprite spec + canvas renderer. Spec generation is pure & deterministic.
(function () {
var ENGINE = (typeof require === 'function') ? require('./fishing.js') : window.FishingEngine;
const { mulberry32 } = ENGINE;

const BODY_SHAPES = ['torpedo', 'round', 'flat', 'eel', 'angular', 'blobby'];
const FIN_SHAPES = ['pointed', 'fan', 'spiky', 'rounded'];
const TAIL_SHAPES = ['forked', 'crescent', 'paddle', 'whip'];
const PATTERNS = ['solid', 'stripes', 'spots', 'bands', 'gradient'];
const PALETTES = [
  ['#3b6ea5', '#9cc3e0'], ['#5a8f4a', '#c2e0a0'], ['#a5563b', '#e0a890'],
  ['#7a4fa3', '#cbb0e0'], ['#c9a23b', '#efe0a0'], ['#3ba59a', '#a0e0d8'],
];
const SHINY_PALETTES = [
  ['#e8e8f0', '#b8c0ff'], ['#ffd770', '#fff3c0'], ['#b0fff0', '#e8fffb'],
];
const EYES = ['dot', 'ring', 'sleepy'];
const BASE_ACCENTS = ['whiskers', 'spines', 'antenna'];
const GATED_ACCENTS = ['glow', 'sheen'];
const ACCENTS = [...BASE_ACCENTS, ...GATED_ACCENTS];

function hashId(id) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function fishSpriteSpec(fish, opts) {
  const float = opts && opts.float != null ? opts.float : 0.2;
  const shiny = !!(opts && opts.shiny);
  const rng = mulberry32(hashId(fish.id));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const bodyShape = pick(BODY_SHAPES);
  const finShape = pick(FIN_SHAPES);
  const tailShape = pick(TAIL_SHAPES);
  const pattern = pick(PATTERNS);
  const palette = shiny ? pick(SHINY_PALETTES) : pick(PALETTES);
  const eye = pick(EYES);

  // Accents: each rolled independently; "glow" gated to rarity >= 4.
  const accents = [];
  if (rng() < 0.35) accents.push(pick(BASE_ACCENTS));
  if (fish.rarity >= 4 && rng() < 0.7) accents.push('glow');
  if (fish.rarity >= 3 && rng() < 0.4) accents.push('sheen');

  return {
    bodyShape, finShape, tailShape, pattern, palette, eye,
    accents,
    condition: 1 - float, // 1 = pristine, 0 = scarred
    shiny,
  };
}

// --- Canvas renderer (visual; not unit-tested) — implemented in Task 10 ---
function drawFish(ctx, spec, t) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const cx = w / 2, cy = h / 2;
  const bodyLen = w * 0.6, bodyH = h * 0.32;
  const cond = spec.condition; // 1 pristine .. 0 scarred
  const [dark, light] = spec.palette;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = 0.55 + 0.45 * cond; // duller when worn

  // tail (wiggles with t)
  const wag = Math.sin(t * 6) * bodyH * 0.25;
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-bodyLen * 0.5, 0);
  ctx.lineTo(-bodyLen * 0.75, -bodyH * 0.5 + wag);
  ctx.lineTo(-bodyLen * 0.75, bodyH * 0.5 + wag);
  ctx.closePath();
  ctx.fill();

  // body
  const grad = ctx.createLinearGradient(0, -bodyH, 0, bodyH);
  grad.addColorStop(0, light);
  grad.addColorStop(1, dark);
  ctx.fillStyle = grad;
  ctx.beginPath();
  if (spec.bodyShape === 'round' || spec.bodyShape === 'blobby') {
    ctx.ellipse(0, 0, bodyLen * 0.42, bodyH * 1.1, 0, 0, Math.PI * 2);
  } else if (spec.bodyShape === 'eel') {
    ctx.ellipse(0, 0, bodyLen * 0.5, bodyH * 0.5, 0, 0, Math.PI * 2);
  } else {
    ctx.ellipse(0, 0, bodyLen * 0.5, bodyH, 0, 0, Math.PI * 2);
  }
  ctx.fill();

  // pattern
  ctx.fillStyle = dark;
  if (spec.pattern === 'stripes') {
    for (let i = -2; i <= 2; i++) { ctx.fillRect(i * bodyLen * 0.12, -bodyH, bodyLen * 0.04, bodyH * 2); }
  } else if (spec.pattern === 'spots') {
    for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.arc(i * bodyLen * 0.12, (i % 2) * bodyH * 0.4, bodyH * 0.18, 0, Math.PI * 2); ctx.fill(); }
  }

  // eye
  ctx.fillStyle = '#10141a';
  ctx.beginPath();
  ctx.arc(bodyLen * 0.32, -bodyH * 0.2, bodyH * 0.16, 0, Math.PI * 2);
  ctx.fill();

  // accents
  if (spec.accents.includes('glow')) {
    ctx.globalAlpha = 0.4 * cond;
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.ellipse(0, 0, bodyLen * 0.62, bodyH * 1.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (spec.shiny) {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-bodyLen * 0.1, -bodyH * 0.4, bodyLen * 0.18, bodyH * 0.25, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const API = {
  hashId, fishSpriteSpec, drawFish,
  BODY_SHAPES, FIN_SHAPES, TAIL_SHAPES, PATTERNS, PALETTES, SHINY_PALETTES, EYES, ACCENTS,
};
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.FishSprite = API;
})();
