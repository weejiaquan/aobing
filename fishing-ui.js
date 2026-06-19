'use strict';
// DOM/canvas controller for the Fishing mode. Exposes window.FishingGame.
// All game rules live in fishing-session.js / fishing.js; this is render + input.
(function () {
  var deps = null;
  var els = {};
  var session = null;
  var input = { cast: false, holding: false };
  var rng = Math.random; // production randomness; engine stays pure via injection
  var raf = 0;
  var lastT = 0;
  var open = false;
  var sprites = {}; // cache: speciesId -> { spec, drawnFloat }
  var miyuImg = null;

  function el(id) { return document.getElementById(id); }

  function init(d) {
    deps = d;
    els.panel = el('fishing-panel');
    els.canvas = el('fishing-canvas');
    els.cast = el('fishing-cast-btn');
    els.exit = el('fishing-exit');
    els.result = el('fishing-result');
    els.ctx = els.canvas.getContext('2d');
    session = window.FishingSession.createSession();
    bindEvents();
    if (window.FishingDexUI && window.FishingDexUI.init) window.FishingDexUI.init(d);
    var dexBtn = document.getElementById('fishing-dex-btn');
    if (dexBtn) dexBtn.addEventListener('click', function () {
      if (window.FishingDexUI && window.FishingDexUI.open) window.FishingDexUI.open();
    });
  }

  function bindEvents() {
    els.cast.addEventListener('click', onCastPress);
    els.exit.addEventListener('click', function () {
      deps.settings.gameMode = 'clicker';
      deps.saveSettings();
      doClose();
      // return to clicker UI: reuse the app's mode menu by simulating its switch
      if (window.applyMode) window.applyMode('clicker');
    });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    els.canvas.addEventListener('pointerdown', onPointerDown);
    els.canvas.addEventListener('pointerup', onPointerUp);
    els.canvas.addEventListener('pointercancel', onPointerUp);
  }

  // A "cast press" is the discrete action used to cast, hook, and dismiss.
  function onCastPress() { if (!open) return; input.cast = true; }

  function onKeyDown(e) {
    if (!open) return;
    if (e.code === 'Space') { e.preventDefault(); input.holding = true; input.cast = true; }
  }
  function onKeyUp(e) {
    if (!open) return;
    if (e.code === 'Space') { e.preventDefault(); input.holding = false; }
  }
  function onPointerDown(e) { if (!open) return; input.holding = true; input.cast = true; }
  function onPointerUp(e) { if (!open) return; input.holding = false; }

  function sessionCtx() {
    return { table: window.FishData.FISH, hasCaught: function (id) { return !!deps.getFishdex()[id]; } };
  }

  function loop(now) {
    if (!open) return;
    var dt = Math.min(0.05, (now - lastT) / 1000) || 0;
    lastT = now;
    var r = window.FishingSession.step(session, dt, input, rng, sessionCtx());
    session = r.state;
    for (var i = 0; i < r.events.length; i++) handleEvent(r.events[i]);
    input.cast = false; // consume the discrete press each frame
    render(now);
    raf = requestAnimationFrame(loop);
  }

  function handleEvent(ev) {
    if (ev.type === 'cast' || ev.type === 'bite' || ev.type === 'hooked') {
      hideResult();
      try { deps.playSfx(); } catch (e) {}
    } else if (ev.type === 'caught') {
      try { deps.playSfx(); } catch (e) {}
      deps.recordCatch(ev.specimen, ev.coins, ev.isNew);
      showResult(ev);
    } else if (ev.type === 'escaped') {
      showResult({ type: 'escaped' });
    } else if (ev.type === 'missed') {
      // brief flash handled by render; no popup
    }
  }

  function showResult(ev) {
    var h = deps.escapeHtml;
    if (ev.type === 'escaped') {
      els.result.innerHTML = '<div>It got away…</div>';
    } else {
      var s = ev.specimen, f = ev.fish;
      els.result.innerHTML =
        '<canvas id="fishing-result-sprite" width="130" height="84" style="display:block;margin:0 auto 8px"></canvas>' +
        '<div style="font-size:18px">' + h(f.name) + (s.shiny ? ' <span class="fr-new">✨ SHINY</span>' : '') + '</div>' +
        '<div>' + s.size.toFixed(1) + ' cm · ' + h(s.grade) + ' (float ' + s.float.toFixed(3) + ')</div>' +
        '<div class="fr-coins">+' + ev.coins + ' 🪙</div>' +
        (ev.isNew ? '<div class="fr-new">NEW! added to your Fishdex</div>' : '');
      var cv = document.getElementById('fishing-result-sprite');
      if (cv && window.FishSprite && window.FishSprite.drawFish) {
        try { window.FishSprite.drawFish(cv.getContext('2d'), spriteFor(f, s.float, s.shiny), 0); } catch (e) {}
      }
    }
    els.result.classList.add('show');
  }
  function hideResult() { els.result.classList.remove('show'); }

  function spriteFor(fish, float, shiny) {
    var key = fish.id + '|' + float.toFixed(3) + '|' + (shiny ? 1 : 0);
    if (!sprites[key]) {
      if (Object.keys(sprites).length > 64) sprites = {};
      sprites[key] = window.FishSprite.fishSpriteSpec(fish, { float: float, shiny: shiny });
    }
    return sprites[key];
  }

  function render(now) {
    var c = els.ctx, W = els.canvas.width, H = els.canvas.height;
    // keep the backing store sized to the element
    if (els.canvas.width !== els.canvas.clientWidth || els.canvas.height !== els.canvas.clientHeight) {
      els.canvas.width = els.canvas.clientWidth; els.canvas.height = els.canvas.clientHeight;
      W = els.canvas.width; H = els.canvas.height;
    }
    // water background
    var g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b2236'); g.addColorStop(1, '#06121c');
    c.fillStyle = g; c.fillRect(0, 0, W, H);

    // Miyu sprite (swim variant), idle vs active by phase
    drawMiyu(c, W, H);

    var phase = session.phase;
    // bobber while waiting / bite
    if (phase === 'casting' || phase === 'waiting' || phase === 'bite') {
      drawBobber(c, W, H, phase === 'bite', now);
    }
    // bar-balance HUD while balancing
    if (phase === 'balancing' && session.bar) {
      drawBar(c, W, H, session.bar);
    }
    // cast button visibility: only actionable in idle/result
    els.cast.style.display = (phase === 'idle' || phase === 'result') ? '' : 'none';
  }

  function drawMiyu(c, W, H) {
    if (!miyuImg) {
      miyuImg = new Image();
    }
    var v = deps.getVariant(deps.getSkin()).variant;
    var active = (session.phase === 'bite' || session.phase === 'balancing');
    var src = active ? (v.active || v.idle) : v.idle;
    if (miyuImg.getAttribute('data-src') !== src) { miyuImg.setAttribute('data-src', src); miyuImg.src = src; }
    if (miyuImg.complete && miyuImg.naturalWidth) {
      var h = Math.min(H * 0.6, 420), w = h * (miyuImg.naturalWidth / miyuImg.naturalHeight);
      c.drawImage(miyuImg, W * 0.12, H - h - 10, w, h);
    }
  }

  function drawBobber(c, W, H, biting, now) {
    var x = W * 0.62, y = H * 0.55 + Math.sin(now / 300) * (biting ? 10 : 3);
    c.fillStyle = biting ? '#ff5a5a' : '#ffd770';
    c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.5)'; c.beginPath(); c.moveTo(W * 0.28, H * 0.42); c.lineTo(x, y); c.stroke();
    if (biting) { c.fillStyle = '#ff5a5a'; c.font = '20px system-ui'; c.fillText('!', x + 14, y - 10); }
  }

  function drawBar(c, W, H, bar) {
    // vertical track on the right
    var trackX = W - 70, trackY = H * 0.18, trackH = H * 0.64, trackW = 26;
    c.fillStyle = 'rgba(255,255,255,.10)'; c.fillRect(trackX, trackY, trackW, trackH);
    // helper: normalized pos (0 bottom .. 1 top) -> y
    function py(p) { return trackY + (1 - p) * trackH; }
    // catch bar (green)
    var barSize = bar.tier.barSize, barPos = bar.bar.pos;
    c.fillStyle = 'rgba(90,220,140,.45)';
    c.fillRect(trackX, py(barPos + barSize), trackW, barSize * trackH);
    // fish marker
    var fp = bar.fish_.pos;
    c.fillStyle = '#ffd770';
    c.beginPath(); c.arc(trackX + trackW / 2, py(fp), 9, 0, Math.PI * 2); c.fill();
    // progress meter (left of track)
    var pmX = trackX - 16;
    c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(pmX, trackY, 8, trackH);
    c.fillStyle = '#2b86c5'; c.fillRect(pmX, py(bar.progress), 8, bar.progress * trackH);
  }

  function doOpen() {
    if (open) return;
    open = true;
    els.panel.classList.add('open');
    document.body.classList.add('music-mode');
    deps.captureKeyboard(true);
    deps.pauseBgm();
    session = window.FishingSession.createSession();
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function doClose() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf); raf = 0;
    els.panel.classList.remove('open');
    document.body.classList.remove('music-mode');
    hideResult();
    deps.captureKeyboard(false);
    deps.resumeBgm();
    input.cast = false; input.holding = false;
    if (window.FishingDexUI && window.FishingDexUI.close) window.FishingDexUI.close();
  }

  window.FishingGame = { init: init, open: doOpen, close: doClose };
})();
