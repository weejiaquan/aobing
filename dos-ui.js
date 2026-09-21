/* DOS game chrome; economy and mode switching remain in app.js. */
(() => {
  'use strict';
  const el = id => document.getElementById('dos-' + id);
  const t = (key, params) => I18N.t(key, params);
  let deps, opened = false, runtime = null, generation = 0, stopping = Promise.resolve();
  let selectedWad = null, sessionWad = null, lastSource = null, statusKey = '', statusParams;
  let fullscreenOwned = false;
  const bindingStore = 'aobing-doom-bindings-v1';
  let bindings = DosBindings.fresh(), sessionBindings = bindings, draft = null, listening = null;
  const panel = el('panel'), canvas = el('canvas');
  const blocked = () => document.hidden || !!document.querySelector('dialog[open],.ui-window-open,.merge-overlay,#app-modal:not([hidden])');
  function keyLabel(code) {
    if (code.startsWith('Key')) return code.slice(3);
    if (code === 'Space') return t('dos.key_space');
    if (code === 'ShiftLeft') return 'Shift';
    return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code] || code;
  }
  function updateBindings() {
    const active = runtime?.ci ? sessionBindings : bindings;
    el('binding-summary').textContent = DosBindings.actions.map(action => t('dos.' + action) + ': ' + keyLabel(active.keys[action])).join(' · ');
    panel.querySelectorAll('[data-dos-label-key]').forEach(button => {
      button.textContent = keyLabel(active.keys[button.dataset.dosAction]);
    });
  }
  function renderRemap() {
    const rows = el('binding-rows'); rows.replaceChildren();
    for (const action of DosBindings.actions) {
      const row = document.createElement('div'), label = document.createElement('span'), button = document.createElement('button');
      label.id = 'dos-bind-label-' + action; label.textContent = t('dos.' + action);
      button.type = 'button'; button.dataset.bindAction = action;
      button.setAttribute('aria-labelledby', label.id + ' dos-bind-key-' + action); button.id = 'dos-bind-key-' + action;
      button.textContent = listening === action ? t('dos.remap_listening') : keyLabel(draft.keys[action]);
      button.classList.toggle('dos-listening', listening === action);
      button.addEventListener('click', () => { listening = action; el('binding-status').textContent = t('dos.remap_listening'); renderRemap(); el('bind-key-' + action).focus(); });
      row.append(label, button); rows.append(row);
    }
    panel.querySelectorAll('[data-dos-mouse]').forEach(select => { select.value = draft.mouse[Number(select.dataset.dosMouse)]; });
  }
  function openRemap() {
    pause(); draft = DosBindings.restore(bindings); listening = null;
    renderRemap(); el('binding-status').textContent = ''; el('controls-dialog').showModal();
  }
  function status(key, params) {
    statusKey = key; statusParams = params;
    el('status').textContent = key ? t(key, params) : '';
    el('overlay').querySelector('p').textContent = key ? t(key, params) : t('dos.overlay_hint');
  }
  function screen(state) {
    panel.dataset.state = state;
    el('setup').hidden = state !== 'setup';
    el('player').hidden = state === 'setup';
    el('overlay').hidden = state === 'playing';
    el('resume').hidden = state !== 'paused';
    el('retry').hidden = state !== 'error';
    el('pause').disabled = state !== 'playing';
    el('menu').disabled = state !== 'playing' && state !== 'paused';
    el('fullscreen').disabled = state === 'setup';
    el('touch').inert = state !== 'playing';
  }
  function pause() {
    if (!runtime?.ci || panel.dataset.state !== 'playing') return;
    runtime.pause(); screen('paused'); status('dos.paused'); runtime.save();
  }
  function resume() {
    if (!runtime?.ci || blocked()) return;
    deps.pauseBgm();
    runtime.resume(Number(deps.settings.sfxVol ?? 50) / 100); screen('playing'); status(''); canvas.focus({ preventScroll: true });
  }
  async function end() {
    generation++;
    const old = runtime; runtime = null;
    if (old) stopping = Promise.allSettled([stopping, old.stop()]).then(() => {});
    screen('setup'); status(''); updateBindings();
    if (fullscreenOwned && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    fullscreenOwned = false;
    await stopping;
  }
  async function play(wad) {
    const ticket = ++generation;
    lastSource = wad;
    screen('loading'); status('dos.loading'); el('save-warning').hidden = true;
    // Runtime construction unlocks audio within this click, before any download.
    let next;
    try {
      next = new DosRuntime.Runtime(canvas, {
        storageError: () => { if (ticket === generation) el('save-warning').hidden = false; },
        error: key => { if (ticket === generation) { screen('error'); status(key || 'dos.load_error'); } },
        exit: () => { if (ticket === generation) { end(); status('dos.ended'); } }
      });
      const old = runtime; runtime = next;
      if (old) stopping = Promise.allSettled([stopping, old.stop()]).then(() => {});
      await stopping;
      if (ticket !== generation || !opened) { await next.stop(); return; }
      sessionWad = wad;
      sessionBindings = DosBindings.restore(bindings);
      el('campaign').textContent = wad ? t('dos.owned_campaign') : t('dos.free_campaign');
      const game = { ...DosGames.doom, configOverrides: { ...DosGames.doom.configOverrides,
        'AOBING.CFG': { ...DosGames.doom.configOverrides['AOBING.CFG'], ...DosBindings.overrides(sessionBindings) } } };
      await next.start(game, wad);
      if (ticket !== generation || !opened) { await next.stop(); return; }
      screen('paused'); status('dos.ready');
      updateBindings();
      el('resume').focus({ preventScroll: true });
    } catch (error) {
      if (next) await next.stop().catch(() => {});
      if (ticket !== generation || !opened) return;
      runtime = null; screen('error'); status('dos.load_error');
      console.error('DOS launch failed', error); el('retry').focus();
    }
  }
  async function selectWad() {
    const file = el('wad').files[0]; selectedWad = null; el('play-wad').disabled = true;
    const ticket = ++generation;
    if (!file) return;
    try {
      if (file.size > DosRuntime.MAX_WAD_BYTES) throw new Error('dos.invalid_wad');
      const bytes = new Uint8Array(await file.arrayBuffer()); DosRuntime.validateWad(bytes);
      if (ticket !== generation) return;
      selectedWad = bytes; el('play-wad').disabled = false; status('dos.selected', { name: file.name });
    } catch (_) { if (ticket === generation) status('dos.invalid_wad'); }
  }
  function init(value) {
    if (deps) return; deps = value;
    try { bindings = DosBindings.restore(JSON.parse(localStorage.getItem(bindingStore))); } catch (_) {}
    sessionBindings = DosBindings.restore(bindings); updateBindings();
    el('remap').addEventListener('click', openRemap);
    el('bindings-cancel').addEventListener('click', () => el('controls-dialog').close());
    el('controls-dialog').addEventListener('close', () => { listening = null; draft = null; });
    el('controls-dialog').addEventListener('click', event => {
      if (event.target !== el('controls-dialog')) return;
      const r = event.target.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close();
    });
    el('bindings-reset').addEventListener('click', () => { draft = DosBindings.fresh(); listening = null; renderRemap(); });
    panel.querySelectorAll('[data-dos-mouse]').forEach(select => select.addEventListener('change', () => {
      listening = null; draft.mouse[Number(select.dataset.dosMouse)] = select.value; renderRemap();
    }));
    el('bindings-save').addEventListener('click', () => {
      try { localStorage.setItem(bindingStore, JSON.stringify(draft)); }
      catch (_) { el('binding-status').textContent = t('dos.remap_storage_error'); return; }
      bindings = DosBindings.restore(draft); updateBindings(); el('controls-dialog').close();
    });
    window.addEventListener('keydown', event => {
      if (!el('controls-dialog').open || !listening) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      const action = listening;
      if (event.code === 'Escape') { listening = null; el('binding-status').textContent = ''; }
      else {
        const error = event.ctrlKey || event.altKey || event.metaKey ? 'dos.remap_reserved' : DosBindings.assign(draft, action, event.code);
        el('binding-status').textContent = error ? t(error) : '';
        if (!error) listening = null;
      }
      renderRemap(); el('bind-key-' + action).focus();
    }, true);
    el('play-free').addEventListener('click', () => play(null));
    el('play-wad').addEventListener('click', () => { if (selectedWad) play(selectedWad); });
    el('wad').addEventListener('change', selectWad);
    el('resume').addEventListener('click', resume);
    el('pause').addEventListener('click', () => { pause(); el('resume').focus(); });
    el('retry').addEventListener('click', () => play(lastSource));
    el('end').addEventListener('click', () => { end(); el('play-free').focus(); });
    el('back').addEventListener('click', () => window.dispatchEvent(new CustomEvent('aobinglaunch', { detail: 'clicker' })));
    el('library').addEventListener('click', () => document.getElementById('hub-launch').click());
    el('settings').addEventListener('click', () => document.getElementById('settings-btn').click());
    el('menu').addEventListener('click', () => { resume(); runtime?.ci?.simulateKeyPress(256); });
    el('fullscreen').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) { await document.exitFullscreen(); fullscreenOwned = false; }
        else { await document.documentElement.requestFullscreen(); fullscreenOwned = true; }
      } catch (_) { status('dos.fullscreen_error'); }
    });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) fullscreenOwned = false; });
    canvas.addEventListener('pointerdown', (event) => {
      if (runtime?.paused || blocked()) return;
      canvas.focus();
      if (event.pointerType === 'mouse') {
        if (document.pointerLockElement !== canvas) { if (event.button === 0) canvas.requestPointerLock?.()?.catch?.(() => {}); return; }
      }
    });
    // Mouse events report every button transition; pointer events only report
    // the first press and final release when several mouse buttons are held.
    canvas.addEventListener('mousedown', event => {
      if (!runtime?.ci || runtime.paused || blocked() || document.pointerLockElement !== canvas) return;
      event.preventDefault();
      const action = sessionBindings.mouse[event.button];
      if (action && action !== 'none') runtime.key('mouse:' + event.button, DosRuntime.keyCode(sessionBindings.keys[action]), true);
    });
    window.addEventListener('mouseup', event => runtime?.key('mouse:' + event.button, 0, false));
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    document.addEventListener('mousemove', event => {
      if (document.pointerLockElement === canvas && !runtime?.paused && !blocked()) runtime?.moveMouse(event.movementX);
    });
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) pause(); });
    window.addEventListener('keydown', event => {
      if (!opened || blocked()) return;
      if (event.key === 'Escape' && panel.dataset.state === 'playing') {
        event.preventDefault(); event.stopImmediatePropagation(); pause(); el('resume').focus(); return;
      }
      if (event.target !== canvas || runtime?.paused || event.metaKey) return;
      // Tab remains browser navigation; releasing focus pauses play.
      if (event.code === 'Tab') return;
      const code = DosRuntime.keyCode(event.code);
      if (code !== null) { event.preventDefault(); event.stopImmediatePropagation(); runtime.key('key:' + event.code, code, true); }
    }, true);
    window.addEventListener('keyup', event => runtime?.key('key:' + event.code, 0, false), true);
    canvas.addEventListener('blur', () => { if (document.pointerLockElement !== canvas) pause(); });
    // Pointer controls keep canvas focus and support several held touches at once.
    let weapon = 1;
    panel.querySelectorAll('[data-dos-key]').forEach(button => {
        const buttonKey = () => button.dataset.dosAction ? DosRuntime.keyCode(sessionBindings.keys[button.dataset.dosAction]) :
          Number(button.dataset.dosKey) === 47 ? 49 + ((weapon++) % 7) : Number(button.dataset.dosKey);
      button.addEventListener('pointerdown', event => {
        if (runtime?.paused || blocked()) return;
        event.preventDefault(); button.setPointerCapture(event.pointerId);
        runtime.key('touch:' + event.pointerId, buttonKey(), true);
      });
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, event => runtime?.key('touch:' + event.pointerId, 0, false));
      button.addEventListener('click', event => { if (event.detail === 0 && !runtime?.paused && !blocked()) runtime?.ci?.simulateKeyPress(buttonKey()); });
    });
    window.addEventListener('blur', pause);
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
    window.addEventListener('pagehide', () => { pause(); runtime?.save(); });
    new MutationObserver(() => { if (opened && blocked()) pause(); }).observe(document.body, {
      subtree: true, attributes: true, attributeFilter: ['class', 'open', 'hidden']
    });
    window.addEventListener('i18nchange', () => {
      updateBindings(); if (draft) renderRemap();
      status(statusKey, statusParams);
      el('campaign').textContent = sessionWad ? t('dos.owned_campaign') : t('dos.free_campaign');
    });
    screen('setup');
  }
  function open() {
    if (opened) return; opened = true; panel.hidden = false;
    deps.captureKeyboard(true); deps.pauseBgm(); screen('setup');
    updateBindings();
    el('play-free').focus({ preventScroll: true });
  }
  function close() {
    if (!opened) return; opened = false; end(); panel.hidden = true;
    if (el('controls-dialog').open) el('controls-dialog').close();
    selectedWad = null; sessionWad = null; lastSource = null; el('wad').value = ''; el('play-wad').disabled = true;
    deps.captureKeyboard(false); deps.resumeBgm();
  }
  window.DoomGame = { init, open, close };
  if (window.__doomDeps) init(window.__doomDeps);
})();
