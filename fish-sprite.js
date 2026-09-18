'use strict';
// Generated painted specimens; stable species identity, shared transparent atlas.
(function () {
const ENGINE = typeof require === 'function' ? require('./fishing.js') : window.FishingEngine;
const BODY_SHAPES = ['torpedo', 'round', 'flat', 'eel', 'angular', 'blobby'];
const FIN_SHAPES = ['pointed', 'fan', 'spiky', 'rounded'];
const TAIL_SHAPES = ['forked', 'crescent', 'paddle', 'whip'];
const PATTERNS = ['solid', 'stripes', 'spots', 'bands', 'gradient'];
const EYES = ['dot', 'ring', 'sleepy'];
const ACCENTS = ['whiskers', 'spines', 'antenna', 'glow', 'sheen'];
// The name's colorway stays recognizable across families; shiny is a separate finish.
const COLORWAYS = {
  azure: ['#147cae', '#91eeff'], river: ['#237c7d', '#b8e5b1'],
  lake: ['#476cb3', '#b1dffc'], frost: ['#629dc9', '#efffff'],
  coral: ['#dd6376', '#ffd0b2'], crimson: ['#b92b58', '#ff9b9e'],
  jade: ['#248b74', '#b3f0b7'], ember: ['#da612c', '#ffdb7d'],
  shadow: ['#544680', '#bba5e2'], silver: ['#647e9f', '#eef6ff'],
  golden: ['#bd7c23', '#ffe596'], storm: ['#5266a5', '#9dd5f4'],
};
const PALETTES = Object.values(COLORWAYS);
const SHINY_PALETTES = [['#a575d1', '#f5e5ff'], ['#cb902c', '#fff4af'], ['#239b9c', '#c6fff2']];
const FAMILY_PROFILES = {
  Minnows: ['torpedo', 'pointed', 'forked', 'bands'],
  Trout: ['torpedo', 'rounded', 'forked', 'spots'],
  Bass: ['torpedo', 'spiky', 'paddle', 'bands'],
  Koi: ['torpedo', 'fan', 'whip', 'spots'],
  Tropical: ['flat', 'fan', 'forked', 'stripes'],
  Sunfish: ['round', 'pointed', 'paddle', 'spots'],
  Pufferfish: ['round', 'rounded', 'paddle', 'spots'],
  Catfish: ['blobby', 'rounded', 'forked', 'gradient'],
  Sharks: ['angular', 'pointed', 'crescent', 'gradient'],
  Marlin: ['torpedo', 'fan', 'crescent', 'stripes'],
  Eels: ['eel', 'rounded', 'whip', 'bands'],
  Rays: ['flat', 'pointed', 'whip', 'spots'],
  Jellyfish: ['blobby', 'rounded', 'whip', 'gradient'],
  Squid: ['angular', 'pointed', 'whip', 'spots'],
  Crustaceans: ['round', 'spiky', 'paddle', 'bands'],
  Seahorses: ['eel', 'fan', 'whip', 'bands'],
  Lanternfish: ['blobby', 'pointed', 'forked', 'spots'],
  Deepsea: ['angular', 'spiky', 'whip', 'gradient'],
  Mythic: ['eel', 'fan', 'whip', 'bands'],
};
function hashId(id) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function fishSpriteSpec(fish, opts) {
  opts = opts || {};
  const seed = hashId(fish.id), rng = ENGINE.mulberry32(seed);
  const pick = a => a[Math.floor(rng() * a.length)];
  const family = FAMILY_PROFILES[fish.family] ? fish.family : 'Minnows';
  const [bodyShape, finShape, tailShape, basePattern] = FAMILY_PROFILES[family];
  const variation = [rng(), rng(), rng(), rng(), rng(), rng()];
  const normalPalette = COLORWAYS[fish.id.split('-')[0]] || pick(PALETTES);
  const shinyPalette = pick(SHINY_PALETTES);
  const accents = [];
  if (family === 'Catfish' || family === 'Mythic') accents.push('whiskers');
  if (family === 'Pufferfish' || family === 'Deepsea') accents.push('spines');
  if (family === 'Lanternfish' || family === 'Crustaceans') accents.push('antenna');
  if (fish.rarity >= 4 && rng() < 0.7) accents.push('glow');
  if (fish.rarity >= 3 && rng() < 0.4) accents.push('sheen');
  return { family, seed, variation, colorway: fish.id.split('-')[0], bodyShape, finShape, tailShape,
    pattern: variation[0] > 0.8 ? pick(PATTERNS) : basePattern,
    palette: opts.shiny ? shinyPalette : normalPalette, eye: pick(EYES), accents,
    condition: 1 - Math.max(0, Math.min(1, opts.float == null ? 0.2 : opts.float)),
    shiny: !!opts.shiny };
}

// Native pixel bounds in the original transparent, generated artwork (1254²).
// Use measured rectangles, not inferred equal cells: tall fins cross nominal rows.
const ATLAS_URL = 'assets/fish/anime-atlas-v1.png';
const ATLAS_RECTS = {
  Trout: [27, 66, 294, 140], Bass: [348, 69, 295, 156],
  Minnows: [664, 80, 275, 126], Koi: [953, 22, 287, 225],
  Marlin: [10, 241, 355, 246], Sharks: [365, 296, 336, 185],
  Tropical: [726, 288, 230, 189], Sunfish: [1012, 222, 229, 327],
  Catfish: [18, 531, 331, 187], Eels: [360, 505, 301, 205],
  Pufferfish: [684, 527, 232, 188], Deepsea: [926, 556, 320, 164],
  Lanternfish: [23, 736, 320, 217], Rays: [359, 714, 309, 328],
  Seahorses: [747, 714, 129, 253], Jellyfish: [950, 722, 281, 260],
  Squid: [27, 979, 320, 266], Crustaceans: [346, 1011, 300, 203],
  Mythic: [653, 971, 333, 283], Angelfish: [991, 987, 252, 230],
};
// Contour-aware atlas windows keep long tails intact where nominal cells overlap.
// Coordinates are in source pixels; the original PNG and its alpha stay untouched.
const ATLAS_CLIPS = {
  Koi: [[953,22],[1240,22],[1240,218],[1040,218],[1040,247],[953,247]],
  Sunfish: [[1044,222],[1241,222],[1241,549],[1012,549],[1012,245],[1044,245]],
  Rays: [[359,714],[668,714],[668,1042],[610,1042],[610,1000],[565,980],[359,980]],
  Crustaceans: [[346,1011],[610,1011],[610,1042],[646,1042],[646,1214],[346,1214]],
};
// Subtle specimen finishes retain the painted scales, markings and fin membranes.
const FINISHES = {
  river: [0, 0.88, 1], lake: [8, 0.87, 1], azure: [0, 1.02, 1.02],
  jade: [48, 0.9, 1], coral: [-18, 1.05, 1.04], crimson: [-30, 1.15, 0.97],
  golden: [-10, 1.1, 1.08], ember: [-20, 1.15, 1.02],
  silver: [0, 0.45, 1.05], frost: [8, 0.82, 1.03],
  shadow: [20, 0.7, 0.78], storm: [16, 0.55, 0.92],
};
let atlas = null, atlasState = 'idle', readyPromise = null;
const pending = new Map(), textures = new Map();
function ready() {
  if (readyPromise) return readyPromise;
  if (typeof Image === 'undefined') return Promise.resolve(false);
  atlasState = 'loading';
  readyPromise = new Promise(resolve => {
    atlas = new Image();
    atlas.onload = () => {
      atlasState = 'ready';
      const waiting = [...pending.entries()]; pending.clear();
      waiting.forEach(([ctx, args]) => drawFish(ctx, args.spec, args.t));
      resolve(true);
    };
    atlas.onerror = () => { atlasState = 'error'; pending.clear(); resolve(false); };
    atlas.src = ATLAS_URL;
  });
  return readyPromise;
}
function textureFor(spec) {
  const family = spec.family || 'Minnows';
  const art = family === 'Tropical' && spec.variation[0] > 0.5 ? 'Angelfish' : family;
  const key = art + '|' + spec.colorway + '|' + spec.shiny;
  if (textures.has(key)) {
    const hit = textures.get(key); textures.delete(key); textures.set(key, hit); return hit;
  }
  const rect = ATLAS_RECTS[art] || ATLAS_RECTS.Minnows;
  const cv = document.createElement('canvas');
  cv.width = rect[2]; cv.height = rect[3];
  const ctx = cv.getContext('2d');
  if (ATLAS_CLIPS[art]) {
    ctx.beginPath();
    ATLAS_CLIPS[art].forEach(([x,y], i) => {
      if (i) ctx.lineTo(x-rect[0], y-rect[1]); else ctx.moveTo(x-rect[0], y-rect[1]);
    });
    ctx.closePath(); ctx.clip();
  }
  const [hue, saturation, brightness] = FINISHES[spec.colorway] || FINISHES.river;
  ctx.filter = spec.shiny
    ? `hue-rotate(${hue + 145}deg) saturate(${saturation * 0.85}) brightness(${brightness * 1.1})`
    : `hue-rotate(${hue}deg) saturate(${saturation}) brightness(${brightness})`;
  ctx.drawImage(atlas, ...rect, 0, 0, cv.width, cv.height);
  ctx.filter = 'none';
  // Each cached texture is a small atlas view. Never cache 151 full-size sheets.
  if (textures.size >= 64) textures.delete(textures.keys().next().value);
  textures.set(key, cv); return cv;
}
// A small continuous deformation mesh animates the existing illustration.
// Head weights stay near zero; fins and extremities get the larger displacement.
function swimPoint(spec, x, y, time) {
  if (!(time > 0)) return { x, y };
  const fade = Math.min(1, time / .7);
  const gain = fade * fade * (3 - 2 * fade);
  const seed = (spec.variation || [.5])[0];
  const phase = time * (2.6 + seed * .8) + seed * Math.PI * 2;
  const family = spec.family;
  let dx = 0, dy = 0;
  if (family === 'Jellyfish') {
    const bell = Math.max(0, 1 - y / .5), trail = Math.max(0, (y - .25) / .75);
    dx = (x - .5) * Math.sin(phase) * .09 * bell + Math.sin(phase - y * 5) * .045 * trail * trail;
    dy = Math.sin(phase) * .025 * bell + Math.cos(phase - y * 3) * .014 * trail;
  } else if (family === 'Rays') {
    const wing = Math.pow(Math.abs(x - .5) * 2, 1.6) * Math.max(0, 1 - y);
    dx = (x - .5) * Math.sin(phase) * .055 * wing + Math.sin(phase - y * 5) * .025 * y * y;
    dy = Math.sin(phase) * .075 * wing;
  } else if (family === 'Squid') {
    const arms = Math.max(0, (x + y - .7) / 1.3);
    dx = Math.sin(phase - y * 5) * .035 * arms;
    dy = Math.cos(phase - x * 6) * .045 * arms;
  } else if (family === 'Crustaceans') {
    const legs = Math.pow(Math.abs(x - .5) * 2, 2);
    dx = Math.sin(phase + y * 7) * .018 * legs;
    dy = Math.cos(phase + x * 5) * .022 * legs;
  } else if (family === 'Seahorses') {
    const tail = Math.max(0, (y - .35) / .65);
    dx = Math.sin(phase - y * 5) * .022 * tail;
    dy = Math.cos(phase - y * 4) * .012 * tail;
  } else {
    const tail = Math.pow(Math.max(0, (.73 - x) / .73), 1.7);
    const ribbon = family === 'Eels' || family === 'Mythic';
    const fins = Math.pow(Math.abs(y - .5) * 2, 2) * Math.max(0, 1 - x);
    dx = Math.cos(phase - x * 4) * .013 * tail;
    dy = Math.sin(phase - x * (ribbon ? 7 : 3)) * (ribbon ? .065 : .045) * tail;
    dy += Math.sin(phase * 1.3 - x * 5) * .017 * fins;
    if (family === 'Pufferfish') {
      dx += (x - .5) * Math.sin(phase * .7) * .013;
      dy += (y - .5) * Math.sin(phase * .7) * .013;
    }
  }
  return { x: x + dx * gain, y: y + dy * gain };
}
function drawMesh(ctx, texture, spec, time, dw, dh) {
  // Sparse deformation is sufficient for these gentle bends. Keep the atlas
  // gallery responsive when many specimens are visible simultaneously.
  const cols = dw > 160 ? 8 : 6, rows = 3;
  const sw = texture.width / cols, sh = texture.height / rows;
  const points = [];
  for (let y=0; y<=rows; y++) for (let x=0; x<=cols; x++) {
    const p = swimPoint(spec, x/cols, y/rows, time);
    points.push({ x: (p.x-.5)*dw, y: (p.y-.5)*dh });
  }
  function triangle(a,b,c,sx,sy,second) {
    ctx.save();
    // Fractional overlap removes hairline cracks between adjacent mesh triangles.
    const mx=(a.x+b.x+c.x)/3, my=(a.y+b.y+c.y)/3;
    ctx.beginPath();
    [a,b,c].forEach((p,i)=>{
      const d=Math.hypot(p.x-mx,p.y-my)||1;
      const x=p.x+(p.x-mx)*.28/d, y=p.y+(p.y-my)*.28/d;
      if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);
    });
    ctx.closePath(); ctx.clip();
    if (!second) {
      ctx.transform((b.x-a.x)/sw,(b.y-a.y)/sw,(c.x-a.x)/sh,(c.y-a.y)/sh,a.x,a.y);
    } else {
      const ax=(a.x-b.x)/sw, ay=(a.y-b.y)/sw, bx=(a.x-c.x)/sh, by=(a.y-c.y)/sh;
      ctx.transform(ax,ay,bx,by,b.x-bx*sh,b.y-by*sh);
    }
    // Sample the full texture across tile boundaries; cropping each source tile
    // would introduce visible transparent seams through the illustration.
    ctx.drawImage(texture,-sx,-sy); ctx.restore();
  }
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
    const i=y*(cols+1)+x, a=points[i], b=points[i+1], c=points[i+cols+1], d=points[i+cols+2];
    triangle(a,b,c,x*sw,y*sh,false);triangle(d,c,b,x*sw,y*sh,true);
  }
}
function drawFish(ctx, spec, t, options) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (atlasState !== 'ready') {
    if (atlasState !== 'error') { pending.set(ctx, { spec, t }); ready(); }
    return false;
  }
  const texture = textureFor(spec);
  const scale = Math.min(w * 0.87 / texture.width, h * 0.83 / texture.height);
  const dw = texture.width * scale, dh = texture.height * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.translate(w / 2, h / 2);
  const time = Number.isFinite(t) ? t : 0;
  if (options && options.reveal && time > 0) {
    const p=Math.min(1,time/.65), ease=1+2.2*Math.pow(p-1,3)+1.2*Math.pow(p-1,2);
    const settle=.88+.12*ease;ctx.scale(settle,settle);
    ctx.translate(0,(1-ease)*h*.045);
  }
  ctx.translate(0, Math.sin(time * 1.7) * h * 0.008);
  ctx.rotate(Math.sin(time * 1.25) * 0.012);
  if(time>0)drawMesh(ctx,texture,spec,time,dw,dh);
  else ctx.drawImage(texture, -dw / 2, -dh / 2, dw, dh);
  if (spec.shiny) {
    ctx.fillStyle = '#ffe7a3'; ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(0.6, w / 500);
    for (const [x, y, size] of [[-.35, -.32, .028], [.35, .26, .019]]) {
      const px=w*x, py=h*y, r=w*size;
      ctx.beginPath(); ctx.moveTo(px,py-r); ctx.quadraticCurveTo(px+1,py-1,px+r,py);
      ctx.quadraticCurveTo(px+1,py+1,px,py+r); ctx.quadraticCurveTo(px-1,py+1,px-r,py);
      ctx.quadraticCurveTo(px-1,py-1,px,py-r); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore(); return true;
}
// One 30fps clock for every DOM sprite; hidden/offscreen clocks stop advancing.
const players = new Map();
let playerRaf=0, playerLast=0, playerObserver=null, motionPreference=null;
function wakePlayers() {
  if (!playerRaf && players.size && !document.hidden && !motionPreference.matches) {
    playerLast=0;playerRaf=requestAnimationFrame(tickPlayers);
  }
}
function tickPlayers(now) {
  playerRaf=0;
  if(document.hidden || motionPreference.matches)return;
  const elapsed=playerLast ? now-playerLast : 0;
  if(playerLast && elapsed<1000/30){playerRaf=requestAnimationFrame(tickPlayers);return;}
  const dt=Math.min(.08,elapsed/1000);playerLast=now;
  let visible=false;
  players.forEach((p,canvas)=>{
    if(!canvas.isConnected){p.stop();return;}
    if(!p.visible)return;visible=true;
    if(p.options.active && !p.options.active())return;
    p.time+=dt;drawFish(p.ctx,p.spec,p.time,p.options);
  });
  if(players.size&&visible)playerRaf=requestAnimationFrame(tickPlayers);
}
function animate(canvas,spec,options) {
  if(!motionPreference){
    motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
    playerObserver=new IntersectionObserver(entries=>{
      entries.forEach(e=>{const p=players.get(e.target);if(p)p.visible=e.isIntersecting;});wakePlayers();
    });
    motionPreference.addEventListener('change',()=>{
      if(playerRaf)cancelAnimationFrame(playerRaf);playerRaf=0;
      players.forEach(p=>drawFish(p.ctx,p.spec,0));wakePlayers();
    });
    document.addEventListener('visibilitychange',()=>{
      if(playerRaf)cancelAnimationFrame(playerRaf);playerRaf=0;wakePlayers();
    });
  }
  if(players.has(canvas))players.get(canvas).stop();
  const p={ctx:canvas.getContext('2d'),spec,options:options||{},time:0,visible:false};
  p.stop=()=>{
    if(players.get(canvas)!==p)return;
    players.delete(canvas);playerObserver.unobserve(canvas);pending.delete(p.ctx);
    if(!players.size&&playerRaf){cancelAnimationFrame(playerRaf);playerRaf=0;}
  };
  players.set(canvas,p);playerObserver.observe(canvas);drawFish(p.ctx,spec,0);wakePlayers();
  return p.stop;
}
const API = { hashId, fishSpriteSpec, drawFish, animate, swimPoint, ready, ATLAS_URL, ATLAS_RECTS,
  FAMILY_PROFILES, BODY_SHAPES, FIN_SHAPES, TAIL_SHAPES, PATTERNS, PALETTES, SHINY_PALETTES, EYES, ACCENTS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') { window.FishSprite = API; ready(); }
})();
