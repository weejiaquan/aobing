/* Reusable js-dos host. Runtime binaries are loaded only when a game starts. */
(function (root) {
  'use strict';
  const MAX_WAD_BYTES = 64 * 1024 * 1024;
  function validateWad(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > MAX_WAD_BYTES) throw new Error('dos.invalid_wad');
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'IWAD') throw new Error('dos.invalid_wad');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(4, true), offset = view.getUint32(8, true);
    if (!count || count > 100000 || offset < 12 || offset + count * 16 > bytes.length) throw new Error('dos.invalid_wad');
    let doomMap = false;
    for (let i = 0; i < count; i++) {
      const at = offset + i * 16, start = view.getUint32(at, true), size = view.getUint32(at + 4, true);
      if (start + size > bytes.length) throw new Error('dos.invalid_wad');
      const name = String.fromCharCode(...bytes.subarray(at + 8, at + 16)).replace(/\0.*$/, '');
      if (name === 'E1M1' || name === 'MAP01') doomMap = true;
    }
    if (!doomMap) throw new Error('dos.invalid_wad');
    return true;
  }
  function wadFilename(bytes) {
    validateWad(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), names = new Set();
    for (let i = 0; i < view.getUint32(4, true); i++) {
      const at = view.getUint32(8, true) + i * 16 + 8;
      names.add(String.fromCharCode(...bytes.subarray(at, at + 8)).replace(/\0.*$/, ''));
    }
    if (names.has('FREEDOOM')) return names.has('MAP01') ? 'FREEDM2.WAD' : 'FREEDM1.WAD';
    return names.has('MAP01') ? 'DOOM2.WAD' : names.has('E4M1') ? 'DOOMU.WAD' : names.has('E3M1') ? 'DOOM.WAD' : 'DOOM1.WAD';
  }
  const specialKeys = { Enter: 257, Escape: 256, Tab: 258, Backspace: 259, ArrowRight: 262, ArrowLeft: 263,
    ArrowDown: 264, ArrowUp: 265, Space: 32, ShiftLeft: 340, ShiftRight: 344, ControlLeft: 341,
    ControlRight: 345, AltLeft: 342, AltRight: 346, Minus: 45, Equal: 61, Comma: 44, Period: 46, Slash: 47 };
  function keyCode(code) {
    if (specialKeys[code] !== undefined) return specialKeys[code];
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return 289 + Number(code.slice(1));
    return null;
  }
  function savePaths(tree, prefix = '') {
    const paths = [];
    for (const node of tree.nodes || []) {
      const path = prefix + node.name;
      if (node.nodes) paths.push(...savePaths(node, path + '/'));
      else if (/\.(dsg|cfg)$/i.test(path) && !path.startsWith('.jsdos/') && node.size <= 4 * 1024 * 1024) paths.push(path);
    }
    return paths;
  }
  function patchConfig(bytes, overrides) {
    let text = new TextDecoder().decode(bytes);
    for (const [key, value] of Object.entries(overrides)) {
      if (!/^[a-z_]+$/.test(key) || !Number.isInteger(value)) throw new Error('Invalid DOS config override');
      const line = new RegExp('^[ \\t]*' + key + '[ \\t]+[^\\r\\n]*', 'gm');
      if (line.test(text)) text = text.replace(line, key + ' ' + value);
      else text += '\n' + key + ' ' + value + '\n';
    }
    return new TextEncoder().encode(text);
  }
  function isFatalOutput(message) {
    return /AOBING_FATAL:|=+APP\/32=|\[panic\]/.test(String(message));
  }
  const api = { validateWad, wadFilename, keyCode, savePaths, patchConfig, isFatalOutput, MAX_WAD_BYTES };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  let library;
  function loadEngine() {
    if (root.emulators) return Promise.resolve();
    if (!library) library = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('games/dos/engine/emulators.js', document.baseURI).href;
      script.onload = resolve;
      script.onerror = () => { script.remove(); library = null; reject(new Error('dos.load_error')); };
      document.head.appendChild(script);
    });
    return library;
  }
  function store(mode, key, value) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('aobing-dos', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('saves');
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Storage blocked'));
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('saves', mode);
        const op = mode === 'readonly' ? tx.objectStore('saves').get(key) : tx.objectStore('saves').put(value, key);
        tx.oncomplete = () => { db.close(); resolve(op.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  function bounded(promise, ms = 5000) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DOS operation timed out')), ms);
    })]).finally(() => clearTimeout(timer));
  }
  class Runtime {
    constructor(canvas, callbacks = {}) {
      this.canvas = canvas; this.callbacks = callbacks; this.held = new Map(); this.sources = new Set();
      this.cancelled = false; this.paused = true; this.controller = new AbortController(); this.saveQueue = Promise.resolve();
      this.audio = new (root.AudioContext || root.webkitAudioContext)();
      this.gain = this.audio.createGain(); this.gain.connect(this.audio.destination);
      this.audio.resume().catch(() => {});
    }
    async start(game, wad) {
      this.game = game;
      const hash = wad ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wad))).map(b => b.toString(16).padStart(2, '0')).join('') : game.contentId;
      this.saveKey = game.id + ':' + game.saveVersion + ':' + hash;
      const filename = wad ? wadFilename(wad) : game.filename;
      const download = async (url) => {
        const response = await fetch(url, { signal: this.controller.signal });
        if (!response.ok) throw new Error('dos.load_error');
        return new Uint8Array(await response.arrayBuffer());
      };
      const [engine, content, saved] = await Promise.all([
        download(game.engine), wad ? Promise.resolve({ path: filename, contents: wad }) : download(game.content),
        bounded(store('readonly', this.saveKey)).catch(() => { this.callbacks.storageError?.(); return null; }), loadEngine()
      ]);
      if (this.cancelled) return;
      // Bundles are extracted after loose startup files. Keep editable config
      // at a path absent from the bundle, migrating earlier saved settings.
      const previous = saved || [];
      const restored = previous.filter(file => {
        const target = game.configMigrations?.[file.path.toUpperCase()];
        return !target || !previous.some(other => other.path.toUpperCase() === target.toUpperCase());
      }).map(file => {
        const target = game.configMigrations?.[file.path.toUpperCase()];
        if (target) file = { ...file, path: target };
        const overrides = game.configOverrides?.[file.path.toUpperCase()];
        return overrides ? { ...file, contents: patchConfig(file.contents, overrides) } : file;
      });
      for (const [path, text] of Object.entries(game.configDefaults || {})) {
        if (!restored.some(file => file.path.toUpperCase() === path.toUpperCase())) {
          restored.push({ path, contents: patchConfig(new TextEncoder().encode(text), game.configOverrides?.[path.toUpperCase()] || {}) });
        }
      }
      const files = [engine, content, ...restored, { path: '.jsdos/dosbox.conf', contents: new TextEncoder().encode(game.config.replace('{iwad}', filename)) }];
      // Use the public transport API with a same-origin Worker. This avoids the
      // default factory's eval/blob loader and lets us terminate even a crashed
      // or half-started emulator. No shared memory / COOP / COEP is required.
      const wasm = await WebAssembly.compile(await download('games/dos/engine/wdosbox.wasm'));
      if (this.cancelled) return;
      const worker = this.worker = new Worker(new URL('games/dos/engine/wdosbox.js', document.baseURI));
      const sessionId = crypto.randomUUID();
      let handler, queue = [];
      worker.onmessage = async event => {
        const { name, props } = event.data;
        if (!name) return;
        // The backend terminates the worker on ws-exit, but its onExit event
        // only fires after a host-requested exit. Flush native Quit saves first.
        if (name === 'ws-exit' && this.ci && !this.cancelled) {
          clearInterval(this.timer); this.pause(); await this.save();
        }
        if (handler) handler(name, props); else queue.push([name, props]);
      };
      const failed = new Promise((_, reject) => { this.rejectStart = reject; });
      worker.onerror = event => { event.preventDefault(); this.fail(); };
      const transport = {
        sessionId, net: null,
        sendMessageToServer: (name, props, transfer) => {
          const send = () => worker.postMessage({ name, props }, transfer || []);
          // The backend retries sleep until its deadline. An immediate reply
          // creates a busy message loop; let the browser yield between retries.
          if (name === 'wc-sync-sleep') this.wakeTimer = setTimeout(send, 1);
          else send();
        },
        initMessageHandler: callback => { handler = callback; for (const args of queue) handler(...args); queue = []; },
        exit: () => {
          clearTimeout(this.wakeTimer); worker.terminate(); clearInterval(this.timer); this.ci = null;
          if (!this.cancelled) { this.pause(); this.callbacks.exit?.(); }
        }
      };
      worker.postMessage({ name: 'wc-install', props: { module: wasm, sessionId } });
      const ci = await bounded(Promise.race([root.emulators.backend(files, transport), failed]), 30000);
      this.rejectStart = null;
      if (this.cancelled) { clearTimeout(this.wakeTimer); worker.terminate(); return; }
      this.ci = ci;
      const context = this.canvas.getContext('2d', { alpha: false });
      let pixels;
      const resize = (w, h) => { this.canvas.width = w; this.canvas.height = h; pixels = context.createImageData(w, h); };
      resize(ci.width() || 320, ci.height() || 200);
      ci.events().onFrameSize(resize);
      ci.events().onFrame((rgb, rgba) => {
        if (this.cancelled || !pixels) return;
        if (rgba) pixels.data.set(rgba);
        else if (rgb) {
          for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
            pixels.data[j] = rgb[i]; pixels.data[j + 1] = rgb[i + 1]; pixels.data[j + 2] = rgb[i + 2]; pixels.data[j + 3] = 255;
          }
        } else return;
        context.putImageData(pixels, 0, 0);
      });
      ci.events().onSoundPush(samples => this.sound(samples));
      ci.events().onStdout(message => { if (isFatalOutput(message)) this.fail(); });
      ci.events().onMessage((type, message) => {
        if (type === 'error' && isFatalOutput(message)) this.fail();
      });
      ci.events().onUnload(() => this.save());
      ci.events().onExit(() => {
        clearInterval(this.timer); this.ci = null;
        if (!this.cancelled) { this.pause(); this.callbacks.exit?.(); }
      });
      this.pause();
      this.timer = setInterval(() => this.save(), 15000);
    }
    fail() {
      if (this.cancelled || this.crashed) return;
      this.crashed = true; this.pause(); clearInterval(this.timer); clearTimeout(this.wakeTimer); this.worker?.terminate(); this.ci = null;
      this.audio.close().catch(() => {});
      if (this.rejectStart) this.rejectStart(new Error('dos.load_error'));
      else this.callbacks.error?.('dos.runtime_error');
    }
    sound(samples) {
      if (this.cancelled || this.paused || this.audio.state !== 'running') return;
      const now = this.audio.currentTime;
      if (this.nextSound > now + .25) return;
      if (!samples.length) return;
      // js-dos onSoundPush supplies MONO samples, not interleaved stereo.
      // Splitting them in two doubles their pitch and leaves gaps every chunk.
      const buffer = this.audio.createBuffer(1, samples.length, this.ci.soundFrequency());
      buffer.getChannelData(0).set(samples);
      const source = this.audio.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
      this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
      // Keep consecutive chunks contiguous. Only prebuffer at startup or after
      // an underrun; imposing a fresh delay on every chunk creates more gaps.
      const at = this.nextSound > now ? this.nextSound : now + .04;
      source.start(at); this.nextSound = at + buffer.duration;
    }
    key(source, code, down) {
      if (down) {
        if (this.paused || !this.ci || this.held.has(source)) return;
        if (![...this.held.values()].includes(code)) this.ci.sendKeyEvent(code, true);
        this.held.set(source, code);
      } else {
        const old = this.held.get(source); this.held.delete(source);
        if (old !== undefined && ![...this.held.values()].includes(old)) this.ci?.sendKeyEvent(old, false);
      }
    }
    moveMouse(dx) {
      if (this.paused || this.cancelled || !this.ci || !Number.isFinite(dx)) return;
      // Merge high-polling mouse input into one worker message per display
      // frame. Bound discontinuities on capture/monitor changes; don't queue
      // old movement for later frames, which would feel like stuck controls.
      this.mouseDelta = Math.max(-200, Math.min(200, (this.mouseDelta || 0) + Math.max(-50, Math.min(50, dx))));
      if (this.mouseFrame) return;
      this.mouseFrame = requestAnimationFrame(() => {
        this.mouseFrame = 0;
        const delta = this.mouseDelta; this.mouseDelta = 0;
        if (delta && !this.paused && !this.cancelled) this.ci?.sendMouseRelativeMotion(delta, 0);
      });
    }
    clearInput() {
      if (this.mouseFrame) cancelAnimationFrame(this.mouseFrame);
      this.mouseFrame = 0; this.mouseDelta = 0;
      for (const code of new Set(this.held.values())) this.ci?.sendKeyEvent(code, false);
      this.held.clear(); this.ci?.sendMouseButton(0, false);
    }
    pause() {
      this.clearInput(); this.paused = true; this.ci?.pause();
      for (const source of this.sources) { try { source.stop(); } catch (_) {} }
      this.sources.clear(); this.nextSound = 0;
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    }
    resume(volume) {
      if (!this.ci || this.cancelled) return;
      this.gain.gain.value = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : .5;
      this.audio.resume().catch(() => {}); this.paused = false; this.ci.resume();
    }
    save() {
      const ci = this.ci;
      if (!ci) return this.saveQueue;
      // Filesystem RPCs must not overlap, including periodic saves and shutdown.
      this.saveQueue = this.saveQueue.then(async () => {
        const files = [];
        for (const path of savePaths(await bounded(ci.fsTree()))) files.push({ path, contents: await bounded(ci.fsReadFile(path)) });
        await bounded(store('readwrite', this.saveKey, files));
      }).catch(() => this.callbacks.storageError?.());
      return this.saveQueue;
    }
    async stop() {
      if (this.stopping) return this.stopping;
      this.cancelled = true; this.controller.abort(); clearInterval(this.timer); this.pause();
      this.rejectStart?.(new DOMException('Cancelled', 'AbortError'));
      if (!this.ci) { clearTimeout(this.wakeTimer); this.worker?.terminate(); }
      this.stopping = (async () => {
        try { if (this.ci) { await this.save(); if (this.ci) await bounded(this.ci.exit()); } }
        finally { clearTimeout(this.wakeTimer); this.worker?.terminate(); await this.audio.close().catch(() => {}); this.ci = null; }
      })();
      return this.stopping;
    }
  }
  root.DosRuntime = { ...api, Runtime };
})(typeof window !== 'undefined' ? window : globalThis);
