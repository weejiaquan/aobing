    // BUILD MARKER (temporary) — app.js is cache-busted in the Activity, so this tells you
    // app.js freshness independently of the (cached) index.html's window.__BUILD__.
    console.log('%c[aobing] app.js BUILD b1', 'color:#2b8a3e;font-weight:bold');
    window.__BUILD_APP__ = 'b1';
    // Firebase App Check: prove writes come from this real site (not curl / console scripts).
    // On localhost we emit a debug token — paste it into Firebase Console →
    // App Check → Apps → ⋯ → Manage debug tokens to allow local dev.
    const APPCHECK_HOSTS_DEBUG = ['localhost', '127.0.0.1', ''];
    if (APPCHECK_HOSTS_DEBUG.indexOf(location.hostname) !== -1) {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    // --- Firebase ---
    firebase.initializeApp({
      apiKey: "AIzaSyCAu6HNLjIpOjcncR3fbmeEMGNUPHnNBkQ",
      authDomain: "aobing-dfe10.firebaseapp.com",
      databaseURL: "https://aobing-dfe10-default-rtdb.firebaseio.com",
      projectId: "aobing-dfe10",
      storageBucket: "aobing-dfe10.firebasestorage.app",
      messagingSenderId: "322502890597",
      appId: "1:322502890597:web:e8679668c108b80355e28c",
      measurementId: "G-8MPRMKEKVD"
    });

    // App Check activation (reCAPTCHA Enterprise).
    // Site key is registered in Firebase Console → App Check → reCAPTCHA Enterprise.
    // The site key is safe to commit (it's public; only the secret stays in Google).
    const APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY = "6LcQx-8sAAAAAJxnROGapKw6HYzz_-5aihfuU6_u";
    try {
      if (window.__ACTIVITY__) {
        const A = window.__ACTIVITY__;
        let acToken = A.appCheckToken;
        let acExpiry = Date.now() + (A.appCheckTtlMillis || 3600000) - 60000; // refresh 1 min early
        const provider = new firebase.appCheck.CustomProvider({
          getToken: async () => {
            if (Date.now() >= acExpiry) {
              // refresh via kei-bot using the current Firebase ID token
              const idToken = await firebase.auth().currentUser.getIdToken();
              const r = await fetch(A.keiBase + '/api/activity/appcheck-token', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
              });
              const d = await r.json();
              acToken = d.appCheckToken; acExpiry = Date.now() + (d.appCheckTtlMillis || 3600000) - 60000;
            }
            return { token: acToken, expireTimeMillis: acExpiry };
          },
        });
        firebase.appCheck().activate(provider, true);
      } else {
        firebase.appCheck().activate(
          new firebase.appCheck.ReCaptchaEnterpriseProvider(APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY),
          true /* isTokenAutoRefreshEnabled */
        );
      }
    } catch (e) { console.warn('App Check activation failed:', e); }

    const db = firebase.database();
    const clicksRef = db.ref('clicks');
    const auth = firebase.auth();
    // Firebase Analytics — auto-collects page_view, session_start, country, referrer,
    // device, browser. Viewable in console.firebase.google.com under Analytics.
    // Wrapped in try/catch because some browsers / privacy extensions block gtag.
    // Analytics can't run in the Discord Activity (gtag + installations are CSP-blocked),
    // and isn't needed there — skip it to avoid console error spam.
    try { if (!window.__ACTIVITY__) firebase.analytics(); } catch (e) { /* analytics blocked or unavailable */ }

    // --- kei-bot base URL --------------------------------------------------------
    const KEI_BASE = 'https://kei.aobing.it';

    // In the Discord Activity, external avatar images (e.g. Google photos) are blocked by
    // the iframe's img-src CSP. Route them through kei-bot's image proxy via the same-origin
    // /.proxy/kei path (a direct kei.aobing.it img URL would also be CSP-blocked). Discord
    // CDN images are already allowed, so leave those alone. No-op on the normal web.
    function activityImg(url) {
      if (!window.__ACTIVITY__ || !url || !/^https:\/\//.test(url)) return url;
      if (/discordapp\.(com|net)\//.test(url)) return url;
      return '/.proxy/kei/api/img?url=' + encodeURIComponent(url);
    }

    // Clicks accrued since THIS session/boot started (for the Activity presence panel).
    // Tracks the same leaderboard-eligible clicks as totalClicks (incremented in recordClick).
    let sessionClicks = 0;
    // Discord-linked flag for the profile photo picker (set by refreshLinkUi on web).
    let discordLinked = false;

    // The photo a user has chosen to show on the leaderboard: google (default) / discord /
    // none(hidden). Delegates to the pure presence engine; falls back to the Google photo
    // if presence.js hasn't loaded yet (the default behaviour anyway).
    function lbPhoto(profile) {
      if (window.PresenceEngine && window.PresenceEngine.resolveLeaderboardPhoto) {
        return window.PresenceEngine.resolveLeaderboardPhoto(profile);
      }
      return (profile && profile.photoURL) || '';
    }

    // --- User identity ------------------------------------------------------------
    // No auto-anonymous sign-in: guests run in a localStorage-only mode and only
    // get a real Firebase Auth account when they explicitly sign in with Google.
    // Stale anonymous sessions from before this change are signed out on detect;
    // their RTDB data is cleaned up by scripts/cleanup-anon-accounts.js.
    let currentUser = null;
    let authResolved = false;
    const authReady = new Promise((resolve) => {
      auth.onAuthStateChanged((user) => {
        if (user && user.isAnonymous) {
          auth.signOut().catch(() => {});
          return;
        }
        currentUser = user;
        if (!authResolved) { authResolved = true; resolve(user); }
      });
    });

    // Activity: sign in with the custom token minted by kei-bot.
    // onAuthStateChanged above will then fire with the signed-in user and the app proceeds normally.
    if (window.__ACTIVITY__) {
      const _A = window.__ACTIVITY__;
      firebase.auth().signInWithCustomToken(_A.customToken)
        // Ensure a game profile exists for this Discord user (the web Discord-login path
        // does the same via the postMessage handler). Without it userProfile stays null,
        // which gates off BOTH the presence panel and the leaderboard photo picker.
        // ensureDiscordProfile is a no-op when a profile already exists (e.g. linked Google).
        .then(() => ensureDiscordProfile(_A.uid, _A.discordName, _A.discordPhotoURL))
        .catch((e) => console.error('[activity] signInWithCustomToken failed', e));

      // In the Activity, any link that navigates away from the SPA (external sites like
      // x.com, or same-origin pages like /discord/) freezes the iframe. Intercept those
      // clicks and hand the URL to Discord's openExternalLink so it opens in the browser.
      document.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
        let url;
        try { url = new URL(href, location.href); } catch (_) { return; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        const leavesApp = url.origin !== location.origin || url.pathname !== location.pathname;
        if (!leavesApp) return;  // same-page anchor / in-SPA — let it be
        e.preventDefault();
        // Same-origin page nav (e.g. /discord/) → open the real aobing.it page (it redirects);
        // external → open as-is.
        const target = (url.origin === location.origin)
          ? ('https://aobing.it' + url.pathname + url.search + url.hash)
          : url.href;
        try { window.__ACTIVITY__.openExternalLink(target); }
        catch (err) { console.error('[activity] openExternalLink failed', err); }
      }, true);
    }

    // --- Date & Country Helpers ---
    function todayKey() {
      return new Date().toISOString().slice(0, 10); // YYYY-MM-DD in local-ish UTC
    }

    function countryFlag(code) {
      if (!code || code.length !== 2) return '';
      return code.toUpperCase().replace(/./g, c =>
        String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
      );
    }

    // Fetch visitor country (best-effort, silent fail). CORS-friendly endpoints with
    // fallback — ipapi.co dropped its CORS header, so we try several and take the first
    // that returns a 2-letter code. (In the Discord Activity these aren't proxied, so it
    // simply falls back to no country, which is fine.)
    let visitorCountry = null;
    (function fetchCountry() {
      // The Discord Activity's connect-src CSP blocks these geo hosts; skip (country stays null).
      if (window.__ACTIVITY__) return;
      const sources = [
        { url: 'https://api.country.is/',                  pick: d => d.country },
        { url: 'https://ipwho.is/',                        pick: d => d.country_code },
        { url: 'https://get.geojs.io/v1/ip/country.json',  pick: d => d.country },
      ];
      (function tryNext(i) {
        if (i >= sources.length) return;
        fetch(sources[i].url)
          .then(r => (r.ok ? r.json() : Promise.reject()))
          .then(d => {
            const c = sources[i].pick(d);
            if (c && c.length === 2) visitorCountry = c.toUpperCase();
            else return Promise.reject();
          })
          .catch(() => tryNext(i + 1));
      })(0);
    })();

    // --- Track unique daily visitors ---
    // localStorage gates this once-per-day-per-device. Previously we wrote a
    // per-visitor-id boolean to daily/{date}/visitors/{id} for server-side
    // dedup, but a bot inflated that map to 700K+ entries which made the
    // analytics page (Object.keys(visitors).length) take ~10s to load. We
    // now keep a transactional counter at daily/{date}/visitorCount instead;
    // dedup is client-only via localStorage. Tradeoff: a user who clears
    // localStorage mid-day can re-count once. Acceptable for vanity stats.
    localStorage.removeItem('aobing_visitor_id');
    localStorage.removeItem('aobing-visitor-id');
    authReady.then(() => {
      const day = todayKey();
      const dayKey = 'aobing_visited_day_' + day;
      if (localStorage.getItem(dayKey)) return;
      try { localStorage.setItem(dayKey, '1'); } catch {}
      db.ref('daily/' + day + '/visitorCount').transaction((c) => (c || 0) + 1);
    });

    const { animate, createTimeline } = anime;

    // Intro state — read by applyVariant during initial setup, so it lives at the top.
    let introActive = true;

    // --- Characters Registry ---
    // Each character bundles SFX, BGM, background, and idle texts shared across its variants.
    // A variant may declare its own `bgm` to override the character default (none do yet).
    // Empty string for sfx/bgm/bg = suppressed (no sound, no music, body color falls back).
    const CHARACTERS = [
      {
        id: 'aoba',
        name: 'Aoba',
        sfx: ['assets/aobing.mp3'],
        bgm: 'assets/bgm.mp3',
        bg:  'assets/bg.png',
        idleTexts: ['hi'],
        variants: [
          { id: 'aoba',      name: 'Aoba',       tag: 'Default', idle: 'assets/aoba-idle.webp',      active: 'assets/aoba-active.webp' },
          { id: 'aobaplush', name: 'Aoba Plush', tag: 'Plushie', idle: 'assets/aobaplush-idle.png',  active: 'assets/aobaplush-active.png' },
        ],
      },
      {
        id: 'mari',
        name: 'Mari',
        sfx: [
          'assets/mari-sfx-1.mp3',
          'assets/mari-sfx-2.mp3',
          'assets/mari-sfx-3.mp3',
          'assets/mari-sfx-4.mp3',
        ],
        bgm: '',  // each variant supplies its own bgm
        bg:  '',  // each variant supplies its own bg
        idleTexts: ['hi'],
        variants: [
          { id: 'mari',      name: 'Mari',       tag: 'Default', idle: 'assets/mari-idle.webp',      active: 'assets/mari-active.webp',      bg: 'assets/mari-bg.png',      bgm: 'assets/mari-bgm.mp3' },
          { id: 'maritrack', name: 'Track Mari', tag: 'Track',   idle: 'assets/maritrack-idle.webp', active: 'assets/maritrack-active.webp', bg: 'assets/maritrack-bg.png', bgm: 'assets/maritrack-bgm.mp3' },
          { id: 'mariidol',  name: 'Idol Mari',  tag: 'Idol',    idle: 'assets/mariidol-idle.webp',  active: 'assets/mariidol-active.webp',  bg: 'assets/mariidol-bg.png',  bgm: 'assets/mariidol-bgm.mp3' },
        ],
      },
      {
        id: 'miyu',
        name: 'Miyu',
        sfx: [],          // silent for now
        bgm: '',          // silent for now
        bg:  '',          // each variant supplies its own bg
        idleTexts: ['hi'],
        variants: [
          { id: 'miyu',     name: 'Miyu',          tag: 'Default',  idle: 'assets/miyu-idle.webp',     active: 'assets/miyu-active.webp',     active2: 'assets/miyu-active2.webp',     bg: 'assets/miyu-bg.png' },
          { id: 'miyuswim', name: 'Miyu Swimsuit', tag: 'Swimsuit', idle: 'assets/miyuswim-idle.webp', active: 'assets/miyuswim-active.webp', active2: 'assets/miyuswim-active2.webp', bg: 'assets/miyuswim-bg.png' },
        ],
      },
    ];

    // Per-variant bond system constants — declared up here so renderSkinList()
    // calls fired at script-init don't hit a TDZ when reading them inside
    // variantLevelOf(). Helper FUNCTIONS are hoisted; const/let are not.
    const MAX_VARIANT_LEVEL = 50;
    const MAX_BOND_LEVEL = 100;           // hard cap; heart button disappears past this
    const BOND_COIN_BONUS_PER_LEVEL = 0.10;

    // --- Custom modal (replaces window.confirm / window.alert) ----------------
    // showConfirm(title, message, { confirmLabel, cancelLabel }) → Promise<bool>
    // showAlert(title, message, { confirmLabel }) → Promise<void>
    // Esc/click-backdrop = cancel; Enter = confirm.
    function showModal(options) {
      return new Promise((resolve) => {
        const returnFocus = document.activeElement;
        const modalEl    = document.getElementById('app-modal');
        const titleEl    = document.getElementById('app-modal-title');
        const messageEl  = document.getElementById('app-modal-message');
        const confirmBtn = document.getElementById('app-modal-confirm');
        const cancelBtn  = document.getElementById('app-modal-cancel');
        const backdrop   = modalEl.querySelector('.app-modal-backdrop');
        titleEl.textContent   = options.title   || '';
        messageEl.textContent = options.message || '';
        confirmBtn.textContent = options.confirmLabel || 'OK';
        cancelBtn.textContent  = options.cancelLabel  || 'Cancel';
        cancelBtn.hidden = !!options.alertOnly;
        function cleanup() {
          modalEl.hidden = true;
          queueMicrotask(() => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
          confirmBtn.removeEventListener('click', onConfirm);
          cancelBtn.removeEventListener('click', onCancel);
          backdrop.removeEventListener('click', onCancel);
          document.removeEventListener('keydown', onKey);
        }
        function onConfirm() { cleanup(); resolve(true); }
        function onCancel()  { cleanup(); resolve(false); }
        function onKey(e) {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
        }
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        backdrop.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
        modalEl.hidden = false;
        confirmBtn.focus();
      });
    }
    function showConfirm(title, message, opts) {
      return showModal(Object.assign({ title, message, alertOnly: false }, opts || {}));
    }
    function showAlert(title, message, opts) {
      return showModal(Object.assign({ title, message, alertOnly: true }, opts || {}));
    }

    function getVariant(variantId) {
      for (const c of CHARACTERS) {
        const v = c.variants.find(v => v.id === variantId);
        if (v) return { character: c, variant: v };
      }
      return { character: CHARACTERS[0], variant: CHARACTERS[0].variants[0] };
    }

    function resolveBgm(character, variant) {
      return (variant && variant.bgm) ? variant.bgm : character.bgm;
    }

    function resolveBg(character, variant) {
      return (variant && variant.bg) ? variant.bg : character.bg;
    }

    // --- i18n -----------------------------------------------------------------
    // The translation table and DOM application live in i18n.js, which loads before
    // the shell so the boot screen is translated while app.js is still loading.
    // window.I18N is available here as the global binding I18N.
    // -------------------------------------------------------------------------

    // --- Settings Persistence ---
    const SETTINGS_KEY = 'aobing-settings';
    const DEFAULT_SETTINGS = {
      musicVol: 10, sfxVol: 50, effects: true, skin: 'aoba', keyboardClicks: true,
      adminMode: false, rawCps: false, autoClicker: true,
      characterBackground: false,
      skyHour: 'auto',            // 'auto' (device time) | '6' | '12' | '18' | '23'
      skyTour: false,             // rotate through the four skies, 15s each
      showFps: true,              // show an FPS counter during rhythm gameplay (osu/mania)
      // Typing game (typing.js)
      typingClickOnWord: true,    // word-complete fires reactCharacter()
      typingClickPerKey: false,   // each keystroke fires reactCharacter()
      typingMode: 's30',          // s15 | s30 | s60 | endless
      typingPack: 'english-common',
      typingFreedomOn: false, typingNoBackspaceOn: false, typingStopOnErrorOn: false,
      gameMode: 'clicker',        // 'clicker' | 'typing' | 'vsrg' | 'osu' — left mode menu top level
      typingSubMode: 'casual',    // 'casual' | 'ranked' — only meaningful in typing mode
      rhythmSubMode: 'standard',  // 'standard' (osu) | 'mania' (vsrg) — sub-toggle under the Rhythm mode
      hitsoundVol: 35,            // 0–100: hit sound volume for the rhythm modes (0 = off)
      hitsoundKind: 'soft',       // 'soft' | 'tick' | 'drum' | 'beep' (synth presets) | 'custom' (uploaded) — see hitsound.js
      hitsoundUseMap: false,      // play the beatmap's per-note hitsounds (whistle/finish/clap) instead of the chosen sound
      typingCaretFollow: false,   // false = scroll (active word pinned left); true = typewriter (caret follows, returns to start)
      vsrgCalibrationOffset: 0,   // ms applied to VSRG input->song-time mapping (vsrg.js)
      vsrgScrollSpeed: 1.0,       // VSRG note scroll-speed multiplier (higher = faster)
      vsrgNoteStyle: 'bar',       // 'bar' | 'circle' | 'arrow'
      vsrgNoteScale: 1.0,         // note size multiplier (0.6–1.8)
      vsrgColorPreset: 'default', // 'default' | 'osu' | 'mono' | 'pastel'
      vsrgLaneColors: [],         // per-lane hex overrides; [] = use the preset
      osuCalibrationOffset: 0,    // ms applied to osu!standard input->song-time mapping
      vsrgKeybinds: {},           // keyCount -> [keys] overriding the default lane keys (vsrg.js)
      osuKeys: ['z', 'x'],        // osu!standard tap keys (osustd.js)
      osuSortBy: 'title',         // song-select sort: 'title' | 'artist' | 'stars' | 'length' (osustd.js)
      osuCursorScale: 1,          // osu!standard cursor size multiplier (0.5–2)
      osuBgDim: 80,               // osu!standard background dim % (higher = darker; 80 ≈ the classic faint art)
      divaKeys: { triangle: ['w', 'i'], circle: ['d', 'l'], cross: ['s', 'k'], square: ['a', 'j'], slideL: ['q', 'z'], slideR: ['e', 'c'] }, // Project Diva button binds (divaft.js)
      divaMacros: [],             // [{key, buttons:[face...]}] macro binds firing several face buttons from one key (divaft.js)
      divaCalibrationOffset: 0,   // ms applied to Diva input->song-time mapping (divaft.js)
    };

    // --- Admin gating -----------------------------------------------------------
    // Source of truth: admins/{uid}: true in RTDB. The site subscribes to the
    // current user's row and caches the result. Adding/removing admins is a
    // Firebase Console edit — no code change needed.
    let isAdminCached = false;
    let adminUnsub = null;
    function isAdmin() { return isAdminCached; }
    function subscribeAdminStatus(uid) {
      if (adminUnsub) { adminUnsub(); adminUnsub = null; }
      isAdminCached = false;
      if (!uid) { if (typeof syncAdminVisibility === 'function') syncAdminVisibility(); return; }
      const ref = db.ref('admins/' + uid);
      const cb = (snap) => {
        isAdminCached = snap.val() === true;
        if (typeof syncAdminVisibility === 'function') syncAdminVisibility();
        // leaderboardModal is a `const` declared later — accessing it through
        // typeof still throws TDZ. Defer the open-modal refresh via a tick so
        // it only runs after the script has fully initialised.
        Promise.resolve().then(() => {
          try {
            if (leaderboardModal && leaderboardModal.classList.contains('open')) loadLeaderboard();
          } catch { /* not yet initialised on first auth callback */ }
        });
      };
      ref.on('value', cb);
      adminUnsub = () => ref.off('value', cb);
    }
    auth.onAuthStateChanged((user) => {
      // Treat stale anonymous sessions as signed-out; they'll be cleared by
      // the auth-init listener calling signOut().
      subscribeAdminStatus(user && !user.isAnonymous ? user.uid : null);
    });

    function loadSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        return saved ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS };
      } catch { return { ...DEFAULT_SETTINGS }; }
    }

    function saveSettings(s) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    }

    const settings = loadSettings();

    // --- Language ---
    // Resolve language: saved user choice wins; otherwise detect from navigator
    // (re-detected on every visit until the user picks explicitly). Translate
    // the static HTML before anything reads textContent.
    I18N.set(I18N.detect(settings.lang));

    // --- Audio Elements ---
    const bgm = document.getElementById('bgm');
    const musicSlider = document.getElementById('music-slider');
    const sfxSlider = document.getElementById('sfx-slider');
    const effectsToggle = document.getElementById('effects-toggle');
    const characterBackgroundToggle = document.getElementById('character-background-toggle');
    const skyHourSlider = document.getElementById('sky-hour-slider');
    const skyAutoToggle = document.getElementById('sky-auto-toggle');
    const skyTourToggle = document.getElementById('sky-tour-toggle');
    const settingsBtn = document.getElementById('settings-btn');
    const settingsPanel = document.getElementById('settings-panel');
    const langSelect = document.getElementById('lang-select');

    // Populate language dropdown with native-script labels. Mark the currently
    // active language as selected — this may be a saved choice OR the detected
    // default, so we read from I18N.current rather than settings.lang.
    I18N.SUPPORTED.forEach(code => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = I18N.NATIVE[code];
      if (code === I18N.current) opt.selected = true;
      langSelect.appendChild(opt);
    });
    langSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const lang = e.target.value;
      I18N.set(lang);
      settings.lang = lang;
      saveSettings(settings);
    });
    langSelect.addEventListener('click', (e) => e.stopPropagation());

    // Apply loaded settings to UI
    bgm.volume = settings.musicVol / 100;
    musicSlider.value = settings.musicVol;
    sfxSlider.value = settings.sfxVol;
    if (!settings.effects) effectsToggle.classList.remove('on');
    syncCharacterBackground(settings.characterBackground);
    syncSkyControls({ initial: true });

    let bgmPlaying = false;
    // Track the currently-loaded BGM src ourselves — browsers can keep <audio>.currentSrc
    // populated even after removeAttribute('src') + load(), so we can't trust it for
    // change-detection. HTML default matches Aoba's bgm.
    let currentBgmSrc = 'assets/bgm.mp3';

    // --- Settings Panel Toggle ---
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsPanel.classList.toggle('open');
    });

    // --- Music Volume ---
    musicSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const vol = Number(e.target.value);
      bgm.volume = vol / 100;
      settings.musicVol = vol;
      saveSettings(settings);
      if (vol > 0 && !bgmPlaying) {
        bgm.play();
        bgmPlaying = true;
      }
    });

    // --- SFX Volume ---
    sfxSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      settings.sfxVol = Number(e.target.value);
      saveSettings(settings);
    });

    // --- Effects Toggle ---
    effectsToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.effects = !settings.effects;
      effectsToggle.classList.toggle('on', settings.effects);
      saveSettings(settings);
    });

    // --- Original character background (Clicker only) ---
    function syncCharacterBackground(enabled) {
      enabled = enabled === true;
      document.body.classList.toggle('character-background', enabled);
      characterBackgroundToggle.classList.toggle('on', enabled);
      characterBackgroundToggle.setAttribute('aria-checked', String(enabled));
    }
    characterBackgroundToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.characterBackground = !settings.characterBackground;
      syncCharacterBackground(settings.characterBackground);
      saveSettings(settings);
    });

    // --- Sky time picker + sky tour -----------------------------------------
    // game-shell.js owns the rendering and the tour timer; this only stores the
    // choice and keeps the controls in sync.
    function renderSkyControls() {
      const tour = settings.skyTour === true;
      const auto = settings.skyHour === 'auto';
      skyTourToggle.classList.toggle('on', tour);
      skyTourToggle.setAttribute('aria-checked', String(tour));
      skyAutoToggle.classList.toggle('on', auto);
      skyAutoToggle.setAttribute('aria-checked', String(auto));
      if (!auto) skyHourSlider.value = settings.skyHour;
    }
    function syncSkyControls(options) {
      renderSkyControls();
      if (options && options.initial) {
        window.GameShell.applySkyPreference(settings.skyHour, settings.skyTour === true);
      } else {
        window.GameShell.setSkyHour(settings.skyHour);
        window.GameShell.setSkyTour(settings.skyTour === true);
      }
    }
    // Scrubbing follows the thumb immediately and only saves on release, so a drag
    // is one write instead of one per quarter hour.
    skyHourSlider.addEventListener('input', (e) => {
      if (settings.skyTour) { settings.skyTour = false; window.GameShell.setSkyTour(false); }
      settings.skyHour = e.target.value;
      renderSkyControls();
      window.GameShell.scrubSkyHour(e.target.value);
    });
    skyHourSlider.addEventListener('change', () => saveSettings(settings));
    skyHourSlider.addEventListener('click', (e) => e.stopPropagation());
    skyAutoToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      // Turning it off keeps the sky that is on screen, so the slider starts there.
      settings.skyHour = settings.skyHour === 'auto' ? skyHourSlider.value : 'auto';
      settings.skyTour = false;
      syncSkyControls();
      saveSettings(settings);
    });
    skyTourToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (settings.skyTour) {
        // Stopping keeps the sky the sweep is showing instead of snapping back to
        // the previous pick; round to the slider's step so thumb and sky agree.
        settings.skyHour = (Math.round(window.GameShell.shownSkyHour() * 4) / 4).toFixed(2);
      }
      settings.skyTour = !settings.skyTour;
      syncSkyControls();
      saveSettings(settings);
    });

    // --- Keyboard clicks toggle ---
    const keyboardToggle = document.getElementById('keyboard-toggle');
    if (settings.keyboardClicks === false) keyboardToggle.classList.remove('on');
    keyboardToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.keyboardClicks = !settings.keyboardClicks;
      keyboardToggle.classList.toggle('on', settings.keyboardClicks);
      saveSettings(settings);
    });

    // --- Raw-CPS toggle ---
    // OFF (default) = display includes auto-clicker. ON = mouse + keyboard only.
    const rawCpsToggle = document.getElementById('raw-cps-toggle');
    if (settings.rawCps) rawCpsToggle.classList.add('on');
    rawCpsToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.rawCps = !settings.rawCps;
      rawCpsToggle.classList.toggle('on', settings.rawCps);
      saveSettings(settings);
    });

    // --- Show-FPS toggle (rhythm modes read settings.showFps) ---
    const showFpsToggle = document.getElementById('show-fps-toggle');
    if (showFpsToggle) {
      showFpsToggle.classList.toggle('on', settings.showFps !== false);
      showFpsToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        settings.showFps = !(settings.showFps !== false);   // flip, treating undefined as on
        showFpsToggle.classList.toggle('on', settings.showFps);
        saveSettings(settings);
      });
    }

    // --- Auto-clicker toggle ---
    // ON (default) = auto-clicker runs at its purchased rate. OFF = paused
    // regardless of autoLevel/buffs. rearmAutoLoop reads currentAutoCps() which
    // honors this flag, so toggling flips the cursor visibility and timer immediately.
    const autoClickerToggle = document.getElementById('auto-clicker-toggle');
    if (settings.autoClicker === false) autoClickerToggle.classList.remove('on');
    autoClickerToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.autoClicker = !settings.autoClicker;
      autoClickerToggle.classList.toggle('on', settings.autoClicker);
      saveSettings(settings);
      rearmAutoLoop();
    });

    // --- Admin mode toggle (visible only to admin) ---
    const adminRow = document.getElementById('settings-admin-row');
    const adminToggle = document.getElementById('admin-toggle');
    if (settings.adminMode) adminToggle.classList.add('on');
    adminToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.adminMode = !settings.adminMode;
      adminToggle.classList.toggle('on', settings.adminMode);
      saveSettings(settings);
      // Re-render leaderboard if it's open so the delete buttons toggle
      if (leaderboardModal && leaderboardModal.classList.contains('open')) loadLeaderboard();
      // Re-render the country area so the dropdown picker appears/disappears.
      if (typeof renderCountryArea === 'function') renderCountryArea();
    });
    function syncAdminVisibility() {
      // Use style.display because the [hidden] attribute is overridden by the
      // .settings-row { display: flex; ... } rule (CSS wins over the UA stylesheet).
      adminRow.style.display = isAdmin() ? '' : 'none';
      if (!isAdmin() && settings.adminMode) {
        settings.adminMode = false;
        adminToggle.classList.remove('on');
        saveSettings(settings);
      }
      // Country picker visibility depends on admin status too.
      if (typeof renderCountryArea === 'function') renderCountryArea();
    }
    // Subscription listener (subscribeAdminStatus) already calls
    // syncAdminVisibility when admin status changes. No need for a separate
    // onAuthStateChanged hook here.

    // --- Reset Defaults ---
    function applySettings(s) {
      bgm.volume = s.musicVol / 100;
      musicSlider.value = s.musicVol;
      sfxSlider.value = s.sfxVol;
      effectsToggle.classList.toggle('on', s.effects);
      syncCharacterBackground(s.characterBackground);
      syncSkyControls();
      keyboardToggle.classList.toggle('on', s.keyboardClicks);
      adminToggle.classList.toggle('on', s.adminMode);
      rawCpsToggle.classList.toggle('on', s.rawCps);
      if (showFpsToggle) showFpsToggle.classList.toggle('on', s.showFps !== false);
      autoClickerToggle.classList.toggle('on', s.autoClicker);
      rearmAutoLoop();
      applyVariant(s.skin);
      renderSkinList();
    }

    document.getElementById('reset-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      Object.assign(settings, DEFAULT_SETTINGS);
      saveSettings(settings);
      applySettings(settings);
    });

    // --- Stats Modal Toggle ---
    const statsBtn = document.getElementById('stats-btn');
    const statsModal = document.getElementById('stats-modal');
    const statsCloseBtn = document.getElementById('stats-close');

    function openStatsModal() {
      statsModal.classList.add('open');
      statsModal.setAttribute('aria-hidden', 'false');
      loadStats();
    }
    function closeStatsModal() {
      statsModal.classList.remove('open');
      statsModal.setAttribute('aria-hidden', 'true');
      detachLiveStats();
    }

    statsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (statsModal.classList.contains('open')) closeStatsModal();
      else openStatsModal();
    });
    statsCloseBtn.addEventListener('click', closeStatsModal);
    statsModal.addEventListener('click', (e) => {
      if (e.target === statsModal) closeStatsModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && statsModal.classList.contains('open')) closeStatsModal();
    });

    // --- Skins Panel ---
    const skinsBtn = document.getElementById('skins-btn');
    const skinsPanel = document.getElementById('skins-panel');
    const skinListEl = document.getElementById('skin-list');

    // Skin bar — current variant + its level + XP progress. Declared here so
    // applyVariant() (which calls renderSkinBar) can read these refs at startup.
    const skinBarThumbEl     = document.getElementById('skin-bar-thumb');
    const skinBarNameEl      = document.getElementById('skin-bar-name');
    const skinBarLevelEl     = document.getElementById('skin-bar-level');
    const skinBarXpFillEl    = document.getElementById('skin-bar-xp-fill');
    const skinBarXpTextEl    = document.getElementById('skin-bar-xp-text');
    const skinBarBondEl      = document.getElementById('skin-bar-bond');
    const skinBarBondCountEl = document.getElementById('skin-bar-bondcount');

    function renderSkinBar() {
      if (!skinBarNameEl) return;
      const { variant } = getVariant(settings.skin);
      const lv      = variantLevelOf(variant.id);
      const cur     = variantXpInLevel(variant.id);
      const need    = variantXpToNext(variant.id);
      const bonds   = variantBonds(variant.id);
      const canBond = variantCanBond(variant.id);
      if (skinBarThumbEl && skinBarThumbEl.getAttribute('src') !== variant.idle) skinBarThumbEl.src = variant.idle;
      skinBarNameEl.textContent  = variantName(variant);
      skinBarLevelEl.textContent = 'Lv.' + lv + (canBond ? ' MAX' : '');
      skinBarXpFillEl.style.width = (need > 0 ? Math.min(100, cur / need * 100) : 0) + '%';
      skinBarXpTextEl.textContent = cur.toLocaleString() + ' / ' + need.toLocaleString();
      if (skinBarBondEl) {
        skinBarBondEl.hidden = !canBond;
        skinBarBondEl.dataset.bondVariant = variant.id;
      }
      if (skinBarBondCountEl) {
        skinBarBondCountEl.hidden = bonds === 0;
        skinBarBondCountEl.textContent = '♥' + bonds;
      }
    }

    function applyVariant(variantId) {
      const { character, variant } = getVariant(variantId);

      // Sprite swap + active preload
      const aobaImg = document.getElementById('aoba-img');
      aobaImg.src = variant.idle;
      const preload = new Image();
      preload.src = variant.active;
      if (variant.active2) {
        const preload2 = new Image();
        preload2.src = variant.active2;
      }

      // Body background — variant.bg overrides character.bg. Empty string clears it
      // so the solid #1a1a2e shows.
      const newBg = resolveBg(character, variant);
      document.body.style.backgroundImage = newBg ? `url('${newBg}')` : 'none';

      // SFX pool rebuild (pool may not exist yet on first call)
      if (window._soundPoolReady) buildSoundPool();

      // BGM swap. Empty src = stop and clear. Non-empty + post-intro + vol > 0 = play.
      // We treat switching to a music-having character as a positive intent to hear it,
      // not a gate on whether playback was already running (otherwise Mari → Aoba never resumes).
      // Compare against our JS-tracked currentBgmSrc rather than bgm.currentSrc — the
      // <audio> element can hold onto the previous URL even after removeAttribute('src').
      const newBgm = resolveBgm(character, variant);
      if (!newBgm) {
        if (currentBgmSrc) {
          bgm.pause();
          bgm.removeAttribute('src');
          bgm.load();
          currentBgmSrc = '';
          bgmPlaying = false;
        }
      } else if (newBgm !== currentBgmSrc) {
        bgm.pause();
        bgm.src = newBgm;
        bgm.load();
        currentBgmSrc = newBgm;
        if (!introActive && settings.musicVol > 0) {
          bgm.play().then(() => { bgmPlaying = true; }).catch(() => {});
        }
      }

      // Idle bubble: hide any existing bubble and re-arm for the new character
      if (window._idleBubbleReady) {
        hideBubble();
        scheduleIdleBubble();
      }

      // Sub-counter follows the active variant. Guarded because applyVariant runs
      // at initial setup before the subscriber's `let` bindings are initialised.
      if (window._skinCounterReady) {
        subscribeCurrentSkinCount(variantId);
      }

      renderSkinBar();
    }

    // Translation helpers for the dynamic CHARACTERS data — keys are derived
    // from id / lowercased tag, with the bundled English values as fallback.
    function charName(c) { return I18N.t('character.' + c.id + '.name'); }
    function variantName(v) { return I18N.t('skin.' + v.id + '.name'); }
    function variantTag(v) { return I18N.t('tag.' + v.tag.toLowerCase()); }

    function renderSkinList() {
      skinListEl.innerHTML = CHARACTERS.map(c => {
        const activeVariant = c.variants.find(v => v.id === settings.skin);
        const isOpen = !!activeVariant;
        const n = c.variants.length;
        const meta = activeVariant
          ? variantTag(activeVariant)
          : I18N.t(n === 1 ? 'skins.variant' : 'skins.variants', { n });
        const variantsHtml = c.variants.map(v => {
          const lv      = variantLevelOf(v.id);
          const cur     = variantXpInLevel(v.id);
          const need    = variantXpToNext(v.id);
          const bonds   = variantBonds(v.id);
          const canBond = variantCanBond(v.id);
          const lvTitle = canBond
            ? `Lv.${MAX_VARIANT_LEVEL} MAX · ready to bond`
            : `Lv.${lv} · ${cur.toLocaleString()} / ${need.toLocaleString()} XP`;
          const bondAttrs = canBond ? ` data-can-bond="true"` : '';
          const bondBtn   = canBond
            ? `<button class="skin-variant-bond" type="button" data-bond-variant="${v.id}" title="${I18N.t('bond.button')}" aria-label="${I18N.t('bond.button')}">♥</button>`
            : '';
          const bondBadge = (bonds > 0 && !canBond)
            ? `<span class="skin-variant-bondcount" title="${I18N.t('bond.count', { n: bonds })}">♥${bonds}</span>`
            : '';
          return `<div role="button" tabindex="0" aria-pressed="${v.id === settings.skin}" class="skin-item${v.id === settings.skin ? ' active' : ''}${canBond ? ' bond-ready' : ''}" data-variant="${v.id}"${bondAttrs}>
            <img class="skin-thumb" src="${v.idle}" alt="${variantName(v)}">
            <div class="skin-info">
              <div class="skin-name">${variantName(v)}</div>
              <div class="skin-tag-row">
                <span class="skin-tag">${variantTag(v)}</span>
                <span class="skin-variant-level" title="${lvTitle}">Lv.${lv}${canBond ? ' MAX' : ''}</span>
              </div>
            </div>
            ${bondBadge}${bondBtn}
          </div>`;
        }).join('');
        return `<div class="skin-group" data-character="${c.id}" data-open="${isOpen}">
          <button class="skin-group-header" type="button" aria-expanded="${isOpen}">
            <span class="skin-group-caret">${isOpen ? '▼' : '▶'}</span>
            <span class="skin-group-name">${charName(c)}</span>
            <span class="skin-group-meta">${meta}</span>
          </button>
          <div class="skin-group-body"${isOpen ? '' : ' hidden'}>${variantsHtml}</div>
        </div>`;
      }).join('');
    }

    // Defensive wrap: if either of these throws at init (e.g. a TDZ from a
    // newly-added const referenced too early), log it and continue. Without
    // this, the throw would abort the rest of this script tag and leave the
    // page non-interactive.
    try {
      renderSkinList();
      applyVariant(settings.skin);
    } catch (initErr) {
      console.error('[init] Skin list / variant init failed:', initErr);
    }

    skinListEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const bondBtn = e.target.closest('.skin-variant-bond');
      if (bondBtn) {
        e.stopPropagation();
        doBond(bondBtn.dataset.bondVariant);
        return;
      }
      const header = e.target.closest('.skin-group-header');
      if (header) {
        const group = header.parentElement;
        const nowOpen = group.dataset.open !== 'true';
        group.dataset.open = nowOpen ? 'true' : 'false';
        header.setAttribute('aria-expanded', String(nowOpen));
        const body = group.querySelector('.skin-group-body');
        const caret = group.querySelector('.skin-group-caret');
        if (nowOpen) {
          body.hidden = false;
          caret.textContent = '▼';
        } else {
          body.hidden = true;
          caret.textContent = '▶';
        }
        return;
      }
      const item = e.target.closest('.skin-item');
      if (!item) return;
      const id = item.dataset.variant;
      if (id === settings.skin) return;
      settings.skin = id;
      saveSettings(settings);
      applyVariant(id);
      renderSkinList();
    });

    skinsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      skinsPanel.classList.toggle('open');
    });

    // --- Shop panel toggle ---
    const shopBtn   = document.getElementById('shop-btn');
    const shopPanel = document.getElementById('shop-panel');
    shopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shopPanel.classList.toggle('open');
      if (settings.gameMode === 'typing') window.TypingGame?.refreshKeyboardPanel?.();
      if (typeof renderShopPanel === 'function') renderShopPanel();
    });
    shopPanel.addEventListener('click', (e) => e.stopPropagation());

    // Close panels on outside click
    document.addEventListener('click', (e) => {
      if (e.target.closest('#app-modal,.merge-overlay,#update-modal')) return;
      if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
        settingsPanel.classList.remove('open');
      }
      if (!skinsPanel.contains(e.target) && e.target !== skinsBtn) {
        skinsPanel.classList.remove('open');
      }
      if (!shopPanel.contains(e.target) && e.target !== shopBtn && !shopBtn.contains(e.target)) {
        shopPanel.classList.remove('open');
      }
    });

    // dailyTotalRef is still used by the click handlers below to increment today's total.
    // NOTE: bound at page load — clicks made past midnight on a stale tab will land on yesterday's bucket.
    const today = todayKey();
    const dailyTotalRef = db.ref('daily/' + today + '/total');

    // --- Analytics Modal Data ---
    const dateInput = document.getElementById('stats-date-input');
    const presetBtns = document.querySelectorAll('.stats-preset');
    const tileClicks = document.getElementById('tile-clicks');
    const tileClicksLabel = document.getElementById('tile-clicks-label');
    const tileVisitors = document.getElementById('tile-visitors');
    const tileVisitorsLabel = document.getElementById('tile-visitors-label');
    const tileCpv = document.getElementById('tile-cpv');
    const tileMaxCombo = document.getElementById('tile-max-combo');
    const tileMaxComboLabel = document.getElementById('tile-max-combo-label');
    const tileTypingWpm = document.getElementById('tile-typing-wpm');
    const tileTypingWpmLabel = document.getElementById('tile-typing-wpm-label');
    const tileTypingScore = document.getElementById('tile-typing-score');
    const tileTypingScoreLabel = document.getElementById('tile-typing-score-label');
    const trendGrid = document.getElementById('stats-trend-grid');
    const countriesEmpty = document.getElementById('countries-empty');
    const skinsEmpty = document.getElementById('skins-empty');
    const charactersEmpty = document.getElementById('characters-empty');
    const sourcesEmpty = document.getElementById('sources-empty');
    const chartSourcesCanvas = document.getElementById('chart-sources');
    const chartCountriesCanvas = document.getElementById('chart-countries');
    const chartSkinsCanvas = document.getElementById('chart-skins');
    const chartCharactersCanvas = document.getElementById('chart-characters');

    let currentPreset = 'today';
    let currentDate = todayKey();
    let liveTodayUnsub = null;
    let dailyDatesCache = null;
    const charts = { clicks: null, visitors: null, countries: null, skins: null, characters: null, sources: null };

    dateInput.value = currentDate;
    dateInput.max = currentDate;

    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        currentPreset = btn.dataset.preset;
        presetBtns.forEach(b => b.classList.toggle('active', b === btn));
        loadStats();
      });
    });

    dateInput.addEventListener('change', () => {
      if (!dateInput.value) return;
      currentDate = dateInput.value;
      currentPreset = 'date';
      presetBtns.forEach(b => b.classList.remove('active'));
      loadStats();
    });

    function detachLiveStats() {
      if (liveTodayUnsub) { liveTodayUnsub(); liveTodayUnsub = null; }
    }

    function destroyCharts() {
      Object.keys(charts).forEach(k => {
        if (charts[k]) { charts[k].destroy(); charts[k] = null; }
      });
    }

    function shiftDate(yyyymmdd, deltaDays) {
      const d = new Date(yyyymmdd + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + deltaDays);
      return d.toISOString().slice(0, 10);
    }

    function enumerateDates(from, to) {
      const out = [];
      let d = from;
      while (d <= to) {
        out.push(d);
        d = shiftDate(d, 1);
      }
      return out;
    }

    async function ensureDailyDatesCache() {
      if (dailyDatesCache) return dailyDatesCache;
      const snap = await db.ref('daily').once('value');
      const val = snap.val() || {};
      dailyDatesCache = Object.keys(val).sort();
      if (dailyDatesCache.length) {
        dateInput.min = dailyDatesCache[0];
      }
      return dailyDatesCache;
    }

    function dateRangeFromState() {
      const today = todayKey();
      if (currentPreset === 'today') return { from: today, to: today, label: I18N.t('stats.range.today') };
      if (currentPreset === '7d')    return { from: shiftDate(today, -6),  to: today, label: I18N.t('stats.range.last_7_days') };
      if (currentPreset === '30d')   return { from: shiftDate(today, -29), to: today, label: I18N.t('stats.range.last_30_days') };
      if (currentPreset === 'all')   return { from: null, to: null,    label: I18N.t('stats.range.all_time') };
      return { from: currentDate, to: currentDate, label: currentDate };
    }

    async function loadStats() {
      detachLiveStats();
      destroyCharts();
      const range = dateRangeFromState();

      let dailyData;
      if (range.from === null) {
        await ensureDailyDatesCache();
        const snap = await db.ref('daily').once('value');
        dailyData = snap.val() || {};
      } else {
        const snap = await db.ref('daily').orderByKey().startAt(range.from).endAt(range.to).once('value');
        dailyData = snap.val() || {};
      }

      const dates = range.from === null
        ? Object.keys(dailyData).sort()
        : enumerateDates(range.from, range.to);

      const clicksByDate = {};
      const visitorsByDate = {};
      const countryTotals = {};
      const skinTotals = {};
      const characterTotals = {};
      const sourceTotals = {};
      let totalClicks = 0;
      let totalVisitors = 0;
      let rangeMaxCombo = 0;
      let rangeMaxTypingWpm = 0;
      let rangeMaxTypingScore = 0;

      dates.forEach(d => {
        const day = dailyData[d] || {};
        const c = day.total || 0;
        // Prefer the cheap counter; fall back to the legacy map for historical
        // dates where backfill hasn't run. visitorCount is authoritative once set.
        const v = (typeof day.visitorCount === 'number')
          ? day.visitorCount
          : (day.visitors ? Object.keys(day.visitors).length : 0);
        clicksByDate[d] = c;
        visitorsByDate[d] = v;
        totalClicks += c;
        totalVisitors += v;
        if (day.maxCombo && day.maxCombo > rangeMaxCombo) {
          rangeMaxCombo = day.maxCombo;
        }
        if (day.typingMaxWpm && day.typingMaxWpm > rangeMaxTypingWpm) rangeMaxTypingWpm = day.typingMaxWpm;
        if (day.typingMaxScore && day.typingMaxScore > rangeMaxTypingScore) rangeMaxTypingScore = day.typingMaxScore;
        if (day.countries) {
          Object.entries(day.countries).forEach(([code, n]) => {
            countryTotals[code] = (countryTotals[code] || 0) + n;
          });
        }
        if (day.skins) {
          Object.entries(day.skins).forEach(([id, n]) => {
            skinTotals[id] = (skinTotals[id] || 0) + n;
          });
        }
        if (day.characters) {
          Object.entries(day.characters).forEach(([id, n]) => {
            characterTotals[id] = (characterTotals[id] || 0) + n;
          });
        }
        if (day.sources) {
          Object.entries(day.sources).forEach(([src, n]) => {
            sourceTotals[src] = (sourceTotals[src] || 0) + n;
          });
        }
      });

      // For "All time", fall back to the dedicated combo/allTime ref — that's
      // the canonical high score and may include older peaks not yet captured
      // in the per-day data.
      if (range.from === null) {
        try {
          const snap = await db.ref('combo/allTime').once('value');
          const allTimeMax = snap.val() || 0;
          if (allTimeMax > rangeMaxCombo) rangeMaxCombo = allTimeMax;
        } catch {}
      }

      // Back-compat: if the new daily/{date}/characters/ data is empty (early days, or
      // historic dates before this rollout), reconstruct character totals from skinTotals
      // by mapping each known variant ID to its parent character.
      if (Object.keys(characterTotals).length === 0 && Object.keys(skinTotals).length > 0) {
        Object.entries(skinTotals).forEach(([variantId, n]) => {
          const { character } = getVariant(variantId);
          // getVariant falls back to CHARACTERS[0] for unknown IDs — only count if it
          // was actually found, otherwise the count would be misattributed to Aoba.
          const known = CHARACTERS.some(c => c.variants.some(v => v.id === variantId));
          if (!known) return;
          characterTotals[character.id] = (characterTotals[character.id] || 0) + n;
        });
      }

      const isSingleDay = dates.length <= 1;
      const isToday = isSingleDay && dates[0] === todayKey();
      const labelSuffix = isSingleDay ? '' : ` (${range.label})`;

      tileClicksLabel.textContent  = I18N.t(isToday ? 'stats.tile.clicks_today'    : 'stats.tile.clicks')    + (isSingleDay ? '' : labelSuffix);
      tileVisitorsLabel.textContent = I18N.t(isToday ? 'stats.tile.visitors_today'  : 'stats.tile.visitors')  + (isSingleDay ? '' : labelSuffix);
      tileMaxComboLabel.textContent = I18N.t(isToday ? 'stats.tile.max_combo_today' : 'stats.tile.max_combo') + (isSingleDay ? '' : labelSuffix);
      tileClicks.textContent = totalClicks.toLocaleString();
      tileVisitors.textContent = totalVisitors.toLocaleString();
      tileCpv.textContent = totalVisitors > 0 ? (totalClicks / totalVisitors).toFixed(1) : '—';
      tileMaxCombo.textContent = rangeMaxCombo > 0 ? rangeMaxCombo.toLocaleString() + 'x' : '—';
      tileTypingWpmLabel.textContent = (isToday ? 'Fastest WPM today' : 'Fastest WPM') + (isSingleDay ? '' : labelSuffix);
      tileTypingScoreLabel.textContent = (isToday ? 'Highest score today' : 'Highest score') + (isSingleDay ? '' : labelSuffix);
      tileTypingWpm.textContent = rangeMaxTypingWpm > 0 ? rangeMaxTypingWpm.toLocaleString() + ' wpm' : '—';
      tileTypingScore.textContent = rangeMaxTypingScore > 0 ? rangeMaxTypingScore.toLocaleString() : '—';

      // Live tick for today's tiles
      if (isToday) {
        const t = todayKey();
        const liveTotalRef = db.ref('daily/' + t + '/total');
        const liveVisitorsRef = db.ref('daily/' + t + '/visitorCount');
        const liveMaxComboRef = db.ref('daily/' + t + '/maxCombo');
        let lastClicks = totalClicks;
        let lastVisitors = totalVisitors;
        const totalCb = (snap) => {
          lastClicks = snap.val() || 0;
          tileClicks.textContent = lastClicks.toLocaleString();
          tileCpv.textContent = lastVisitors > 0 ? (lastClicks / lastVisitors).toFixed(1) : '—';
        };
        const visCb = (snap) => {
          lastVisitors = snap.val() || 0;
          tileVisitors.textContent = lastVisitors.toLocaleString();
          tileCpv.textContent = lastVisitors > 0 ? (lastClicks / lastVisitors).toFixed(1) : '—';
        };
        const maxComboCb = (snap) => {
          const v = snap.val() || 0;
          tileMaxCombo.textContent = v > 0 ? v.toLocaleString() + 'x' : '—';
        };
        liveTotalRef.on('value', totalCb);
        liveVisitorsRef.on('value', visCb);
        liveMaxComboRef.on('value', maxComboCb);
        liveTodayUnsub = () => {
          liveTotalRef.off('value', totalCb);
          liveVisitorsRef.off('value', visCb);
          liveMaxComboRef.off('value', maxComboCb);
        };
      }

      // Trend lines: only meaningful for ranges > 1 day
      if (isSingleDay) {
        trendGrid.style.display = 'none';
      } else {
        trendGrid.style.display = '';
        const labels = dates.map(d => d.slice(5));
        const showPoints = dates.length <= 14;
        charts.clicks = new Chart(document.getElementById('chart-clicks'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: I18N.t('stats.tile.clicks'),
              data: dates.map(d => clicksByDate[d] || 0),
              borderColor: '#4dabf7',
              backgroundColor: 'rgba(77,171,247,0.18)',
              borderWidth: 2,
              tension: 0.3,
              fill: true,
              pointRadius: showPoints ? 3 : 0,
              pointHoverRadius: 5,
            }],
          },
          options: chartLineOptions(),
        });
        charts.visitors = new Chart(document.getElementById('chart-visitors'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: I18N.t('stats.tile.visitors'),
              data: dates.map(d => visitorsByDate[d] || 0),
              borderColor: '#ffa94d',
              backgroundColor: 'rgba(255,169,77,0.18)',
              borderWidth: 2,
              tension: 0.3,
              fill: true,
              pointRadius: showPoints ? 3 : 0,
              pointHoverRadius: 5,
            }],
          },
          options: chartLineOptions(),
        });
      }

      // Countries
      const sortedCountries = Object.entries(countryTotals).sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (sortedCountries.length === 0) {
        countriesEmpty.style.display = '';
        chartCountriesCanvas.style.display = 'none';
      } else {
        countriesEmpty.style.display = 'none';
        chartCountriesCanvas.style.display = '';
        charts.countries = new Chart(chartCountriesCanvas, {
          type: 'bar',
          data: {
            labels: sortedCountries.map(([code]) => `${countryFlag(code)} ${code}`),
            datasets: [{
              label: I18N.t('stats.tile.clicks'),
              data: sortedCountries.map(([, n]) => n),
              backgroundColor: 'rgba(77,171,247,0.55)',
              borderColor: '#4dabf7',
              borderWidth: 1,
              borderRadius: 4,
            }],
          },
          options: {
            ...chartLineOptions(),
            indexAxis: 'y',
          },
        });
      }

      // Characters used (doughnut over the new daily/{date}/characters/ data,
      // with skin-derived fallback applied above)
      const characterPalette = ['#4dabf7', '#da77f2', '#69db7c', '#ffa94d', '#ff6b6b', '#ffd43b'];
      const sortedCharacters = Object.entries(characterTotals).sort((a, b) => b[1] - a[1]);
      if (sortedCharacters.length === 0) {
        charactersEmpty.style.display = '';
        chartCharactersCanvas.style.display = 'none';
      } else {
        charactersEmpty.style.display = 'none';
        chartCharactersCanvas.style.display = '';
        charts.characters = new Chart(chartCharactersCanvas, {
          type: 'doughnut',
          data: {
            labels: sortedCharacters.map(([id]) => {
              const ch = CHARACTERS.find(c => c.id === id);
              return ch ? charName(ch) : id;
            }),
            datasets: [{
              data: sortedCharacters.map(([, n]) => n),
              backgroundColor: sortedCharacters.map((_, i) => characterPalette[i % characterPalette.length]),
              borderColor: 'rgba(255,255,255,0.9)',
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: { color: chartColor('--ui-text'), font: { size: 11, weight: '600' }, boxWidth: 12 },
              },
              tooltip: tooltipStyle(),
            },
          },
        });
      }

      // Click sources — doughnut of mouse vs keyboard (vs future auto-clicker).
      // Reads daily/{date}/sources for the selected range. Aoba-cyan for mouse,
      // yellow for keyboard, pink for auto so it stays consistent if expanded.
      const sourceLabels   = { mouse: 'Mouse', keyboard: 'Keyboard', auto: 'Auto' };
      const sourceColors   = { mouse: '#4dabf7', keyboard: '#f4cb4d', auto: '#ff5fa8' };
      const orderedSources = ['mouse', 'keyboard', 'auto'].filter(s => (sourceTotals[s] || 0) > 0);
      if (orderedSources.length === 0) {
        sourcesEmpty.style.display = '';
        chartSourcesCanvas.style.display = 'none';
      } else {
        sourcesEmpty.style.display = 'none';
        chartSourcesCanvas.style.display = '';
        charts.sources = new Chart(chartSourcesCanvas, {
          type: 'doughnut',
          data: {
            labels: orderedSources.map(s => I18N.t('stats.source.' + s)),
            datasets: [{
              data: orderedSources.map(s => sourceTotals[s] || 0),
              backgroundColor: orderedSources.map(s => sourceColors[s]),
              borderColor: 'rgba(255,255,255,0.9)',
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: { color: chartColor('--ui-text'), font: { size: 11, weight: '600' }, boxWidth: 12 },
              },
              tooltip: tooltipStyle(),
            },
          },
        });
      }

      // Skins per character — horizontal stacked bar. One bar per character; each variant
      // contributes a colored segment. Variants get a hue shifted from their character's
      // primary palette color so a related family reads as a group.
      const variantShades = ['', 'aa', '77', '55'];
      const characterDatasets = [];
      let anySkinData = false;
      CHARACTERS.forEach((c, ci) => {
        const base = characterPalette[ci % characterPalette.length];
        c.variants.forEach((v, vi) => {
          const count = skinTotals[v.id] || 0;
          if (count > 0) anySkinData = true;
          characterDatasets.push({
            label: variantName(v),
            data: CHARACTERS.map(cc => cc.id === c.id ? count : 0),
            backgroundColor: base + (variantShades[vi % variantShades.length] || ''),
            borderColor: 'rgba(255,255,255,0.7)',
            borderWidth: 1,
            stack: c.id,
          });
        });
      });
      if (!anySkinData) {
        skinsEmpty.style.display = '';
        chartSkinsCanvas.style.display = 'none';
      } else {
        skinsEmpty.style.display = 'none';
        chartSkinsCanvas.style.display = '';
        charts.skins = new Chart(chartSkinsCanvas, {
          type: 'bar',
          data: {
            labels: CHARACTERS.map(c => charName(c)),
            datasets: characterDatasets,
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: { color: chartColor('--ui-text'), font: { size: 11, weight: '600' }, boxWidth: 12 },
                // Hide zero-data variants from legend to avoid clutter when characters
                // have no clicks yet (especially the new Mari before populating sound).
                filter: (item, data) => {
                  const ds = data.datasets[item.datasetIndex];
                  return ds.data.some(v => v > 0);
                },
              },
              tooltip: {
                ...tooltipStyle(),
                callbacks: {
                  label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.x}`,
                },
              },
            },
            scales: {
              x: {
                stacked: true,
                beginAtZero: true,
                ticks: { color: chartColor('--ui-muted'), font: { size: 10, weight: '600' }, precision: 0 },
                grid: { color: chartColor('--ui-border') },
                border: { color: chartColor('--ui-border') },
              },
              y: {
                stacked: true,
                ticks: { color: chartColor('--ui-text'), font: { size: 11, weight: '700' } },
                grid: { display: false },
                border: { color: chartColor('--ui-border') },
              },
            },
          },
        });
      }
    }

    function chartColor(name) {
      return getComputedStyle(document.body).getPropertyValue(name).trim();
    }

    function chartLineOptions() {
      return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipStyle(),
        },
        scales: {
          x: {
            ticks: { color: chartColor('--ui-muted'), font: { size: 10, weight: '600' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
            grid: { color: chartColor('--ui-border') },
            border: { color: chartColor('--ui-border') },
          },
          y: {
            beginAtZero: true,
            ticks: { color: chartColor('--ui-muted'), font: { size: 10, weight: '600' }, precision: 0 },
            grid: { color: chartColor('--ui-border') },
            border: { color: chartColor('--ui-border') },
          },
        },
      };
    }

    function tooltipStyle() {
      return {
        backgroundColor: chartColor('--ui-paper'),
        borderColor: chartColor('--ui-border'),
        borderWidth: 1,
        titleColor: chartColor('--ui-text'),
        titleFont: { weight: '700' },
        bodyColor: chartColor('--ui-text'),
        bodyFont: { weight: '600' },
        padding: 10,
        cornerRadius: 10,
        boxShadow: '0 6px 20px rgba(0,30,60,0.18)',
      };
    }

    // --- Text Particles (Cookie Clicker style) ---
    const PARTICLE_TEXTS = ['うぇ', '💢', '😭', 'うぇぇ', '😤', '😢', '💢💢', 'うぇっ', '😡', '😿'];
    const PARTICLE_COLORS = ['#ff6b6b', '#ffa94d', '#69db7c', '#4dabf7', '#da77f2', '#ffd43b', '#ff8787'];

    const MAX_PARTICLES = 60;
    let activeParticles = 0;

    const MAX_PLUSONES = 20;
    let activePlusOnes = 0;
    function spawnPlusOne(x, y) {
      // Cap concurrent floaters: at 30+ cps spam the unbounded DOM churn was the
      // main lag source. Dropping new floaters when the cap is hit is invisible
      // (there's already a sea of identical "+1"s on screen).
      if (activePlusOnes >= MAX_PLUSONES) return;
      activePlusOnes++;
      const el = document.createElement('div');
      el.className = 'click-plusone';
      el.textContent = '+1';
      el.style.left = (x - 8) + 'px';
      el.style.top  = (y - 14) + 'px';
      document.body.appendChild(el);
      animate(el, {
        translateY: -56,
        opacity: [{ to: 1, duration: 80 }, { to: 1, duration: 350 }, { to: 0, duration: 250 }],
        duration: 680,
        ease: 'outQuad',
        onComplete: () => { el.remove(); activePlusOnes--; },
      });
    }

    function spawnParticles() {
      const container = document.getElementById('particles');
      const isMobileScreen = window.innerWidth < 480;
      const count = isMobileScreen
        ? 3 + Math.floor(Math.random() * 3)
        : 5 + Math.floor(Math.random() * 4);

      const toSpawn = Math.min(count, MAX_PARTICLES - activeParticles);
      if (toSpawn <= 0) return;

      for (let i = 0; i < toSpawn; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.textContent = PARTICLE_TEXTS[Math.floor(Math.random() * PARTICLE_TEXTS.length)];

        const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
        const fontSize = isMobileScreen
          ? 18 + Math.floor(Math.random() * 14)
          : 28 + Math.floor(Math.random() * 20);
        const startX = 10 + Math.random() * 80;

        particle.style.cssText = `
          left: ${startX}%;
          bottom: -40px;
          color: ${color};
          font-size: ${fontSize}px;
        `;

        container.appendChild(particle);
        activeParticles++;

        const drift = -30 + Math.random() * 60;
        const duration = 1500 + Math.random() * 1000;
        const delay = Math.random() * 300;

        animate(particle, {
          translateY: [0, -(window.innerHeight + 100)],
          translateX: [0, drift],
          opacity: [1, 0],
          duration: duration,
          delay: delay,
          ease: 'outQuad',
          onComplete: () => {
            particle.remove();
            activeParticles--;
          },
        });
      }
    }

    // --- Click Interaction ---
    const character = document.getElementById('character');
    const aobaImg = document.getElementById('aoba-img');
    // Soundpool layout: one sub-pool per sfx entry. soundPools[i] is an array of
    // pre-allocated Audio elements all bound to sfxList[i]. POOL_BUDGET total stays
    // ~constant regardless of how many sfx the character has (50 audio elements is
    // plenty for spam-click; min 10 per source so 5+ source characters still feel
    // responsive).
    const POOL_BUDGET = 50;
    const MIN_PER_SOURCE = 10;
    let soundPools = [];        // soundPools[srcIdx] = Audio[]
    let poolCursors = [];       // poolCursors[srcIdx] = next slot to play within that sub-pool
    let slotActiveByPool = [];  // slotActiveByPool[srcIdx][slot] = bool
    let sfxCycleIndex = 0;      // which sound plays on the next click (cycles 0..N-1)
    let activeSounds = 0;
    // Legacy flat array — kept so the "no SFX → no-op" check in playsfx still works.
    const soundPool = [];

    function goIdle() {
      // Revert sprite only. The bounce ends at translateY=0 naturally, so no transform
      // reset needed; ripping the transform out mid-arc was causing the "animation
      // jumped" artifact when short Mari sfx ended before the 700ms bounce finished.
      aobaImg.src = getVariant(settings.skin).variant.idle;
    }

    function buildSoundPool() {
      const { character: ch } = getVariant(settings.skin);
      soundPool.length = 0;
      soundPools = [];
      poolCursors = [];
      slotActiveByPool = [];
      sfxCycleIndex = 0;
      activeSounds = 0;
      const sfxList = Array.isArray(ch.sfx) ? ch.sfx : (ch.sfx ? [ch.sfx] : []);
      if (sfxList.length === 0) return;
      const perSource = Math.max(MIN_PER_SOURCE, Math.floor(POOL_BUDGET / sfxList.length));
      sfxList.forEach((src, srcIdx) => {
        const sub = [];
        const activeFlags = new Array(perSource).fill(false);
        for (let i = 0; i < perSource; i++) {
          const a = new Audio(src);
          a.preload = 'auto';
          const slotIdx = i;
          a.addEventListener('ended', () => {
            // Decrement so future plays don't over-duck volume. Sprite reset is driven
            // by the bounce animation's onComplete, NOT by sfx end — short Mari sounds
            // would otherwise yank the sprite back to idle before the bounce arc is done.
            if (activeFlags[slotIdx]) {
              activeFlags[slotIdx] = false;
              activeSounds--;
            }
          });
          sub.push(a);
          soundPool.push(a); // populate legacy flat array so playsfx's empty-check still works
        }
        soundPools.push(sub);
        slotActiveByPool.push(activeFlags);
        poolCursors.push(0);
      });
    }
    buildSoundPool();
    window._soundPoolReady = true;

    function playsfx() {
      if (soundPools.length === 0) return; // silent character
      // Pick the next sound in the sequential cycle. After all sounds have played
      // once, wraps back to index 0 — exactly the "play through then restart from
      // the top" behavior we want.
      const srcIdx = sfxCycleIndex;
      sfxCycleIndex = (sfxCycleIndex + 1) % soundPools.length;
      const sub = soundPools[srcIdx];
      const active = slotActiveByPool[srcIdx];
      const slot = poolCursors[srcIdx];
      poolCursors[srcIdx] = (slot + 1) % sub.length;
      const sfx = sub[slot];
      if (!active[slot]) activeSounds++;
      active[slot] = true;
      sfx.volume = (settings.sfxVol / 100) / Math.sqrt(Math.max(1, activeSounds));
      sfx.currentTime = 0;
      sfx.play().catch(() => {
        if (active[slot]) {
          active[slot] = false;
          activeSounds--;
        }
      });
    }
    let bounceAnimation = null;
    const clickCounter = document.querySelector('#click-counter .pill-value');
    const clickCounterSub = document.querySelector('#click-counter .pill-sub-value');

    // Live click counters with optimistic UI.
    //   display = lastSeenServer + pending + inFlight
    //   - lastSeenServer: most recent value from .on('value') (real-time)
    //   - pending: clicks accumulated locally, awaiting next batch flush
    //   - inFlight: deltas already sent in a batch but not yet visible in the
    //     listener; cleared once the listener confirms server caught up
    // This means the pill ticks up the moment you click (because pending bumps
    // immediately), holds steady across the flush handoff, then seamlessly
    // transitions to the new server total — no flicker, no perceptible lag.
    let lastSeenGlobalServer  = 0;
    let inFlightGlobal        = 0;
    let lastSeenSkinServer    = 0;
    let inFlightSkin          = 0;
    let currentSkinVariant    = settings.skin;

    function renderClickCounter() {
      // pending is a hoisted `var`; if the batcher block hasn't executed yet,
      // it's undefined. Treat that as zero-pending so the listener-driven
      // first render still works at startup.
      const p = (typeof pending !== 'undefined' && pending) ? pending : null;
      const globalPending = p ? (p.global || 0) : 0;
      const skinPending   = p ? (p.allTimeSkin[currentSkinVariant] || 0) : 0;
      clickCounter.textContent    = (lastSeenGlobalServer + globalPending + inFlightGlobal).toLocaleString();
      clickCounterSub.textContent = (lastSeenSkinServer   + skinPending   + inFlightSkin).toLocaleString();
    }

    clicksRef.on('value', (snapshot) => {
      const val = snapshot.val() || 0;
      // If we have an in-flight delta and the server now reflects it (or more),
      // release it. We check `>= snapshot + inFlight` rather than exact equality
      // because other users' contributions may have arrived alongside ours.
      if (inFlightGlobal > 0 && val >= lastSeenGlobalServer + inFlightGlobal) {
        inFlightGlobal = 0;
      }
      lastSeenGlobalServer = val;
      renderClickCounter();
    });

    let currentSkinCountUnsub = null;
    function subscribeCurrentSkinCount(variantId) {
      if (currentSkinCountUnsub) { currentSkinCountUnsub(); currentSkinCountUnsub = null; }
      currentSkinVariant   = variantId;
      lastSeenSkinServer   = 0;
      inFlightSkin         = 0;
      renderClickCounter();
      const ref = db.ref('skins/' + variantId);
      const cb = (snap) => {
        const val = snap.val() || 0;
        if (inFlightSkin > 0 && val >= lastSeenSkinServer + inFlightSkin) {
          inFlightSkin = 0;
        }
        lastSeenSkinServer = val;
        renderClickCounter();
      };
      ref.on('value', cb);
      currentSkinCountUnsub = () => ref.off('value', cb);
    }
    window._skinCounterReady = true;
    subscribeCurrentSkinCount(settings.skin);

    // --- Sensei bar live state ---------------------------------------------------
    // Level curve (cosmetic): level = floor(sqrt(clicks/20))
    // Lv.1 at 20 clicks, Lv.10 at 2k, Lv.50 at 50k, Lv.100 at 200k.
    function levelOf(clicks)             { return Math.floor(Math.sqrt(clicks / 20)); }
    function clicksForLevel(n)           { return n * n * 20; }
    // Level/XP progression counts clicks AND typing (each typed word ~5 keystrokes
    // of progress). The leaderboard still RANKS by totalClicks only — this only
    // feeds the level shown in the sensei bar and on leaderboard rows.
    const TYPING_WORD_XP = 5;
    function progressXp(totalClicks, typingWords) { return (totalClicks || 0) + (typingWords || 0) * TYPING_WORD_XP; }
    function clicksInLevel(c)            { return c - clicksForLevel(levelOf(c)); }
    function clicksToNextLevel(c)        { return clicksForLevel(levelOf(c) + 1) - clicksForLevel(levelOf(c)); }

    // --- Per-variant bonding ----------------------------------------------------
    // When a variant's level hits MAX_VARIANT_LEVEL the user can "bond" — a
    // per-character prestige that bumps stats/bonds/$variantId by 1 and resets
    // the visible level back to 0 (lifetime clicks are preserved, just shifted
    // out of view). Each bond grants a permanent +10% coin multiplier WHILE
    // using that variant — never touches the click field, so the leaderboard
    // ranking is untouched. MAX_VARIANT_LEVEL and BOND_COIN_BONUS_PER_LEVEL
    // are declared earlier in the file (right after CHARACTERS) so script-init
    // render calls can read them without a TDZ.
    function variantClicks(variantId) {
      const allSkins     = (userStats && userStats.skins) || {};
      const pendingSkins = (typeof pending !== 'undefined' && pending && pending.allTimeSkin) ? pending.allTimeSkin : {};
      return (allSkins[variantId] || 0) + (pendingSkins[variantId] || 0);
    }

    function variantBonds(variantId) {
      const allBonds = (userStats && userStats.bonds) || {};
      return allBonds[variantId] || 0;
    }

    function variantEffectiveClicks(variantId) {
      // After N bonds, the level meter starts over — effective = lifetime − N × clicks-for-MAX.
      return Math.max(0, variantClicks(variantId) - variantBonds(variantId) * clicksForLevel(MAX_VARIANT_LEVEL));
    }

    function variantLevelOf(variantId) {
      return Math.min(MAX_VARIANT_LEVEL, levelOf(variantEffectiveClicks(variantId)));
    }

    function variantCanBond(variantId) {
      if (variantBonds(variantId) >= MAX_BOND_LEVEL) return false;
      return variantEffectiveClicks(variantId) >= clicksForLevel(MAX_VARIANT_LEVEL);
    }

    function variantXpInLevel(variantId) {
      const eff = variantEffectiveClicks(variantId);
      const lv  = variantLevelOf(variantId);
      return Math.max(0, eff - clicksForLevel(lv));
    }

    function variantXpToNext(variantId) {
      const lv = variantLevelOf(variantId);
      if (lv >= MAX_VARIANT_LEVEL) return clicksForLevel(MAX_VARIANT_LEVEL) - clicksForLevel(MAX_VARIANT_LEVEL - 1);
      return clicksForLevel(lv + 1) - clicksForLevel(lv);
    }

    async function doBond(variantId) {
      if (!variantId) return;
      if (!variantCanBond(variantId)) return;
      const v = getVariant(variantId).variant;
      const next = variantBonds(variantId) + 1;
      const confirmMsg = I18N.t('bond.confirm', { name: variantName(v), n: next });
      const ok = await showConfirm(I18N.t('bond.title'), confirmMsg, { confirmLabel: '♥ ' + I18N.t('bond.cta') });
      if (!ok) return;

      // Guest mode — write straight to local stats. Bond eligibility math reads
      // userStats.bonds, which is hydrated from localStorage at startup.
      if (!currentUser) {
        if (!userStats.bonds) userStats.bonds = {};
        userStats.bonds[variantId] = next;
        if (typeof saveLocalUserData === 'function') saveLocalUserData();
        renderSkinList();
        renderSkinBar();
        return;
      }

      try {
        await db.ref(`users/${currentUser.uid}/stats/bonds/${variantId}`).set(next);
        // The stats listener will reconcile; optimistic UI bump so the heart
        // count updates without waiting for the round-trip.
        if (!userStats.bonds) userStats.bonds = {};
        userStats.bonds[variantId] = next;
        renderSkinList();
        renderSkinBar();
      } catch (err) {
        showAlert(I18N.t('bond.title'), 'Bond failed: ' + (err.message || err.code || 'unknown'));
      }
    }

    let senseiAvatarEl = document.getElementById('sensei-avatar');
    const senseiNameEl   = document.getElementById('sensei-name');
    const senseiFlagEl   = document.getElementById('sensei-flag');
    const senseiLevelEl  = document.getElementById('sensei-level');
    const senseiXpFillEl = document.getElementById('sensei-xp-fill');
    const senseiXpTextEl = document.getElementById('sensei-xp-text');
    const senseiCoinsEl  = document.getElementById('sensei-coins');
    const senseiPrestigeEl = document.getElementById('sensei-prestige');

    // `var` (not let) so hoisted reads from variantClicks/shopMul/renderCountryArea
    // before this line are `undefined` rather than TDZ throws. Initial-state
    // guards (`userStats && userStats.skins`, etc.) already handle the undefined
    // case, so reads return safe empty values during the brief startup window
    // before this binding initializes.
    var userStats = { totalClicks: 0, coinBalance: 0 };
    var userProfile = null;
    var userShop = {};                 // { coinMulLevel, clickMulLevel, autoLevel, leaderboardAutoUnlocked, buffs }
    let userStatsUnsub = null;
    let userProfileUnsub = null;
    let userShopUnsub = null;

    // --- Local guest state ------------------------------------------------------
    // When no Firebase user is signed in, stats/shop live in localStorage. On
    // Google sign-in, this state is merged into users/{uid}/* and cleared.
    const LOCAL_USER_KEY = 'aobing-local-user';
    function loadLocalUserData() {
      try {
        const raw = localStorage.getItem(LOCAL_USER_KEY);
        if (!raw) return { stats: {}, shop: {} };
        const parsed = JSON.parse(raw);
        return {
          stats: (parsed && parsed.stats) || {},
          shop:  (parsed && parsed.shop)  || {},
        };
      } catch {
        return { stats: {}, shop: {} };
      }
    }
    function saveLocalUserData() {
      if (currentUser) return;  // only persist while in guest mode
      try {
        // fishdex and aquariumSpecimens ride along on userStats automatically.
        localStorage.setItem(LOCAL_USER_KEY, JSON.stringify({ stats: userStats, shop: userShop }));
      } catch {}
    }
    function clearLocalUserData() {
      try { localStorage.removeItem(LOCAL_USER_KEY); } catch {}
    }

    // --- Shop helpers -----------------------------------------------------------
    const SHOP_MAX_LEVEL = 30;
    const SHOP_BUFF_COST = 160;          // ~20% cheaper (was 200)
    const SHOP_BUFF_DURATION_MS = 60_000;
    const SHOP_LBAUTO_COST = 8_000;      // ~20% cheaper (was 10k)

    function shopFieldFor(which) {
      if (which === 'coinMul')    return 'coinMulLevel';
      if (which === 'clickMul')   return 'clickMulLevel';
      if (which === 'autoLevel')  return 'autoLevel';
      return null;
    }

    function shopCostFor(which, level) {
      // Base prices reduced ~20% (50->40, 75->60).
      if (which === 'coinMul' || which === 'clickMul') return Math.round(40 * Math.pow(1.5, level));
      if (which === 'autoLevel')                       return Math.round(60 * Math.pow(1.4, level));
      return Infinity;
    }

    function shopEffectFor(which, level) {
      if (which === 'coinMul' || which === 'clickMul') return 1 + 0.5 * level;
      if (which === 'autoLevel')                       return 0.5 * level;
      return 0;
    }

    // Returns the active multiplier set at `now`, reading the last-seen userShop.
    function shopMul(now) {
      const s = userShop || {};
      const b = s.buffs || {};
      const active = (key) => ((b[key] && b[key].expiresAt) || 0) > now;
      // Permanent +20% coins per prestige star. Applies to coins only — clicks
      // (which feed totalClicks/leaderboard) are untouched by design, so prestige
      // can't be used to inflate leaderboard standing.
      const stars = (userStats && userStats.prestigeStars) || 0;
      const prestigeMul = 1 + 0.20 * stars;
      // Per-variant bond bonus — +10% coins per bond level WHILE using that
      // variant. Same coin-only constraint as prestige.
      const activeBonds = variantBonds(settings.skin);
      const bondMul     = 1 + BOND_COIN_BONUS_PER_LEVEL * activeBonds;
      return {
        coin:     (1 + 0.5 * (s.coinMulLevel  || 0)) * prestigeMul * bondMul * (active('coins')    ? 2 : 1),
        click:    (1 + 0.5 * (s.clickMulLevel || 0)) *                         (active('clicks')   ? 2 : 1),
        autoCps:  0.5 * (s.autoLevel || 0)           *                         (active('autoRate') ? 2 : 1),
        lbAuto:   !!s.leaderboardAutoUnlocked,
      };
    }

    function shopPrestigeEligible() {
      const s = userShop || {};
      return (s.coinMulLevel  || 0) >= SHOP_MAX_LEVEL
          || (s.clickMulLevel || 0) >= SHOP_MAX_LEVEL
          || (s.autoLevel     || 0) >= SHOP_MAX_LEVEL;
    }

    function shopAffordableCoins() {
      // Listeners may fire before the `pending` initializer runs at script bottom.
      // var hoisting makes `pending` exist but be `undefined`, so guard the read.
      const pendingCoins = (typeof pending !== 'undefined' && pending) ? (pending.userCoins || 0) : 0;
      return (userStats.coinBalance || 0) + pendingCoins;
    }

    function shopFormatNum(n) {
      return Math.floor(n).toLocaleString();
    }

    function shopFormatTimeLeft(ms) {
      const sec = Math.max(0, Math.ceil(ms / 1000));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function renderShopPanel() {
      const panel = document.getElementById('shop-panel');
      if (!panel) return;
      const now = Date.now();
      const s = userShop || {};
      const have = shopAffordableCoins();
      const context = document.getElementById('shop-context');
      if (context) context.textContent = I18N.t(settings.gameMode === 'typing' ? 'shop.kicker.typing' : 'shop.kicker.clicker');
      const wallet = document.getElementById('shop-wallet');
      if (wallet) wallet.textContent = shopFormatNum(have);

      // Permanent + Auto leveled items
      const leveled = [
        { which: 'coinMul',   name: I18N.t('shop.item.coinMul.name'),   level: s.coinMulLevel  || 0 },
        { which: 'clickMul',  name: I18N.t('shop.item.clickMul.name'),  level: s.clickMulLevel || 0 },
        { which: 'autoLevel', name: I18N.t('shop.item.autoLevel.name'), level: s.autoLevel     || 0 },
      ];
      for (const it of leveled) {
        const el = panel.querySelector(`.shop-item[data-item="${it.which}"]`);
        if (!el) continue;
        const atMax = it.level >= SHOP_MAX_LEVEL;
        const cost = atMax ? 0 : shopCostFor(it.which, it.level);
        const curEffect  = shopEffectFor(it.which, it.level);
        const nextEffect = shopEffectFor(it.which, it.level + 1);
        const effectFmt = (v) => it.which === 'autoLevel' ? `${v.toFixed(1)} c/s` : `×${v}`;
        const badge = atMax
          ? `<span class="shop-level-badge shop-level-max">${escapeHtml(I18N.t('shop.atMax'))}</span>`
          : `<span class="shop-level-badge">Lv ${it.level}</span>`;
        const stepText  = atMax ? '' : `→ Lv ${it.level + 1}`;
        const costText  = atMax ? '' : `💰 ${shopFormatNum(cost)}`;
        const subText   = atMax ? effectFmt(curEffect) : `${effectFmt(curEffect)} → ${effectFmt(nextEffect)}`;
        el.innerHTML = `
          <div class="shop-item-row">
            <span>${escapeHtml(it.name)} ${badge}</span>
            <span>${stepText}</span>
            <span class="shop-item-cost">${costText}</span>
          </div>
          <div class="shop-item-sub">${subText}</div>
        `;
        el.setAttribute('aria-disabled', (atMax || have < cost) ? 'true' : 'false');
      }

      // Leaderboard Auto (one-shot)
      {
        const el = panel.querySelector('.shop-item[data-item="leaderboardAuto"]');
        if (el) {
          const owned = !!s.leaderboardAutoUnlocked;
          const cost  = SHOP_LBAUTO_COST;
          const badge = owned
            ? ` <span class="shop-level-badge shop-level-owned">${escapeHtml(I18N.t('shop.owned'))}</span>`
            : '';
          const costText  = owned ? '' : `💰 ${shopFormatNum(cost)}`;
          el.innerHTML = `
            <div class="shop-item-row">
              <span>${escapeHtml(I18N.t('shop.item.leaderboardAuto.name'))}${badge}</span>
              <span></span>
              <span class="shop-item-cost">${costText}</span>
            </div>
            <div class="shop-item-sub">${escapeHtml(I18N.t('shop.item.leaderboardAuto.desc'))}</div>
          `;
          el.setAttribute('aria-disabled', (owned || have < cost) ? 'true' : 'false');
        }
      }

      // Buffs
      const buffs = [
        { key: 'coins',    which: 'buffCoins',    name: 'shop.item.buffCoins.name' },
        { key: 'clicks',   which: 'buffClicks',   name: 'shop.item.buffClicks.name' },
        { key: 'autoRate', which: 'buffAutoRate', name: 'shop.item.buffAutoRate.name' },
      ];
      for (const b of buffs) {
        const el = panel.querySelector(`.shop-item[data-item="${b.which}"]`);
        if (!el) continue;
        const exp = (s.buffs && s.buffs[b.key] && s.buffs[b.key].expiresAt) || 0;
        const active = exp > now;
        const levelText = active ? `${shopFormatTimeLeft(exp - now)} left` : '';
        const costText  = `💰 ${shopFormatNum(SHOP_BUFF_COST)}`;
        el.innerHTML = `
          <div class="shop-item-row">
            <span>${escapeHtml(I18N.t(b.name))}</span>
            <span>${levelText}</span>
            <span class="shop-item-cost">${costText}</span>
          </div>
          <div class="shop-item-sub">${active ? '+60s' : '×2 for 60s'}</div>
        `;
        el.setAttribute('aria-disabled', (have < SHOP_BUFF_COST) ? 'true' : 'false');
      }

      // Prestige
      {
        const el = panel.querySelector('.shop-item[data-item="prestige"]');
        if (el) {
          const stars    = (userStats && userStats.prestigeStars) || 0;
          const curPct   = Math.round(stars * 5);
          const nextPct  = curPct + 5;
          const eligible = shopPrestigeEligible();
          const badge    = `<span class="shop-level-badge shop-level-star">★ ${stars}</span>`;
          const stepText = eligible ? `→ ★ ${stars + 1}` : '';
          const ctaText  = eligible ? I18N.t('shop.prestige.cta') : '';
          const subText  = eligible
            ? `+${curPct}% → +${nextPct}% ${I18N.t('shop.prestige.coinsLabel')} ${I18N.t('shop.prestige.permanent')}`
            : `${I18N.t('shop.prestige.locked', { n: SHOP_MAX_LEVEL })} · +${curPct}% ${I18N.t('shop.prestige.coinsLabel')}`;
          el.innerHTML = `
            <div class="shop-item-row">
              <span>${escapeHtml(I18N.t('shop.prestige.name'))} ${badge}</span>
              <span>${escapeHtml(stepText)}</span>
              <span class="shop-item-cost shop-item-prestige-cta">${escapeHtml(ctaText)}</span>
            </div>
            <div class="shop-item-sub">${escapeHtml(subText)}</div>
          `;
          el.setAttribute('aria-disabled', eligible ? 'false' : 'true');
        }
      }
    }

    // --- Shop buy handlers ------------------------------------------------------
    function shopShowError(itemEl) {
      if (!itemEl) return;
      itemEl.classList.add('flash-error');
      setTimeout(() => itemEl.classList.remove('flash-error'), 500);
    }

    function shopPlayPurchaseFX(itemEl, label) {
      if (!itemEl) return;
      itemEl.classList.remove('purchased');
      // Force reflow so re-adding the class restarts the animation from frame 0.
      void itemEl.offsetHeight;
      itemEl.classList.add('purchased');
      setTimeout(() => itemEl.classList.remove('purchased'), 600);

      if (label) {
        const rect = itemEl.getBoundingClientRect();
        const pop = document.createElement('div');
        pop.className = 'shop-buy-pop';
        pop.textContent = label;
        pop.style.left = (rect.right - 40) + 'px';
        pop.style.top  = (rect.top  + 10) + 'px';
        document.body.appendChild(pop);
        setTimeout(() => pop.remove(), 1000);
      }
    }

    async function buyLeveled(which, itemEl) {
      const field = shopFieldFor(which);
      if (!field) return;
      const level = userShop[field] || 0;
      if (level >= SHOP_MAX_LEVEL) return;
      const cost = shopCostFor(which, level);
      if (shopAffordableCoins() < cost) { shopShowError(itemEl); return; }

      pending.userCoins -= cost;
      if (itemEl) itemEl.setAttribute('aria-disabled', 'true');
      savePending();
      scheduleFlush();
      renderSenseiBar();
      renderShopPanel();
      shopPlayPurchaseFX(itemEl, `Lv ${level + 1}!`);

      if (!currentUser) {
        // Guest mode: write straight to local shop state.
        userShop[field] = level + 1;
        saveLocalUserData();
        renderShopPanel();
        if (typeof rearmAutoLoop === 'function') rearmAutoLoop();
        return;
      }

      try {
        await db.ref(`users/${currentUser.uid}/shop/${field}`).set(level + 1);
      } catch (err) {
        // Refund the optimistic debit. Re-render will re-enable the row.
        pending.userCoins += cost;
        savePending();
        scheduleFlush();
        renderSenseiBar();
        renderShopPanel();
        shopShowError(itemEl);
      }
    }

    async function buyOneShot(itemEl) {
      if (userShop.leaderboardAutoUnlocked) return;
      const cost = SHOP_LBAUTO_COST;
      if (shopAffordableCoins() < cost) { shopShowError(itemEl); return; }

      pending.userCoins -= cost;
      if (itemEl) itemEl.setAttribute('aria-disabled', 'true');
      savePending();
      scheduleFlush();
      renderSenseiBar();
      renderShopPanel();
      shopPlayPurchaseFX(itemEl, '✓ Unlocked!');

      if (!currentUser) {
        userShop.leaderboardAutoUnlocked = true;
        saveLocalUserData();
        renderShopPanel();
        return;
      }

      try {
        await db.ref(`users/${currentUser.uid}/shop/leaderboardAutoUnlocked`).set(true);
      } catch (err) {
        pending.userCoins += cost;
        savePending();
        scheduleFlush();
        renderSenseiBar();
        renderShopPanel();
        shopShowError(itemEl);
      }
    }

    // One-shot boolean unlocks for the typing game (assist + QoL modifiers).
    // Generic sibling of buyOneShot; the typing panel (typing.js) owns the UI.
    const TYPING_MOD_COSTS = {
      typingFreedom: 2000, typingNoBackspace: 1500, typingStopOnError: 1500, typingQol: 3000,
    };
    async function buyTypingMod(key) {
      const cost = TYPING_MOD_COSTS[key];
      if (!cost) return false;
      if (userShop && userShop[key]) return true;          // already owned
      if (shopAffordableCoins() < cost) return false;
      pending.userCoins -= cost;
      savePending();
      scheduleFlush();
      renderSenseiBar();
      if (!currentUser) {
        userShop[key] = true;
        saveLocalUserData();
        return true;
      }
      try {
        await db.ref(`users/${currentUser.uid}/shop/${key}`).set(true);
        userShop[key] = true; // optimistic; shop listener will confirm
        return true;
      } catch (err) {
        pending.userCoins += cost; // rollback debit
        savePending();
        scheduleFlush();
        renderSenseiBar();
        return false;
      }
    }

    // Tiered typing combo upgrades (numeric, not boolean). Stored under
    // users/{uid}/shop. comboPowerLevel scales every word's buffer; casualComboCap
    // raises the safe-farm multiplier ceiling. Costs are a placeholder curve —
    // tune so a skilled ranked typist out-earns a ~lvl-20 clicker (500–1000/s).
    const COMBO_POWER_MAX = 100;
    const CASUAL_CAP_TIERS = [20, 50, 100, 250, 500]; // ×multiplier ceilings
    // Flat coin rate applied to the raw per-word typing payout (see creditTyping).
    // Typing is decoupled from shopMul.coin; this is the only currency knob. Sized
    // so a maxed Combo Power (100) no-miss ~15s run (~800k raw) lands near 5M.
    const TYPING_COIN_RATE = 6;
    function comboPowerLevelOf(shop) { return Math.max(1, (shop && shop.comboPowerLevel) || 1); }
    function casualComboCapOf(shop)  { return (shop && shop.casualComboCap) || CASUAL_CAP_TIERS[0]; }
    function comboPowerCost(nextLevel) { return nextLevel * nextLevel * 250; }   // L2=1000, L10=25000…
    function casualCapCost(tierIdx)    { return (tierIdx + 1) * 5000; }          // tier1=10000…

    // key: 'comboPowerLevel' | 'casualComboCap'. Returns true on success.
    async function buyTypingUpgrade(key) {
      const shop = userShop || {};
      let nextVal, cost;
      if (key === 'comboPowerLevel') {
        const cur = comboPowerLevelOf(shop);
        if (cur >= COMBO_POWER_MAX) return false;
        nextVal = cur + 1;
        cost = comboPowerCost(nextVal);
      } else if (key === 'casualComboCap') {
        const cur = casualComboCapOf(shop);
        const idx = CASUAL_CAP_TIERS.indexOf(cur);
        if (idx === -1 || idx >= CASUAL_CAP_TIERS.length - 1) return false;
        nextVal = CASUAL_CAP_TIERS[idx + 1];
        cost = casualCapCost(idx + 1);
      } else {
        return false;
      }
      if (shopAffordableCoins() < cost) return false;
      pending.userCoins -= cost;
      savePending();
      scheduleFlush();
      renderSenseiBar();
      if (!currentUser) {
        userShop[key] = nextVal;
        saveLocalUserData();
        return true;
      }
      try {
        await db.ref(`users/${currentUser.uid}/shop/${key}`).set(nextVal);
        userShop[key] = nextVal; // optimistic; shop listener confirms
        return true;
      } catch (err) {
        pending.userCoins += cost; // rollback
        savePending();
        scheduleFlush();
        renderSenseiBar();
        return false;
      }
    }

    async function buyBuff(kind, itemEl) {
      if (!['coins','clicks','autoRate'].includes(kind)) return;
      const cost = SHOP_BUFF_COST;
      if (shopAffordableCoins() < cost) { shopShowError(itemEl); return; }

      pending.userCoins -= cost;
      savePending();
      scheduleFlush();
      renderSenseiBar();
      renderShopPanel();
      shopPlayPurchaseFX(itemEl, '+60s');

      if (!currentUser) {
        // Guest mode: extend local buff expiration directly.
        const baseFloor = Date.now();
        const cur = (userShop.buffs && userShop.buffs[kind] && userShop.buffs[kind].expiresAt) || 0;
        const base = cur > baseFloor ? cur : baseFloor;
        if (!userShop.buffs) userShop.buffs = {};
        if (!userShop.buffs[kind]) userShop.buffs[kind] = {};
        userShop.buffs[kind].expiresAt = base + SHOP_BUFF_DURATION_MS;
        saveLocalUserData();
        renderShopPanel();
        if (typeof syncBuffTimers === 'function') syncBuffTimers();
        if (typeof rearmAutoLoop  === 'function') rearmAutoLoop();
        return;
      }

      try {
        const buffRef = db.ref(`users/${currentUser.uid}/shop/buffs/${kind}/expiresAt`);
        await buffRef.transaction(current => {
          const baseFloor = Date.now();
          const base = (typeof current === 'number' && current > baseFloor) ? current : baseFloor;
          return base + SHOP_BUFF_DURATION_MS;
        });
      } catch (err) {
        pending.userCoins += cost;
        savePending();
        scheduleFlush();
        renderSenseiBar();
        renderShopPanel();
        shopShowError(itemEl);
      }
    }

    async function doPrestige(itemEl) {
      if (!currentUser) return;
      if (!shopPrestigeEligible()) { shopShowError(itemEl); return; }

      const uid = currentUser.uid;
      const newStars = (userStats.prestigeStars || 0) + 1;
      const confirmMsg = I18N.t('shop.prestige.confirm', { n: newStars });
      const ok = await showConfirm(I18N.t('shop.prestige.title'), confirmMsg, { confirmLabel: '★ ' + I18N.t('shop.prestige.cta') });
      if (!ok) return;

      // Snapshot everything we optimistically wipe so we can roll back if the
      // atomic Firebase update fails. userClicks/totalClicks are deliberately
      // untouched — leaderboard standing survives prestige.
      const heldPendingCoins  = pending.userCoins;
      const heldInFlightCoins = inFlightUserCoins;
      const heldCoinBalance   = userStats.coinBalance;
      const heldPrestigeStars = userStats.prestigeStars;
      const heldShop          = { ...userShop };

      pending.userCoins  = 0;
      inFlightUserCoins  = 0;
      userStats = { ...userStats, coinBalance: 0, prestigeStars: newStars };
      userShop  = { ...userShop, coinMulLevel: 0, clickMulLevel: 0, autoLevel: 0,
                                 leaderboardAutoUnlocked: false, buffs: null };
      savePending();
      renderSenseiBar();
      renderShopPanel();
      if (typeof rearmAutoLoop === 'function') rearmAutoLoop();
      shopPlayPurchaseFX(itemEl, `★ Prestige ${newStars}!`);

      const updates = {
        [`users/${uid}/shop/coinMulLevel`]:            0,
        [`users/${uid}/shop/clickMulLevel`]:           0,
        [`users/${uid}/shop/autoLevel`]:               0,
        [`users/${uid}/shop/leaderboardAutoUnlocked`]: false,
        [`users/${uid}/shop/buffs`]:                   null,
        [`users/${uid}/stats/coinBalance`]:            0,
        [`users/${uid}/stats/prestigeStars`]:          newStars,
      };

      try {
        await db.ref().update(updates);
      } catch (err) {
        // Roll back optimistic UI. Firebase listeners will reconcile against
        // the real server state on next push regardless.
        pending.userCoins  = heldPendingCoins;
        inFlightUserCoins  = heldInFlightCoins;
        userStats = { ...userStats, coinBalance: heldCoinBalance, prestigeStars: heldPrestigeStars };
        userShop  = heldShop;
        savePending();
        renderSenseiBar();
        renderShopPanel();
        if (typeof rearmAutoLoop === 'function') rearmAutoLoop();
        shopShowError(itemEl);
      }
    }

    // Click delegation across the whole shop panel.
    document.getElementById('shop-panel').addEventListener('click', (e) => {
      const item = e.target.closest('.shop-item');
      if (!item || item.getAttribute('aria-disabled') === 'true') return;
      const which = item.dataset.item;
      if (which === 'coinMul' || which === 'clickMul' || which === 'autoLevel') return buyLeveled(which, item);
      if (which === 'leaderboardAuto') return buyOneShot(item);
      if (which === 'buffCoins')    return buyBuff('coins',    item);
      if (which === 'buffClicks')   return buyBuff('clicks',   item);
      if (which === 'buffAutoRate') return buyBuff('autoRate', item);
      if (which === 'prestige')     return doPrestige(item);
    });
    // ----------------------------------------------------------------------------

    // --- Auto-clicker -----------------------------------------------------------
    let autoTimer = null;
    let autoCoinFloaterInterval = null;
    let autoCoinAccumulator = 0;
    const AUTO_PERIOD_MS_FLOOR = 80;     // never tick faster than 12.5/s
    const AUTO_COIN_FLOATER_MS = 1000;   // spawn the gold +X once per second
    // Music-game perf mode (set further down): while a rhythm panel owns the CPU we
    // stop the live auto-click timer and instead accrue idle income lazily, crediting
    // the whole elapsed span in one batch. Declared here so rearmAutoLoop can read it.
    let musicModeOn = false, musicIdleStart = 0, musicIdlePeriodMs = 0;

    function currentAutoCps() {
      if (settings.autoClicker === false) return 0;   // user disabled the auto-clicker in settings
      return shopMul(Date.now()).autoCps;   // 0 if autoLevel === 0 and no autoRate buff
    }

    function pokeAutoCursor() {
      const el = document.getElementById('auto-cursor');
      if (!el) return;
      el.removeAttribute('data-poking');
      // Force reflow so the next setAttribute re-runs the animation from frame 0.
      // eslint-disable-next-line no-unused-expressions
      void el.offsetHeight;
      el.setAttribute('data-poking', 'true');
    }

    function spawnAutoCoinFloater(amount) {
      const cursor = document.getElementById('auto-cursor');
      if (!cursor) return;
      const rect = cursor.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'auto-coin-plus';
      el.textContent = '+' + amount.toLocaleString();
      // Anchor above the cursor; small horizontal jitter so back-to-back spawns
      // don't perfectly overlap if the floater interval ever overlaps animation.
      el.style.left = (rect.left + rect.width / 2 - 20 + (Math.random() * 12 - 6)) + 'px';
      el.style.top  = (rect.top - 8) + 'px';
      document.body.appendChild(el);
      animate(el, {
        translateY: -72,
        opacity: [{ to: 1, duration: 80 }, { to: 1, duration: 700 }, { to: 0, duration: 420 }],
        duration: 1200,
        ease: 'outQuad',
        onComplete: () => el.remove(),
      });
    }

    function autoTick() {
      if (introActive) return;
      // Capture the coin gain BEFORE recordClick mutates pending — same formula
      // recordClick uses, so the +X matches what actually got credited.
      autoCoinAccumulator += Math.floor(shopMul(Date.now()).coin);
      recordClick('auto');
      pokeAutoCursor();
    }

    function startAutoCoinFloater() {
      if (autoCoinFloaterInterval) return;
      autoCoinFloaterInterval = setInterval(() => {
        if (autoCoinAccumulator > 0) {
          spawnAutoCoinFloater(autoCoinAccumulator);
          autoCoinAccumulator = 0;
        }
      }, AUTO_COIN_FLOATER_MS);
    }

    function stopAutoCoinFloater() {
      if (autoCoinFloaterInterval) {
        clearInterval(autoCoinFloaterInterval);
        autoCoinFloaterInterval = null;
      }
      autoCoinAccumulator = 0;
    }

    function rearmAutoLoop() {
      // Music mode runs idle income lazily (no per-tick timer); never arm it here —
      // setMusicMode(false) flips musicModeOn off first, then calls us to resume.
      if (musicModeOn) { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } return; }
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      const el = document.getElementById('auto-cursor');
      if (!el) return;
      const cps = currentAutoCps();
      el.hidden = (cps <= 0);
      if (cps <= 0) {
        stopAutoCoinFloater();
        return;
      }
      const periodMs = Math.max(AUTO_PERIOD_MS_FLOOR, 1000 / cps);
      autoTimer = setInterval(autoTick, periodMs);
      startAutoCoinFloater();
    }

    // Re-check on tab visibility resume — buffs may have expired while hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (typeof syncBuffTimers === 'function') syncBuffTimers();
        // In music mode, don't count time the tab was hidden toward idle income
        // (matches the live auto-clicker, which is throttled while hidden).
        if (musicModeOn) musicIdleStart = performance.now();
        rearmAutoLoop();   // no-op while music mode owns the CPU (guarded above)
      } else if (musicModeOn) {
        bankMusicIdle();   // bank what's accrued before a possible close/refresh
      }
    });
    // ----------------------------------------------------------------------------

    // --- Buff expiry timers + countdown rendering -------------------------------
    const buffExpiryTimers = { coins: null, clicks: null, autoRate: null };
    let buffCountdownInterval = null;

    function anyBuffActive() {
      const now = Date.now();
      const b = (userShop && userShop.buffs) || {};
      for (const k of ['coins','clicks','autoRate']) {
        if (((b[k] && b[k].expiresAt) || 0) > now) return true;
      }
      return false;
    }

    function syncBuffTimers() {
      const now = Date.now();
      const b = (userShop && userShop.buffs) || {};
      for (const kind of ['coins','clicks','autoRate']) {
        if (buffExpiryTimers[kind]) { clearTimeout(buffExpiryTimers[kind]); buffExpiryTimers[kind] = null; }
        const exp = (b[kind] && b[kind].expiresAt) || 0;
        if (exp > now) {
          buffExpiryTimers[kind] = setTimeout(() => {
            // autoCps may change when 'autoRate' expires; coin/click muls are
            // read fresh on each click so they don't need a re-arm. Re-render
            // the panel for fresh labels regardless.
            rearmAutoLoop();
            renderShopPanel();
            if (!anyBuffActive() && buffCountdownInterval) {
              clearInterval(buffCountdownInterval);
              buffCountdownInterval = null;
            }
          }, exp - now + 50);
        }
      }
      if (anyBuffActive() && !buffCountdownInterval) {
        buffCountdownInterval = setInterval(() => {
          if (document.getElementById('shop-panel').classList.contains('open')) {
            renderShopPanel();
          }
        }, 1000);
      } else if (!anyBuffActive() && buffCountdownInterval) {
        clearInterval(buffCountdownInterval);
        buffCountdownInterval = null;
      }
    }
    // ----------------------------------------------------------------------------
    // Same optimistic-UI pattern as the public counters. After the shop split,
    // coin and click flows are independent (different multipliers, different
    // sources). Bar reads:
    //   clicks = userStats.totalClicks + pending.userClicks + inFlightUserClicks
    //   coins  = userStats.coinBalance + pending.userCoins  + inFlightUserCoins
    // pending.userCoins can be negative (shop debits); inFlightUserCoins too.
    let inFlightUserCoins  = 0;
    let inFlightUserClicks = 0;

    function flagFromCountry(code) {
      if (!code || code.length !== 2) return '';
      return code.toUpperCase().replace(/./g, c =>
        String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
      );
    }

    function renderSenseiBar() {
      // Optimistic: include both pending (not flushed yet) and inFlight
      // (sent in a batch, not yet visible to the listener) so the bar ticks
      // up the instant you click and stays steady across the flush hand-off.
      const pendingCoins  = (typeof pending !== 'undefined' && pending) ? (pending.userCoins  || 0) : 0;
      const pendingClicks = (typeof pending !== 'undefined' && pending) ? (pending.userClicks || 0) : 0;
      const clicks = (userStats.totalClicks || 0) + pendingClicks + inFlightUserClicks;
      const coins  = (userStats.coinBalance || 0) + pendingCoins  + inFlightUserCoins;
      const typingWords = (userStats.typingWords || 0) + ((typeof pending !== 'undefined' && pending) ? (pending.typingWords || 0) : 0);
      const xp = progressXp(clicks, typingWords);   // clicks + typing
      const lv = levelOf(xp);
      const cur = clicksInLevel(xp);
      const need = clicksToNextLevel(xp);
      senseiLevelEl.textContent = 'Lv.' + lv;
      senseiXpFillEl.style.width = (need > 0 ? Math.min(100, cur / need * 100) : 0) + '%';
      senseiXpTextEl.textContent = cur.toLocaleString() + ' / ' + need.toLocaleString();
      senseiCoinsEl.textContent = coins.toLocaleString();
      const stars = (userStats && userStats.prestigeStars) || 0;
      senseiPrestigeEl.hidden = stars <= 0;
      if (stars > 0) senseiPrestigeEl.textContent = '★' + stars;

      const welcomeName = document.getElementById('lobby-welcome-name');
      if (welcomeName) welcomeName.textContent = I18N.t('lobby.welcome_name',
        { name: userProfile?.displayName || I18N.t('lobby.sensei') });
      if (userProfile) {
        senseiNameEl.textContent = userProfile.displayName || I18N.t('sensei.trainer');
        senseiFlagEl.textContent = flagFromCountry(userProfile.country);
        if (userProfile.photoURL && senseiAvatarEl.tagName !== 'IMG') {
          const img = document.createElement('img');
          img.className = 'sensei-avatar';
          img.id = 'sensei-avatar';
          img.src = activityImg(userProfile.photoURL);
          img.alt = '';
          senseiAvatarEl.replaceWith(img);
          senseiAvatarEl = img;
        } else if (userProfile.photoURL && senseiAvatarEl.tagName === 'IMG') {
          senseiAvatarEl.src = activityImg(userProfile.photoURL);
        }
      } else {
        senseiNameEl.textContent = I18N.t('sensei.trainer');
        senseiFlagEl.textContent = '';
        // Revert avatar to placeholder div if previously an img
        if (senseiAvatarEl.tagName === 'IMG') {
          const div = document.createElement('div');
          div.className = 'sensei-avatar';
          div.id = 'sensei-avatar';
          div.textContent = '?';
          senseiAvatarEl.replaceWith(div);
          senseiAvatarEl = div;
        }
      }
    }

    function subscribeUserData(uid) {
      if (userStatsUnsub)   { userStatsUnsub();   userStatsUnsub = null; }
      if (userProfileUnsub) { userProfileUnsub(); userProfileUnsub = null; }
      if (userShopUnsub)    { userShopUnsub();    userShopUnsub = null; }
      if (!uid) {
        // Guest mode: hydrate stats/shop from localStorage.
        const local = loadLocalUserData();
        userStats   = Object.assign({ totalClicks: 0, coinBalance: 0 }, local.stats);
        if (!userStats.fishdex) userStats.fishdex = {};
        if (!Array.isArray(userStats.aquariumSpecimens)) userStats.aquariumSpecimens = [];
        userProfile = null;
        userShop    = local.shop || {};
        renderSenseiBar();
        if (typeof renderShopPanel === 'function') renderShopPanel();
        if (typeof syncBuffTimers  === 'function') syncBuffTimers();
        if (typeof rearmAutoLoop   === 'function') rearmAutoLoop();
        return;
      }

      const statsRef = db.ref('users/' + uid + '/stats');
      const statsCb  = (snap) => {
        const next = snap.val() || { totalClicks: 0, coinBalance: 0 };
        // Release positive clicks the same way as before.
        if (inFlightUserClicks > 0 && (next.totalClicks || 0) >= (userStats.totalClicks || 0) + inFlightUserClicks) {
          inFlightUserClicks = 0;
        }
        // Coins can go either direction (shop debits are negative deltas). Use a
        // sign-aware progress check so a -100 debit is "released" by a -100 server delta.
        if (inFlightUserCoins !== 0) {
          const coinDelta = (next.coinBalance || 0) - (userStats.coinBalance || 0);
          if (Math.sign(coinDelta) === Math.sign(inFlightUserCoins)
              && Math.abs(coinDelta) >= Math.abs(inFlightUserCoins)) {
            inFlightUserCoins = 0;
          }
        }
        userStats = next;
        if (!userStats.fishdex) userStats.fishdex = {};
        if (!Array.isArray(userStats.aquariumSpecimens)) userStats.aquariumSpecimens = [];
        renderSenseiBar();
        if (typeof updateVariantLevels === 'function') updateVariantLevels();
        if (typeof renderSkinBar       === 'function') renderSkinBar();
        if (typeof renderShopPanel === 'function') renderShopPanel();
        // Mirror to leaderboard if linked — keeps the board row in sync with
        // each totalClicks bump. Anonymous users never have a profile node so
        // the leaderboard rule's `profile.exists()` check would block this.
        if (currentUser && !currentUser.isAnonymous && userProfile) {
          // .update() (not .set) so the admin-set `hidden` flag survives
          // the next click sync. `level` is intentionally not written —
          // it's computed from totalClicks at render time so a spoofer
          // can't lie about it.
          db.ref('leaderboard/topClicks/' + uid).update({
            name:        userProfile.displayName || I18N.t('sensei.trainer'),
            country:     userProfile.country || 'XX',
            photoURL:    lbPhoto(userProfile),
            totalClicks: userStats.totalClicks || 0,
            typingWords: userStats.typingWords || 0,   // for the combined level (rank stays totalClicks)
            prestigeStars: userStats.prestigeStars || 0,
          }).catch(() => {});
          // Typing boards — same profile-gated mirror. Words board tracks all
          // typed words; WPM/Score boards track the user's single best ranked run
          // per mode. `level` (clicks+typing, computed at render on the clicker
          // board but stored here so the typing rows can show a badge) rides along.
          const nowTs   = Date.now();
          const lbLevel = levelOf(progressXp(userStats.totalClicks || 0, userStats.typingWords || 0));
          const lbName  = userProfile.displayName || I18N.t('sensei.trainer');
          const lbCty   = userProfile.country || 'XX';
          const typingWords = userStats.typingWords || 0;
          if (typingWords > 0) {
            db.ref('leaderboard/typingWords/' + uid).update({
              name:        lbName,
              country:     lbCty,
              photoURL:    lbPhoto(userProfile),
              typingWords: typingWords,
              level:       lbLevel,
            }).catch(() => {});
          }
          // Per-mode WPM/Score boards (15s/30s/60s are ranked separately — fair).
          // Transaction (not update) so wpmAt/scoreAt is stamped only the moment a
          // NEW best lands and the original date survives later profile-only syncs.
          const VALID_BMODES = { s15: 1, s30: 1, s60: 1 };
          const mirrorRecord = (kind, md, val) => {
            const ref   = db.ref('leaderboard/typing' + (kind === 'wpm' ? 'Wpm' : 'Score') + '/' + md + '/' + uid);
            const atKey = kind === 'wpm' ? 'wpmAt' : 'scoreAt';
            ref.transaction((cur) => {
              const prev = (cur && cur[kind]) || 0;
              const out  = { name: lbName, country: lbCty, photoURL: lbPhoto(userProfile), level: lbLevel };
              out[kind]  = Math.max(prev, val);            // never regress a higher server best
              out[atKey] = (val > prev) ? nowTs : ((cur && cur[atKey]) || nowTs);
              if (cur && cur.hidden === true) out.hidden = true;   // preserve admin hide
              return out;
            }).catch(() => {});
          };
          const bestWpmMap = userStats.typingBestWpm || {};
          for (const md in bestWpmMap) {
            if (bestWpmMap[md] > 0 && VALID_BMODES[md]) mirrorRecord('wpm', md, bestWpmMap[md]);
          }
          const bestScoreMap = userStats.typingBestScore || {};
          for (const md in bestScoreMap) {
            if (bestScoreMap[md] > 0 && VALID_BMODES[md]) mirrorRecord('score', md, bestScoreMap[md]);
          }
        }
      };
      statsRef.on('value', statsCb);
      userStatsUnsub = () => statsRef.off('value', statsCb);

      const profRef = db.ref('users/' + uid + '/profile');
      const profCb  = (snap) => {
        userProfile = snap.val();
        renderSenseiBar();
        // Keep the country area display in sync when the server pushes a new
        // value (admin-edited, multi-tab edit, or first-link write).
        if (typeof renderCountryArea === 'function' && !profilePanel.contains(document.activeElement)) {
          renderCountryArea();
        }
        if (typeof renderPhotoPicker === 'function') renderPhotoPicker();
        // Activity only: persist Discord identity + start the presence panel once
        // the profile is available (both are no-ops on the normal web / when re-run).
        if (typeof maybeInitActivityPresence === 'function') maybeInitActivityPresence();
      };
      profRef.on('value', profCb);
      userProfileUnsub = () => profRef.off('value', profCb);

      const shopRef = db.ref('users/' + uid + '/shop');
      const shopCb  = (snap) => {
        userShop = snap.val() || {};
        if (typeof renderShopPanel === 'function') renderShopPanel();
        if (typeof syncBuffTimers === 'function')  syncBuffTimers();
        if (typeof rearmAutoLoop === 'function')   rearmAutoLoop();
      };
      shopRef.on('value', shopCb);
      userShopUnsub = () => shopRef.off('value', shopCb);
    }

    auth.onAuthStateChanged(async (user) => {
      subscribeUserData(user && !user.isAnonymous ? user.uid : null);
      // Drive profile init + photoURL reconciliation here, not (only) from the
      // signInWithPopup() handler. Cross-Origin-Opener-Policy on some browsers
      // blocks Firebase's popup-close polling, so signInWithPopup()'s promise
      // never resolves and the `await initProfileFromCredential(...)` inside
      // the popup handler never runs — leaving stale/empty photoURLs forever.
      // The auth-state listener fires reliably via Firebase's internal event
      // bus regardless of popup window state, and initProfileFromCredential
      // is idempotent (existence check + non-empty/diff guard on photoURL).
      const isGoogleLinked = !!(user
        && !user.isAnonymous
        && user.providerData.some(p => p && p.providerId === 'google.com'));
      if (isGoogleLinked) {
        try { await initProfileFromCredential(null); } catch {}
      }
    });

    renderSenseiBar();
    renderShopPanel();

    // --- Profile panel toggle ---
    const senseiBar         = document.getElementById('sensei-bar');
    const profilePanel      = document.getElementById('profile-panel');
    const profileAnonView   = document.getElementById('profile-anon');
    const profileLinkedView = document.getElementById('profile-linked');

    function updateProfileView() {
      const linked = !!(currentUser && !currentUser.isAnonymous);
      profileAnonView.hidden   = linked;
      profileLinkedView.hidden = !linked;
    }

    senseiBar.addEventListener('click', (e) => {
      e.stopPropagation();
      // Intercept the bond heart so clicking it doesn't open the profile panel.
      const bondBtn = e.target.closest('.skin-bar-bond');
      if (bondBtn && !bondBtn.hidden) {
        doBond(bondBtn.dataset.bondVariant);
        return;
      }
      updateProfileView();
      profilePanel.classList.toggle('open');
    });
    profilePanel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => {
      if (e.target.closest('#app-modal,.merge-overlay,#update-modal')) return;
      if (!profilePanel.contains(e.target) && e.target !== senseiBar && !senseiBar.contains(e.target)) {
        profilePanel.classList.remove('open');
      }
    });
    auth.onAuthStateChanged(() => { updateProfileView(); refreshLinkUi(); });

    // --- Leaderboard modal ---
    const leaderboardBtn      = document.getElementById('leaderboard-btn');
    const leaderboardModal    = document.getElementById('leaderboard-modal');
    const leaderboardCloseBtn = document.getElementById('leaderboard-close');
    const leaderboardList     = document.getElementById('leaderboard-list');
    const leaderboardYourRank = document.getElementById('leaderboard-yourrank');
    const leaderboardSignin   = document.getElementById('leaderboard-signin');
    let leaderboardUnsub = null;

    const lbScopeEl   = document.getElementById('lb-scope');
    const lbClickerEl = document.getElementById('lb-clicker');
    const lbTypingEl  = document.getElementById('lb-typing');
    function setLeaderboardScope(scope) {
      const s = (scope === 'typing') ? 'typing' : 'clicker';
      if (lbScopeEl) lbScopeEl.querySelectorAll('button[data-scope]').forEach((b) =>
        b.classList.toggle('sel', b.getAttribute('data-scope') === s));
      if (lbClickerEl) lbClickerEl.hidden = (s !== 'clicker');
      if (lbTypingEl)  lbTypingEl.hidden  = (s !== 'typing');
      if (s === 'clicker') {
        loadLeaderboard();
      } else {
        if (leaderboardUnsub) { leaderboardUnsub(); leaderboardUnsub = null; } // stop the clicks listener
        if (window.TypingGame && window.TypingGame.loadBoard) window.TypingGame.loadBoard('words');
      }
    }
    function openLeaderboard(scope) {
      leaderboardModal.classList.add('open');
      leaderboardModal.setAttribute('aria-hidden', 'false');
      setLeaderboardScope(scope || 'clicker');
    }
    function closeLeaderboard() {
      leaderboardModal.classList.remove('open');
      leaderboardModal.setAttribute('aria-hidden', 'true');
      if (leaderboardUnsub) { leaderboardUnsub(); leaderboardUnsub = null; }
    }

    leaderboardBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (leaderboardModal.classList.contains('open')) closeLeaderboard();
      else openLeaderboard();
    });
    leaderboardCloseBtn.addEventListener('click', closeLeaderboard);
    leaderboardModal.addEventListener('click', (e) => { if (e.target === leaderboardModal) closeLeaderboard(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && leaderboardModal.classList.contains('open')) closeLeaderboard();
    });
    leaderboardSignin.addEventListener('click', () => {
      closeLeaderboard();
      senseiBar.click();
    });
    if (lbScopeEl) lbScopeEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-scope]');
      if (b) setLeaderboardScope(b.getAttribute('data-scope'));
    });

    // Admin hide-toggle: event delegation on the list since rows are re-rendered.
    // The action is non-destructive — sets `hidden: true|false`. Hidden rows are
    // filtered out of the public list but shown muted to admins for review.
    leaderboardList.addEventListener('click', async (e) => {
      const btn = e.target.closest('.lb-admin-del');
      if (!btn) return;
      e.stopPropagation();
      if (!isAdmin() || !settings.adminMode) return;
      const uid = btn.dataset.delUid;
      const nextHidden = btn.dataset.hidden !== 'true';  // toggle
      try {
        await db.ref('leaderboard/topClicks/' + uid).update({ hidden: nextHidden });
      } catch (err) {
        showAlert(I18N.t('admin.banner').slice(0, 20), 'Hide toggle failed: ' + (err.message || err.code || 'unknown'));
      }
    });

    function loadLeaderboard() {
      leaderboardList.innerHTML = '';
      leaderboardYourRank.textContent = '';
      leaderboardSignin.hidden = !!(currentUser && !currentUser.isAnonymous);

      const adminActive = isAdmin() && settings.adminMode;

      const q = db.ref('leaderboard/topClicks').orderByChild('totalClicks').limitToLast(100);
      const cb = (snap) => {
        const rows = [];
        snap.forEach(child => { rows.push({ uid: child.key, ...child.val() }); });
        rows.sort((a, b) => (b.totalClicks || 0) - (a.totalClicks || 0));

        // Non-admins never see hidden rows. Admins see them muted so they
        // can unhide. Ranking renumbers 1..N for whatever the viewer sees.
        const visibleRows = adminActive ? rows : rows.filter(r => r.hidden !== true);

        const adminBanner = adminActive
          ? `<div class="lb-admin-banner">${I18N.t('admin.banner')}</div>`
          : '';

        leaderboardList.innerHTML = adminBanner + visibleRows.map((r, i) => {
          const isMe = currentUser && r.uid === currentUser.uid;
          const flag = flagFromCountry(r.country);
          const isHidden = r.hidden === true;
          const avatar = r.photoURL
            ? `<img class="lb-avatar" src="${activityImg(r.photoURL)}" alt="">`
            : `<div class="lb-avatar" style="display:flex;align-items:center;justify-content:center;color:var(--ba-accent-strong);font-weight:800;">${escapeHtml((r.name || '?').slice(0,1))}</div>`;
          const adminCol = adminActive
            ? `<button class="lb-admin-del" data-del-uid="${escapeHtml(r.uid)}" data-del-name="${escapeHtml(r.name || '')}" data-hidden="${isHidden}" title="${I18N.t(isHidden ? 'admin.show_row' : 'admin.hide_row')}">${isHidden ? '↺' : '×'}</button>`
            : '';
          return `<div class="lb-row${isMe ? ' me' : ''}${adminActive ? ' admin' : ''}${isHidden ? ' hidden-row' : ''}">
            <span class="lb-rank">#${i + 1}</span>
            ${avatar}
            <span class="lb-flag">${flag}</span>
            <span class="lb-name">${escapeHtml(r.name || I18N.t('sensei.trainer'))}</span>
            <span class="lb-level">Lv.${levelOf(progressXp(r.totalClicks, r.typingWords))}${(r.prestigeStars || 0) > 0 ? ` <span class="lb-stars">★${r.prestigeStars}</span>` : ''}</span>
            <span class="lb-clicks">${(r.totalClicks || 0).toLocaleString()}</span>
            ${adminCol}
          </div>`;
        }).join('');

        if (currentUser && !currentUser.isAnonymous) {
          // If the viewer's own row is admin-hidden, they don't get a rank
          // (matches what other players see).
          const meEntry = rows.find(r => r.uid === currentUser.uid);
          const meIsHidden = !!(meEntry && meEntry.hidden === true);
          const myRow = visibleRows.findIndex(r => r.uid === currentUser.uid);
          if (myRow >= 0) {
            leaderboardYourRank.textContent = I18N.t('leaderboard.your_rank', { rank: myRow + 1, total: visibleRows.length });
          } else if (meIsHidden) {
            leaderboardYourRank.textContent = '';
          } else if ((userStats.totalClicks || 0) > 0) {
            countMyRank().then(rank => {
              leaderboardYourRank.textContent = I18N.t('leaderboard.your_rank_outside', { rank });
            });
          } else {
            leaderboardYourRank.textContent = I18N.t('leaderboard.no_rank_yet');
          }
        }
      };
      q.on('value', cb);
      leaderboardUnsub = () => q.off('value', cb);
    }

    async function countMyRank() {
      const myClicks = userStats.totalClicks || 0;
      const snap = await db.ref('leaderboard/topClicks').orderByChild('totalClicks').startAfter(myClicks).once('value');
      return snap.numChildren() + 1;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    // --- Google sign-in / linking -----------------------------------------------
    const profileGoogleBtn = document.getElementById('profile-google-btn');
    const profileError     = document.getElementById('profile-error');

    profileGoogleBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      profileError.textContent = '';
      const provider = new firebase.auth.GoogleAuthProvider();
      // Default scope set already includes `profile`, but state it explicitly
      // so a future Firebase change can't silently drop the claim that
      // delivers displayName / photoURL.
      provider.addScope('profile');
      provider.addScope('email');
      try {
        const cred = await auth.signInWithPopup(provider);
        await initProfileFromCredential(cred);
        profilePanel.classList.remove('open');
      } catch (err) {
        if (err.code === 'auth/popup-closed-by-user') {
          // Silent
        } else {
          profileError.textContent = err.message || 'Sign-in failed.';
        }
      }
    });

    // --- Discord account linking -------------------------------------------------
    // showLinkToast: minimal ephemeral status message for link/merge outcomes.
    const _linkToastEl = document.getElementById('link-toast');
    let _linkToastTimer = null;
    function showLinkToast(msg) {
      _linkToastEl.textContent = msg;
      _linkToastEl.classList.add('visible');
      if (_linkToastTimer) clearTimeout(_linkToastTimer);
      _linkToastTimer = setTimeout(() => _linkToastEl.classList.remove('visible'), 3000);
    }

    async function linkDiscord() {
      const user = auth.currentUser;
      if (!user || user.isAnonymous) return;
      let idToken;
      try { idToken = await user.getIdToken(); } catch { return; }
      let authorizeUrl;
      try {
        const resp = await fetch(KEI_BASE + '/api/link/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken })
        });
        if (!resp.ok) throw new Error('start failed');
        ({ authorizeUrl } = await resp.json());
      } catch (e) { console.error('link start failed', e); return; }
      window.open(authorizeUrl, 'discord-link', 'width=500,height=820');
    }

    async function refreshLinkUi() {
      const linkBtn   = document.getElementById('profile-discord-btn');
      const unlinkBtn = document.getElementById('profile-discord-unlink-btn');
      const user = auth.currentUser;
      if (!user || user.isAnonymous) {
        if (linkBtn)   linkBtn.style.display   = 'none';
        if (unlinkBtn) unlinkBtn.style.display = 'none';
        return;
      }
      const isGoogle = (user.providerData || []).some(p => p && p.providerId === 'google.com');
      let linked = false;
      try {
        const idToken = await user.getIdToken();
        const r = await fetch(KEI_BASE + '/api/link/status', { headers: { 'Authorization': 'Bearer ' + idToken } });
        if (r.ok) ({ linked } = await r.json());
      } catch (e) { console.error('link status failed', e); }
      if (linkBtn)   linkBtn.style.display   = (!linked && isGoogle) ? '' : 'none';
      if (unlinkBtn) unlinkBtn.style.display = linked ? '' : 'none';
      // Feed the picker: a linked user can choose their Discord photo (shown as a
      // placeholder until the Activity captures it).
      discordLinked = linked;
      if (typeof renderPhotoPicker === 'function') renderPhotoPicker();
    }

    async function unlinkDiscord() {
      const user = auth.currentUser;
      if (!user) return;
      if (!confirm('Unlink your Discord account? Your progress stays on this (Google) account.')) return;
      try {
        const idToken = await user.getIdToken();
        const r = await fetch(KEI_BASE + '/api/link/unlink', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
        });
        if (!r.ok) throw new Error('unlink failed');
        showLinkToast('Discord unlinked');
        await refreshLinkUi();
      } catch (e) { console.error('unlink failed', e); showLinkToast('Unlink failed, try again'); }
    }

    async function discordLogin() {
      let authorizeUrl;
      try {
        const resp = await fetch(KEI_BASE + '/api/web/discord/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (!resp.ok) throw new Error('start failed');
        ({ authorizeUrl } = await resp.json());
      } catch (e) { console.error('discord login start failed', e); return; }
      window.open(authorizeUrl, 'discord-login', 'width=500,height=820');
    }

    async function ensureDiscordProfile(uid, displayName, photoURL) {
      try {
        const ref = db.ref('users/' + uid + '/profile');
        const snap = await ref.once('value');
        if (snap.exists()) return;
        await ref.set({
          displayName: (displayName || 'Sensei').slice(0, 24),
          photoURL:    photoURL || '',
          country:     (typeof visitorCountry !== 'undefined' && visitorCountry) ? visitorCountry : 'XX',
          provider:    'discord',
          linkedAt:    firebase.database.ServerValue.TIMESTAMP,
        });
      } catch (e) { console.error('ensureDiscordProfile failed', e); }
    }

    window.addEventListener('message', async (e) => {
      if (e.origin !== KEI_BASE) return;
      const d = e.data;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'discord-auth') {
        try {
          await auth.signInWithCustomToken(d.customToken);
          await ensureDiscordProfile(d.uid, d.displayName, d.photoURL);
        } catch (err) { console.error('discord sign-in failed', err); showLinkToast('Discord sign-in failed'); }
        return;
      }
      if (d.type === 'discord-link') {
        if (d.needsMerge) { showMergePicker(d.discordId); } else { showLinkToast('Discord linked!'); await refreshLinkUi(); }
        return;
      }
    });

    async function showMergePicker(discordId) {
      const user = auth.currentUser;
      if (!user) return;
      let data;
      try {
        const idToken = await user.getIdToken();
        const r = await fetch(KEI_BASE + '/api/link/compare?discord_id=' + encodeURIComponent(discordId), {
          headers: { 'Authorization': 'Bearer ' + idToken }
        });
        if (!r.ok) throw new Error('compare failed');
        data = await r.json();
      } catch (e) { console.error('compare failed', e); return; }
      renderMergeModal(discordId, data.google, data.discord);
    }

    function mergeCardHtml(side, s) {
      return '<div class="merge-card" data-keep="' + side + '">'
        + '<h4>' + (side === 'google' ? 'This account' : 'Discord account') + '</h4>'
        + '<p>Level ' + s.level + '</p>'
        + '<p>' + s.totalClicks.toLocaleString() + ' clicks</p>'
        + '<p>' + s.prestigeStars + ' ★ prestige</p>'
        + '<p>' + s.coinBalance.toLocaleString() + ' coins</p>'
        + '<p>' + s.charactersOwned + ' characters</p>'
        + '<button class="merge-pick" data-keep="' + side + '">Keep this</button></div>';
    }

    function renderMergeModal(discordId, google, discord) {
      const overlay = document.createElement('div');
      overlay.className = 'merge-overlay';
      overlay.innerHTML = '<div class="merge-modal"><h3>Two save files found — keep which?</h3>'
        + '<div class="merge-cards">' + mergeCardHtml('google', google) + mergeCardHtml('discord', discord) + '</div></div>';
      document.body.appendChild(overlay);
      overlay.querySelectorAll('.merge-pick').forEach(btn => {
        btn.addEventListener('click', async () => {
          overlay.querySelectorAll('.merge-pick').forEach(b => b.disabled = true);
          await resolveMerge(discordId, btn.getAttribute('data-keep'));
          overlay.remove();
        });
      });
    }

    async function resolveMerge(discordId, keep) {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        const r = await fetch(KEI_BASE + '/api/link/resolve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordId, keep, idToken })
        });
        if (!r.ok) throw new Error('resolve failed');
        showLinkToast('Merged! Reloading…');
        setTimeout(() => location.reload(), 800);
      } catch (e) { console.error('resolve failed', e); showLinkToast('Merge failed, try again'); }
    }

    // --- Profile editor (linked) ------------------------------------------------
    const profileNameInput   = document.getElementById('profile-name-input');
    // `var` so a Firebase auth callback that fires before this line is reached
    // (cached session restored synchronously, etc.) doesn't TDZ-throw on the
    // hoisted reference inside renderCountryArea. The function early-returns
    // when the binding is still undefined.
    var profileCountryArea = document.getElementById('profile-country-area');
    const profileSaveBtn     = document.getElementById('profile-save-btn');
    const profileSignoutBtn  = document.getElementById('profile-signout-btn');
    const profileErrLinked   = document.getElementById('profile-error-linked');

    // All ISO 3166-1 alpha-2 country codes — used by the admin-mode dropdown.
    const COUNTRY_CODES = ['AF','AL','DZ','AS','AD','AO','AI','AQ','AG','AR','AM','AW','AU','AT','AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BM','BT','BO','BA','BW','BR','IO','BN','BG','BF','BI','CV','KH','CM','CA','KY','CF','TD','CL','CN','CO','KM','CG','CD','CK','CR','CI','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','ET','FK','FO','FJ','FI','FR','GF','PF','GA','GM','GE','DE','GH','GI','GR','GL','GD','GP','GU','GT','GG','GN','GW','GY','HT','HN','HK','HU','IS','IN','ID','IR','IQ','IE','IM','IL','IT','JM','JP','JE','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MO','MG','MW','MY','MV','ML','MT','MH','MQ','MR','MU','YT','MX','FM','MD','MC','MN','ME','MS','MA','MZ','MM','NA','NR','NP','NL','NC','NZ','NI','NE','NG','NU','NF','MK','MP','NO','OM','PK','PW','PS','PA','PG','PY','PE','PH','PN','PL','PT','PR','QA','RE','RO','RU','RW','BL','SH','KN','LC','MF','PM','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SX','SK','SI','SB','SO','ZA','SS','ES','LK','SD','SR','SZ','SE','CH','SY','TW','TJ','TZ','TH','TL','TG','TK','TO','TT','TN','TR','TM','TC','TV','UG','UA','AE','GB','US','UY','UZ','VU','VE','VN','VG','VI','YE','ZM','ZW'];

    function renderCountryArea() {
      if (!profileCountryArea) return;  // called before DOM-bound binding ready
      profileCountryArea.innerHTML = '';
      const stored = (userProfile && userProfile.country) || visitorCountry || 'XX';
      const showAdminPicker = isAdmin() && settings.adminMode;

      if (showAdminPicker) {
        // Admin: full dropdown, picks any country. Save button commits it.
        const sel = document.createElement('select');
        sel.id = 'profile-country-select';
        sel.className = 'profile-select';
        sel.innerHTML = COUNTRY_CODES.map(code => {
          const flag = code.replace(/./g, c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65));
          return `<option value="${code}"${code === stored ? ' selected' : ''}>${flag} ${code}</option>`;
        }).join('');
        profileCountryArea.appendChild(sel);
        return;
      }

      // Non-admin: read-only display. The country was set on first link from
      // ipapi.co detection and stays put. If detection now shows a different
      // country (e.g. user traveled), surface a one-click change button.
      const display = document.createElement('div');
      display.className = 'country-display';
      const flag = flagFromCountry(stored);
      display.innerHTML =
        `<span class="country-display-flag">${flag || '🏳'}</span>` +
        `<span>${escapeHtml(stored)}</span>`;
      profileCountryArea.appendChild(display);

      if (visitorCountry && visitorCountry.length === 2 && visitorCountry !== stored) {
        const btn = document.createElement('button');
        btn.className = 'country-change-btn';
        btn.type = 'button';
        const newFlag = flagFromCountry(visitorCountry);
        btn.textContent = I18N.t('profile.country_change_to', { flag: newFlag, code: visitorCountry });
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!currentUser) return;
          try {
            await db.ref('users/' + currentUser.uid + '/profile/country').set(visitorCountry);
            const lbRef = db.ref('leaderboard/topClicks/' + currentUser.uid);
            if ((await lbRef.once('value')).exists()) {
              await lbRef.update({ country: visitorCountry });
            }
            // userProfile listener will fire and re-render; explicit call so
            // the swap is instant.
            if (userProfile) userProfile.country = visitorCountry;
            renderCountryArea();
            renderSenseiBar();
          } catch (err) {
            profileErrLinked.textContent = err.message || 'Country update failed.';
          }
        });
        profileCountryArea.appendChild(btn);
      }
    }

    function syncProfileInputs() {
      if (!userProfile) return;
      profileNameInput.value = userProfile.displayName || '';
      renderCountryArea();
      if (typeof renderPhotoPicker === 'function') renderPhotoPicker();
    }
    senseiBar.addEventListener('click', syncProfileInputs);

    // Re-render the country area when admin mode flips so the dropdown
    // appears/disappears live.
    window.addEventListener('i18nchange', renderCountryArea);

    profileSaveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      profileErrLinked.textContent = '';
      const name = profileNameInput.value.trim();
      if (name.length < 1 || name.length > 24) {
        profileErrLinked.textContent = I18N.t('profile.name_length_error');
        return;
      }
      // Country only editable in admin mode (via dropdown); non-admins change
      // it through the inline "change to X" button instead.
      const adminSel = document.getElementById('profile-country-select');
      const adminCountry = (isAdmin() && settings.adminMode && adminSel) ? adminSel.value : null;

      const uid = currentUser.uid;
      try {
        const profileUpdate = { displayName: name };
        if (adminCountry) profileUpdate.country = adminCountry;
        await db.ref('users/' + uid + '/profile').update(profileUpdate);

        const lbRef = db.ref('leaderboard/topClicks/' + uid);
        const exists = (await lbRef.once('value')).exists();
        if (exists) {
          const lbUpdate = { name };
          if (adminCountry) lbUpdate.country = adminCountry;
          await lbRef.update(lbUpdate);
        }
        profilePanel.classList.remove('open');
      } catch (err) {
        profileErrLinked.textContent = err.message || 'Save failed.';
      }
    });

    profileSignoutBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await auth.signOut();
      profilePanel.classList.remove('open');
    });

    // --- Discord Activity presence + dual-identity leaderboard photo --------------
    // Which photo sources the user can choose between. provider==='google' means a
    // Google photo exists (profile.photoURL); a Discord photo exists once it's been
    // captured from the Activity (or the user is known-linked, shown as a placeholder).
    function identityState() {
      const p = userProfile || {};
      const A = window.__ACTIVITY__;
      return {
        hasGoogle: p.provider === 'google',
        hasDiscord: !!(p.discordPhotoURL || p.discordName || discordLinked || (A && (A.discordPhotoURL || A.discordName))),
      };
    }

    // Render the leaderboard-picture picker (google / discord / hidden). Only shown
    // when there's a real choice. The leaderboard NAME stays the custom display name.
    function renderPhotoPicker() {
      const section = document.getElementById('profile-photo-section');
      const wrap    = document.getElementById('profile-photo-options');
      if (!section || !wrap) return;
      if (!userProfile) { section.hidden = true; return; }
      const idg  = identityState();
      const opts = (window.PresenceEngine && window.PresenceEngine.photoOptionsFor)
        ? window.PresenceEngine.photoOptionsFor(idg) : ['none'];
      // A lone "Hidden" option isn't a meaningful choice — hide the whole section.
      if (opts.length < 2) { section.hidden = true; return; }
      section.hidden = false;
      const A = window.__ACTIVITY__;
      const cur    = (userProfile.leaderboardPhoto) || 'google';
      const active = opts.indexOf(cur) >= 0 ? cur : opts[0];
      const meta = {
        google:  { label: 'Google',  sub: userProfile.displayName || '', photo: userProfile.photoURL || '' },
        discord: { label: 'Discord', sub: userProfile.discordName || (A && A.discordName) || '',
                   photo: userProfile.discordPhotoURL || (A && A.discordPhotoURL) || '' },
        none:    { label: 'Hidden',  sub: '', photo: '' },
      };
      wrap.innerHTML = opts.map((o) => {
        const m  = meta[o] || meta.none;
        const av = m.photo
          ? `<img class="ppo-av" src="${activityImg(m.photo)}" alt="">`
          : `<div class="ppo-av ppo-av-ph">${o === 'none' ? '∅' : escapeHtml((m.sub || '?').slice(0, 1))}</div>`;
        return `<button type="button" class="profile-photo-opt${o === active ? ' selected' : ''}" data-photo="${o}">` +
          av + `<span class="ppo-label">${m.label}</span>` +
          (m.sub ? `<span class="ppo-sub">${escapeHtml(m.sub)}</span>` : '') +
          `</button>`;
      }).join('');
    }

    document.getElementById('profile-photo-options').addEventListener('click', async (e) => {
      const btn = e.target.closest('.profile-photo-opt');
      if (!btn) return;
      e.stopPropagation();
      const pref = btn.getAttribute('data-photo');
      if (!currentUser || !userProfile) return;
      try {
        await db.ref('users/' + currentUser.uid + '/profile/leaderboardPhoto').set(pref);
        userProfile.leaderboardPhoto = pref;
        renderPhotoPicker();
        // Push the resolved photo to every existing leaderboard row immediately so the
        // change shows without waiting for the next click flush.
        const photo = lbPhoto(userProfile);
        const uid = currentUser.uid;
        ['topClicks', 'typingWords', 'typingWpm'].forEach(async (board) => {
          const ref = db.ref('leaderboard/' + board + '/' + uid);
          if ((await ref.once('value')).exists()) ref.update({ photoURL: photo }).catch(() => {});
        });
      } catch (err) { console.error('set leaderboardPhoto failed', err); }
    });

    // One-time presence init for the Activity: persist the Discord identity into the
    // profile (so the web picker has it), then start the presence panel once the
    // profile is loaded and presence.js is available.
    let _presenceInited = false;
    async function maybeInitActivityPresence() {
      const A = window.__ACTIVITY__;
      if (!A || !currentUser || !userProfile) return;
      try {
        const upd = {};
        const dName  = A.discordName ? String(A.discordName).slice(0, 64) : '';
        const dPhoto = A.discordPhotoURL ? String(A.discordPhotoURL).slice(0, 500) : '';
        if (dName  && userProfile.discordName     !== dName)  upd.discordName     = dName;
        if (dPhoto && userProfile.discordPhotoURL !== dPhoto) upd.discordPhotoURL = dPhoto;
        if (Object.keys(upd).length) {
          await db.ref('users/' + currentUser.uid + '/profile').update(upd);
          Object.assign(userProfile, upd);
          renderPhotoPicker();
        }
      } catch (e) { console.error('persist discord identity failed', e); }
      // Presence panel needs a trusted Discord id (the merge key + the RTDB rule's
      // identity check). Without it, skip the panel entirely rather than publish a
      // blank-id node that would collide with other id-less nodes — graceful
      // degradation for an older kei-bot that doesn't return discordId yet.
      if (_presenceInited || !window.Presence || A.discordId == null) return;
      _presenceInited = true;
      window.Presence.init({
        db, activity: A, activityImg, escapeHtml,
        // Server-confirmed totalClicks (matches the leaderboard and stays within the
        // RTDB cap); sessionClicks is the local since-boot counter.
        getSelfState: () => ({
          name:          (userProfile && userProfile.displayName) || A.discordName || 'Sensei',
          photoURL:      lbPhoto(userProfile),
          totalClicks:   userStats.totalClicks || 0,
          sessionClicks: sessionClicks,
        }),
      });
    }

    // Max amount any single RTDB counter write may advance a value. The
    // database rules reject writes that bump a counter by more than +10000
    // (and require >=1s between totalClicks/bySource writes), so both the
    // first-sign-in migration and the live click flush chunk large backlogs
    // into <=RTDB_CHUNK pieces spaced >1s apart. One below the cap for margin.
    const RTDB_CHUNK = 9999;

    // --- Local → Firebase migration on first Google sign-in --------------------
    // Drains localStorage guest stats/shop into users/{uid}/* additively, then
    // clears local. Chunked at <=RTDB_CHUNK per stat to satisfy the +10k/+1s RTDB
    // throttle rule. Most guests have well under 10k local clicks so this is
    // a single-write no-op delay; heavy guests see a few seconds of catch-up.
    async function migrateLocalToFirebase(uid) {
      const local = loadLocalUserData();
      const stats = local.stats || {};
      const shop  = local.shop  || {};
      let remClicks = stats.totalClicks || 0;
      let remCoins  = Math.max(0, stats.coinBalance || 0);
      const remSkins = { ...(stats.skins    || {}) };
      const remBySrc = { ...(stats.bySource || {}) };

      const hasStatsRemaining = () =>
        remClicks > 0 || remCoins > 0
        || Object.values(remSkins).some(v => v > 0)
        || Object.values(remBySrc).some(v => v > 0);

      let firstChunk = true;
      while (hasStatsRemaining()) {
        if (!firstChunk) await new Promise(r => setTimeout(r, 1100));
        firstChunk = false;
        const update = {};
        const cClicks = Math.min(remClicks, RTDB_CHUNK);
        const cCoins  = Math.min(remCoins,  RTDB_CHUNK);
        let hasActivity = false;
        if (cClicks > 0) { update[`users/${uid}/stats/totalClicks`] = firebase.database.ServerValue.increment(cClicks); hasActivity = true; }
        if (cCoins  > 0) { update[`users/${uid}/stats/coinBalance`] = firebase.database.ServerValue.increment(cCoins); }
        const skinsConsumed = {};
        for (const k in remSkins) {
          const c = Math.min(remSkins[k], RTDB_CHUNK);
          if (c > 0) { update[`users/${uid}/stats/skins/${k}`] = firebase.database.ServerValue.increment(c); skinsConsumed[k] = c; }
        }
        const srcConsumed = {};
        for (const k in remBySrc) {
          const c = Math.min(remBySrc[k], RTDB_CHUNK);
          if (c > 0) { update[`users/${uid}/stats/bySource/${k}`] = firebase.database.ServerValue.increment(c); srcConsumed[k] = c; hasActivity = true; }
        }
        if (hasActivity) update[`users/${uid}/stats/lastClickAt`] = firebase.database.ServerValue.TIMESTAMP;
        if (Object.keys(update).length === 0) break;
        try {
          await db.ref().update(update);
        } catch (e) {
          console.error('Local→Firebase stat migration failed; remaining local stays for retry', e);
          return false;
        }
        remClicks -= cClicks;
        remCoins  -= cCoins;
        for (const k in skinsConsumed) remSkins[k] -= skinsConsumed[k];
        for (const k in srcConsumed)   remBySrc[k] -= srcConsumed[k];
      }

      // Shop: take max(local, server) per field. Single write, no throttle.
      if (Object.keys(shop).length > 0) {
        try {
          const existing = (await db.ref(`users/${uid}/shop`).once('value')).val() || {};
          const upd = {};
          for (const k of ['coinMulLevel','clickMulLevel','autoLevel']) {
            // Clamp to 20 — the RTDB rule's hard cap on shop levels.
            const v = Math.min(20, Math.max(shop[k] || 0, existing[k] || 0));
            if (v > (existing[k] || 0)) upd[k] = v;
          }
          if (shop.leaderboardAutoUnlocked && !existing.leaderboardAutoUnlocked) upd.leaderboardAutoUnlocked = true;
          for (const kind of ['coins','clicks','autoRate']) {
            const localExp  = (shop.buffs && shop.buffs[kind] && shop.buffs[kind].expiresAt) || 0;
            const serverExp = (existing.buffs && existing.buffs[kind] && existing.buffs[kind].expiresAt) || 0;
            const exp = Math.max(localExp, serverExp);
            if (exp > Date.now() && exp > serverExp) upd[`buffs/${kind}/expiresAt`] = exp;
          }
          if (Object.keys(upd).length > 0) await db.ref(`users/${uid}/shop`).update(upd);
        } catch (e) {
          console.error('Local→Firebase shop migration failed', e);
        }
      }

      // fishdex aggregate (additive count; max size; min float; OR shiny)
      const gFishdex = (stats.fishdex) || {};
      for (const sp in gFishdex) {
        const a = gFishdex[sp];
        if (a && a.count > 0) {
          const u = {};
          u[`users/${uid}/stats/fishdex/${sp}/count`] = firebase.database.ServerValue.increment(a.count);
          await db.ref().update(u);
          // maxSize/bestFloat/shinyCaught: read-modify-merge (small, one species at a time)
          const ref = db.ref(`users/${uid}/stats/fishdex/${sp}`);
          const snap = await ref.once('value');
          const cur = snap.val() || {};
          await ref.update({
            maxSize: Math.max(cur.maxSize || 0, a.maxSize || 0),
            bestFloat: Math.min(cur.bestFloat == null ? 1 : cur.bestFloat, a.bestFloat == null ? 1 : a.bestFloat),
            shinyCaught: !!(cur.shinyCaught || a.shinyCaught),
          });
        }
      }
      // specimens: append each guest instance under a fresh push id
      const gSpecimens = (stats.aquariumSpecimens) || [];
      for (const inst of gSpecimens) {
        await db.ref(`users/${uid}/aquarium/specimens`).push().set(inst);
      }

      clearLocalUserData();
      return true;
    }

    async function initProfileFromCredential(cred) {
      const u = auth.currentUser;
      if (!u) return;
      const existing = await db.ref('users/' + u.uid + '/profile').once('value');
      // Read from providerData first, NOT user.photoURL. Firebase copies the
      // IdP's photoUrl into user.photoURL only at account-creation time and
      // never refreshes it — so accounts created in a moment when Google
      // returned an empty photoUrl get locked into an empty avatar forever
      // even after the user later sets one. providerData reflects the latest
      // IdP response on every sign-in, so it's always the fresh value.
      const googleEntry = (u.providerData || []).find(p => p && p.providerId === 'google.com');
      const googlePhoto = (googleEntry && googleEntry.photoURL) || '';
      const livePhoto = (googlePhoto || u.photoURL || '').slice(0, 500);

      if (existing.exists()) {
        // Reconcile photoURL on every sign-in. Google occasionally returns an
        // empty photoURL on a user's first OAuth response (no avatar set yet,
        // restricted session, etc.) and the previous one-shot init locked
        // those users into an empty avatar forever. Only overwrite when
        // Google currently provides a non-empty URL that differs from what's
        // stored — that way a transient empty response can't wipe a
        // previously-good URL. The next stats flush mirrors the new URL into
        // the leaderboard row automatically (see statsCb).
        //
        // Critically, we do NOT call migrateLocalToFirebase() here — that's
        // first-sign-in-only work to drain guest localStorage into the new
        // RTDB node. Running it for a returning user (which now happens
        // every page load via onAuthStateChanged) tries to replay stale
        // local stats on top of real server totals and the rules correctly
        // reject those writes with PERMISSION_DENIED.
        const stored = existing.val() || {};
        if (livePhoto && livePhoto !== (stored.photoURL || '')) {
          await db.ref('users/' + u.uid + '/profile/photoURL').set(livePhoto);
        }
        return;
      }

      // First sign-in: drain any guest localStorage state into this user's
      // RTDB node before seeding the profile/leaderboard rows so the initial
      // leaderboard mirror picks up the migrated totalClicks.
      await migrateLocalToFirebase(u.uid);
      const ts = firebase.database.ServerValue.TIMESTAMP;
      const profile = {
        displayName: (u.displayName || 'Sensei').slice(0, 24),
        photoURL:    livePhoto,
        country:     visitorCountry || 'XX',
        provider:    'google',
        linkedAt:    ts,
      };
      await db.ref('users/' + u.uid + '/profile').set(profile);
      // Initial leaderboard row uses the post-migration server total so any
      // guest clicks accrued before sign-in show up on the board right away.
      const serverStats = (await db.ref('users/' + u.uid + '/stats').once('value')).val() || {};
      const clicks = serverStats.totalClicks || 0;
      await db.ref('leaderboard/topClicks/' + u.uid).set({
        name:        profile.displayName,
        country:     profile.country,
        photoURL:    lbPhoto(profile),
        totalClicks: clicks,
      }).catch(() => {});
    }

    // --- Click batch system -----------------------------------------------------
    // Every click hits Firebase via this batcher instead of immediately. Counts
    // accumulate in memory + localStorage, and we flush once every ~5s — both
    // on a heartbeat (so a long combo run gets periodic saves) and on
    // visibilitychange/pagehide (so a tab close attempts a final flush). The
    // localStorage backup recovers the in-flight batch if the tab crashes.
    //
    // Optimistic UI: renderSenseiBar reads (userStats + pending.userCoins/userClicks)
    // so the XP fill, level, and coin counter update instantly even though
    // Firebase sees one write every 5s.
    const FLUSH_DEBOUNCE_MS = 5000;
    const FLUSH_HEARTBEAT_MS = 5000;
    const PENDING_KEY = 'aobing-pending-clicks';

    // `var` (not const) so the hoisted binding is `undefined` for any early
    // reads from renderSenseiBar() at script-load time — see the typeof guard
    // in that function. After this line executes, all reads see the object.
    var pending = {
      userCoins: 0,      // mouse + auto coin gain (can be negative — shop debits)
      userClicks: 0,     // mouse + (auto if lbAuto) click gain (always >= 0, goes to totalClicks)
      global: 0,         // any source: clicks
      daily: 0,          // any source: daily/{today}/total
      byCountry: {},     // daily/{today}/countries/{cc}
      bySkin: {},        // daily/{today}/skins/{variantId}
      byCharacter: {},   // daily/{today}/characters/{charId}
      allTimeSkin: {},   // skins/{variantId}
      bySource: {},      // { mouse: N, keyboard: N, auto: N } — clicks_by_source/{src} + daily/{today}/sources/{src}
      userBySource: {},  // per-user per-source — users/{uid}/stats/bySource/{src}
      typingWords: 0,    // additive — users/{uid}/stats/typingWords (typing-game completed words)
      typingBestWpm: {}, // best-of per mode { s15,s30,s60 } — users/{uid}/stats/typingBestWpm/{mode}
      typingBestScore: {}, // best-of per mode — users/{uid}/stats/typingBestScore/{mode}
      fishdex: {},       // species → count delta (additive) — users/{uid}/stats/fishdex/{species}/count
      specimens: [],     // specimen instances to push — users/{uid}/aquarium/specimens/{id}
    };
    let flushDebounceTimer = null;
    let flushHeartbeatTimer = null;
    let isFlushing = false;
    let drainTimer = null;
    // True when a chunked flush left backlog in `pending` that still needs to
    // be sent (a burst larger than a single RTDB_CHUNK write).
    function hasPendingBacklog() {
      return pending.userCoins !== 0 || pending.userClicks > 0
        || pending.global > 0 || pending.daily > 0
        || Object.keys(pending.byCountry).length    > 0
        || Object.keys(pending.bySkin).length        > 0
        || Object.keys(pending.byCharacter).length   > 0
        || Object.keys(pending.allTimeSkin).length   > 0
        || Object.keys(pending.bySource).length      > 0
        || Object.keys(pending.userBySource).length  > 0
        || pending.typingWords > 0
        || Object.keys(pending.typingBestWpm).length > 0
        || Object.keys(pending.typingBestScore).length > 0
        || Object.keys(pending.fishdex || {}).length > 0 || (pending.specimens || []).length > 0;
    }

    // Immediate localStorage write — use this after flushPending zeros the
    // batch, on visibilitychange/pagehide, etc. Anywhere correctness needs
    // localStorage to reflect the latest `pending` synchronously.
    function savePending() {
      try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch {}
    }
    // Hot-path version: at 30+ cps, JSON.stringify on every click was the main
    // CPU hog. Throttle to once per 200ms — worst case is losing the last
    // <200ms of clicks on a hard tab crash, which is well below the existing
    // 5s flush horizon for normal data persistence.
    let pendingDirtyTimer = null;
    function savePendingDeferred() {
      if (pendingDirtyTimer) return;
      pendingDirtyTimer = setTimeout(() => {
        pendingDirtyTimer = null;
        savePending();
      }, 200);
    }
    function loadPending() {
      try {
        const raw = localStorage.getItem(PENDING_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        // One-time migration: pre-shop `user` field maps 1:1 into both new fields,
        // since the old semantic was "+1 click = +1 totalClick = +1 coin".
        if (typeof saved.user === 'number' && saved.user > 0) {
          pending.userCoins  += saved.user;
          pending.userClicks += saved.user;
        }
        if (typeof saved.userCoins  === 'number') pending.userCoins  += saved.userCoins;
        if (typeof saved.userClicks === 'number') pending.userClicks += saved.userClicks;
        if (typeof saved.global === 'number') pending.global += saved.global;
        if (typeof saved.daily === 'number')  pending.daily += saved.daily;
        for (const k in saved.byCountry || {})    pending.byCountry[k]    = (pending.byCountry[k]    || 0) + saved.byCountry[k];
        for (const k in saved.bySkin || {})       pending.bySkin[k]       = (pending.bySkin[k]       || 0) + saved.bySkin[k];
        for (const k in saved.byCharacter || {})  pending.byCharacter[k]  = (pending.byCharacter[k]  || 0) + saved.byCharacter[k];
        for (const k in saved.allTimeSkin || {})  pending.allTimeSkin[k]  = (pending.allTimeSkin[k]  || 0) + saved.allTimeSkin[k];
        for (const k in saved.bySource || {})     pending.bySource[k]     = (pending.bySource[k]     || 0) + saved.bySource[k];
        for (const k in saved.userBySource || {}) pending.userBySource[k] = (pending.userBySource[k] || 0) + saved.userBySource[k];
        if (typeof saved.typingWords === 'number') pending.typingWords += saved.typingWords;
        for (const k in saved.typingBestWpm || {}) pending.typingBestWpm[k] = Math.max(pending.typingBestWpm[k] || 0, saved.typingBestWpm[k]);
        for (const k in saved.typingBestScore || {}) pending.typingBestScore[k] = Math.max(pending.typingBestScore[k] || 0, saved.typingBestScore[k]);
        if (saved.fishdex) { for (const k in saved.fishdex) pending.fishdex[k] = (pending.fishdex[k] || 0) + saved.fishdex[k]; }
        if (Array.isArray(saved.specimens)) pending.specimens.push.apply(pending.specimens, saved.specimens);
      } catch {}
    }
    loadPending();

    function scheduleFlush() {
      if (flushDebounceTimer) clearTimeout(flushDebounceTimer);
      flushDebounceTimer = setTimeout(flushPending, FLUSH_DEBOUNCE_MS);
      if (!flushHeartbeatTimer) {
        flushHeartbeatTimer = setInterval(() => {
          if (pending.userCoins !== 0 || pending.userClicks > 0 || pending.global > 0) flushPending();
        }, FLUSH_HEARTBEAT_MS);
      }
    }

    // Called once per click event. Source determines which pipeline runs:
    //   mouse    — coins scale by shopMul.coin, clicks by shopMul.click
    //   keyboard — 1:1, no coin/userClick (excluded from leaderboard + economy by design)
    //   auto     — coins always; clicks only if Leaderboard Auto unlocked
    function recordClick(source) {
      const { character: ch, variant: v } = getVariant(settings.skin);
      const m = shopMul(Date.now());
      const _scBefore = pending.userClicks;  // for the session-click delta below

      if (source === 'mouse') {
        const coinGain  = Math.floor(m.coin);
        const clickGain = Math.floor(m.click);
        pending.userCoins  += coinGain;
        pending.userClicks += clickGain;
        pending.global     += clickGain;
        pending.daily      += clickGain;
        if (visitorCountry) {
          pending.byCountry[visitorCountry] = (pending.byCountry[visitorCountry] || 0) + clickGain;
        }
        pending.bySkin[v.id]         = (pending.bySkin[v.id]         || 0) + clickGain;
        pending.byCharacter[ch.id]   = (pending.byCharacter[ch.id]   || 0) + clickGain;
        pending.allTimeSkin[v.id]    = (pending.allTimeSkin[v.id]    || 0) + clickGain;
        pending.bySource[source]     = (pending.bySource[source]     || 0) + clickGain;
        pending.userBySource[source] = (pending.userBySource[source] || 0) + clickGain;
      } else if (source === 'keyboard') {
        // Keyboard: 1-per-key. Doesn't earn coins, doesn't touch userClicks
        // (leaderboard is mouse/tap only by design). ALSO no longer credits
        // per-variant XP — kept it out of pending.allTimeSkin so keyboard
        // mashing can't level a skin (and can't earn bonds either).
        pending.global += 1;
        pending.daily  += 1;
        if (visitorCountry) {
          pending.byCountry[visitorCountry] = (pending.byCountry[visitorCountry] || 0) + 1;
        }
        pending.bySkin[v.id]         = (pending.bySkin[v.id]         || 0) + 1;
        pending.byCharacter[ch.id]   = (pending.byCharacter[ch.id]   || 0) + 1;
        // pending.allTimeSkin intentionally omitted — see comment above.
        pending.bySource[source]     = (pending.bySource[source]     || 0) + 1;
        pending.userBySource[source] = (pending.userBySource[source] || 0) + 1;
      } else if (source === 'auto') {
        // Auto: always coins. Click stats only if Leaderboard Auto unlocked.
        const coinGain  = Math.floor(m.coin);
        const clickGain = m.lbAuto ? Math.floor(m.click) : 0;
        pending.userCoins  += coinGain;
        if (clickGain > 0) {
          pending.userClicks += clickGain;
          pending.global     += clickGain;
          pending.daily      += clickGain;
          if (visitorCountry) {
            pending.byCountry[visitorCountry] = (pending.byCountry[visitorCountry] || 0) + clickGain;
          }
          pending.bySkin[v.id]         = (pending.bySkin[v.id]         || 0) + clickGain;
          pending.byCharacter[ch.id]   = (pending.byCharacter[ch.id]   || 0) + clickGain;
          pending.allTimeSkin[v.id]    = (pending.allTimeSkin[v.id]    || 0) + clickGain;
          pending.bySource[source]     = (pending.bySource[source]     || 0) + clickGain;
          pending.userBySource[source] = (pending.userBySource[source] || 0) + clickGain;
        }
      }
      // Session counter for the Activity presence panel — same leaderboard-eligible
      // clicks that feed totalClicks (mouse + unlocked leaderboard-auto).
      sessionClicks += pending.userClicks - _scBefore;
      savePendingDeferred();
      scheduleFlush();
      // Coalesce the two render calls into a single rAF callback. At 30+ cps
      // we used to thrash innerHTML 60 times per second; with this, both
      // renders run at most once per animation frame regardless of click rate.
      scheduleOptimisticRender();
      // Sliding-window CPS: record every event (mouse + keyboard + auto).
      const ts = performance.now();
      cpsTimestamps.push(ts);
      // Manual-only window for resolveActiveSrc — excludes auto-clicker.
      if (source !== 'auto') manualCpsTimestamps.push(ts);
    }

    // rAF-coalesced optimistic UI refresh. Called from the hot click path.
    let optimisticRenderRequested = false;
    function scheduleOptimisticRender() {
      if (optimisticRenderRequested) return;
      optimisticRenderRequested = true;
      requestAnimationFrame(() => {
        optimisticRenderRequested = false;
        if (typeof renderSenseiBar       === 'function') renderSenseiBar();
        if (typeof renderClickCounter    === 'function') renderClickCounter();
        if (typeof updateVariantLevels === 'function') updateVariantLevels();
        if (typeof renderSkinBar       === 'function') renderSkinBar();
      });
    }

    // In-place level-badge refresh — avoids rewriting the skin list innerHTML
    // (which would lose any user-toggled open/closed group state). When a
    // variant crosses into bond-eligible territory mid-click-streak, fall
    // through to a full renderSkinList so the heart button appears.
    function updateVariantLevels() {
      if (!skinListEl) return;
      let needFullRender = false;
      for (const c of CHARACTERS) {
        for (const v of c.variants) {
          const tile = skinListEl.querySelector(`.skin-item[data-variant="${v.id}"]`);
          if (!tile) continue;
          const canBond     = variantCanBond(v.id);
          const wasBondReady = tile.classList.contains('bond-ready');
          if (canBond !== wasBondReady) { needFullRender = true; continue; }
          const el = tile.querySelector('.skin-variant-level');
          if (!el) continue;
          const lv   = variantLevelOf(v.id);
          const cur  = variantXpInLevel(v.id);
          const need = variantXpToNext(v.id);
          el.textContent = 'Lv.' + lv + (canBond ? ' MAX' : '');
          el.title = canBond
            ? `Lv.${MAX_VARIANT_LEVEL} MAX · ready to bond`
            : `Lv.${lv} · ${cur.toLocaleString()} / ${need.toLocaleString()} XP`;
        }
      }
      if (needFullRender) renderSkinList();
    }

    async function flushPending() {
      if (isFlushing) return;
      if (pending.userCoins === 0 && pending.userClicks === 0 && pending.global === 0
          && pending.typingWords === 0 && Object.keys(pending.typingBestWpm).length === 0 && Object.keys(pending.typingBestScore).length === 0
          && Object.keys(pending.fishdex).length === 0 && pending.specimens.length === 0) return;
      isFlushing = true;
      // Chunked snapshot: move at most CHUNK_CAP per capped path into `batch`,
      // leaving any remainder in `pending` to drain on follow-up flushes. The
      // RTDB rules reject any single write that bumps a counter by more than
      // +10000, so an unbounded burst would otherwise be rejected wholesale and
      // re-sent forever (the bug behind "clicked like crazy, refreshed, progress
      // gone"). Guests have no server rules, so they drain the whole backlog at
      // once (cap = Infinity). coinBalance debits (negative) also carry whole —
      // only the +10000 *increase* is capped, so a spend never trips it. Any
      // clicks recorded during the in-flight write accumulate into the next batch.
      const CHUNK_CAP = currentUser ? RTDB_CHUNK : Infinity;
      const takeChunk = (src) => {
        const out = {};
        for (const k in src) {
          const c = Math.min(src[k], CHUNK_CAP);
          if (c > 0) { out[k] = c; src[k] -= c; if (src[k] <= 0) delete src[k]; }
        }
        return out;
      };
      // Best-of values aren't increments — take the whole map and clear it. The
      // server-side write is a max() transaction, so it's idempotent on retry.
      const takeBest = (src) => {
        const out = {};
        for (const k in src) { out[k] = src[k]; delete src[k]; }
        return out;
      };
      const batch = {
        userCoins:  pending.userCoins > 0 ? Math.min(pending.userCoins, CHUNK_CAP) : pending.userCoins,
        userClicks: Math.min(pending.userClicks, CHUNK_CAP),
        global:     Math.min(pending.global, CHUNK_CAP),
        daily:      Math.min(pending.daily,  CHUNK_CAP),
        byCountry:    takeChunk(pending.byCountry),
        bySkin:       takeChunk(pending.bySkin),
        byCharacter:  takeChunk(pending.byCharacter),
        allTimeSkin:  takeChunk(pending.allTimeSkin),
        bySource:     takeChunk(pending.bySource),
        userBySource: takeChunk(pending.userBySource),
        typingWords:  Math.min(pending.typingWords, CHUNK_CAP),
        typingBestWpm: takeBest(pending.typingBestWpm),
        typingBestScore: takeBest(pending.typingBestScore),
        // fishdex values are additive count deltas; takeBest is reused only for drain-all + retry-restore semantics, not max() idempotency
        fishdex: takeBest(pending.fishdex),   // take all, clear pending; restore on failure
        specimens: pending.specimens.splice(0), // drain array; restore on failure
      };
      pending.userCoins  -= batch.userCoins;
      pending.userClicks -= batch.userClicks;
      pending.global     -= batch.global;
      pending.daily      -= batch.daily;
      pending.typingWords -= batch.typingWords;
      savePending();
      // Hand off the public-counter AND user-stat deltas from `pending` to
      // `inFlight` so the pills/sensei bar stay visually steady across the
      // flush boundary. inFlight clears when the respective listener confirms
      // the server includes our contribution.
      const wasInFlightGlobal     = inFlightGlobal;
      const wasInFlightSkin       = inFlightSkin;
      const wasInFlightUserCoins  = inFlightUserCoins;
      const wasInFlightUserClicks = inFlightUserClicks;
      const skinDeltaInBatch      = batch.allTimeSkin[currentSkinVariant] || 0;
      inFlightGlobal     += batch.global;
      inFlightSkin       += skinDeltaInBatch;
      inFlightUserCoins  += batch.userCoins;
      inFlightUserClicks += batch.userClicks;
      // Update sensei (uses pending.userCoins/userClicks, now 0) and click pill.
      if (typeof renderSenseiBar    === 'function') renderSenseiBar();
      if (typeof renderClickCounter === 'function') renderClickCounter();

      const today = todayKey();
      const tasks = [];

      // Per-user multi-path update. Fires for any user-stat change:
      //   - Click activity (userClicks > 0 or userBySource entries) bumps totalClicks
      //     and bySource, and advances lastClickAt for throttle bookkeeping.
      //   - Pure coin changes (userCoins != 0, e.g. shop debits) update coinBalance
      //     ONLY — they must not advance lastClickAt or the next real click would
      //     trip the 1s throttle on totalClicks/bySource validation.
      const hasClickActivity = batch.userClicks > 0 || Object.keys(batch.userBySource).length > 0;
      const hasCoinChange    = batch.userCoins !== 0;
      const hasTypingWords   = batch.typingWords > 0;
      const hasTypingWpm     = Object.keys(batch.typingBestWpm).length > 0;
      const hasFishdex       = Object.keys(batch.fishdex).length > 0;
      const hasSpecimens     = batch.specimens.length > 0;
      if (currentUser && (hasClickActivity || hasCoinChange || hasTypingWords || hasFishdex || hasSpecimens)) {
        const uid = currentUser.uid;
        const update = {};
        if (batch.userClicks > 0) {
          update[`users/${uid}/stats/totalClicks`] = firebase.database.ServerValue.increment(batch.userClicks);
        }
        if (batch.userCoins !== 0) {
          update[`users/${uid}/stats/coinBalance`] = firebase.database.ServerValue.increment(batch.userCoins);
        }
        if (batch.typingWords > 0) {
          update[`users/${uid}/stats/typingWords`] = firebase.database.ServerValue.increment(batch.typingWords);
        }
        for (const src in batch.userBySource) {
          update[`users/${uid}/stats/bySource/${src}`] =
            firebase.database.ServerValue.increment(batch.userBySource[src]);
        }
        // Per-user per-variant click count. Drives per-character XP, summed
        // across the character's variants at render time.
        for (const sk in batch.allTimeSkin) {
          update[`users/${uid}/stats/skins/${sk}`] =
            firebase.database.ServerValue.increment(batch.allTimeSkin[sk]);
        }
        if (hasClickActivity) {
          update[`users/${uid}/stats/lastClickAt`] = firebase.database.ServerValue.TIMESTAMP;
        }
        // fishdex aggregate: increment count, max size, min float, OR shiny
        for (const sp in batch.fishdex) {
          const inc = batch.fishdex[sp];
          if (inc > 0) {
            update[`users/${uid}/stats/fishdex/${sp}/count`] = firebase.database.ServerValue.increment(inc);
          }
        }
        // per-species maxSize/bestFloat/shinyCaught reflect the current in-memory aggregate
        for (const sp in batch.fishdex) {
          const agg = userStats.fishdex[sp];
          if (agg) {
            update[`users/${uid}/stats/fishdex/${sp}/maxSize`] = agg.maxSize;
            update[`users/${uid}/stats/fishdex/${sp}/bestFloat`] = agg.bestFloat;
            update[`users/${uid}/stats/fishdex/${sp}/shinyCaught`] = agg.shinyCaught;
          }
        }
        // specimen instances: push each under a fresh id
        for (const inst of batch.specimens) {
          const id = db.ref(`users/${uid}/aquarium/specimens`).push().key;
          update[`users/${uid}/aquarium/specimens/${id}`] = inst;
        }
        tasks.push(db.ref().update(update));
      } else if (!currentUser && (hasClickActivity || hasCoinChange || hasTypingWords || hasTypingWpm)) {
        // Guest mode: apply user-stat deltas to the in-memory mirror and
        // persist to localStorage. Inflight tracker doesn't apply here
        // because there's no listener round-trip to wait for.
        if (batch.userClicks > 0) userStats.totalClicks = (userStats.totalClicks || 0) + batch.userClicks;
        if (batch.userCoins !== 0) userStats.coinBalance = Math.max(0, (userStats.coinBalance || 0) + batch.userCoins);
        if (!userStats.skins)    userStats.skins = {};
        if (!userStats.bySource) userStats.bySource = {};
        for (const sk in batch.allTimeSkin)  userStats.skins[sk]    = (userStats.skins[sk]    || 0) + batch.allTimeSkin[sk];
        for (const src in batch.userBySource) userStats.bySource[src] = (userStats.bySource[src] || 0) + batch.userBySource[src];
        if (batch.typingWords > 0) userStats.typingWords = (userStats.typingWords || 0) + batch.typingWords;
        if (hasTypingWpm) {
          if (!userStats.typingBestWpm) userStats.typingBestWpm = {};
          for (const mode in batch.typingBestWpm) {
            userStats.typingBestWpm[mode] = Math.max(userStats.typingBestWpm[mode] || 0, batch.typingBestWpm[mode]);
          }
        }
        inFlightUserCoins  = 0;  // applied locally, no RTDB roundtrip
        inFlightUserClicks = 0;
        saveLocalUserData();
        if (typeof renderSenseiBar       === 'function') renderSenseiBar();
        if (typeof updateVariantLevels === 'function') updateVariantLevels();
        if (typeof renderSkinBar       === 'function') renderSkinBar();
      }
      if (batch.global > 0) {
        tasks.push(clicksRef.transaction((c) => (c || 0) + batch.global));
      }
      if (batch.daily > 0) {
        tasks.push(db.ref('daily/' + today + '/total').transaction((c) => (c || 0) + batch.daily));
      }
      for (const cc in batch.byCountry) {
        const n = batch.byCountry[cc];
        tasks.push(db.ref('daily/' + today + '/countries/' + cc).transaction((c) => (c || 0) + n));
      }
      for (const sk in batch.bySkin) {
        const n = batch.bySkin[sk];
        tasks.push(db.ref('daily/' + today + '/skins/' + sk).transaction((c) => (c || 0) + n));
      }
      for (const chId in batch.byCharacter) {
        const n = batch.byCharacter[chId];
        tasks.push(db.ref('daily/' + today + '/characters/' + chId).transaction((c) => (c || 0) + n));
      }
      for (const sk in batch.allTimeSkin) {
        const n = batch.allTimeSkin[sk];
        tasks.push(db.ref('skins/' + sk).transaction((c) => (c || 0) + n));
      }
      for (const src in batch.bySource) {
        const n = batch.bySource[src];
        tasks.push(db.ref('clicks_by_source/' + src).transaction((c) => (c || 0) + n));
        tasks.push(db.ref('daily/' + today + '/sources/' + src).transaction((c) => (c || 0) + n));
      }
      // Best WPM per mode — max() transaction (best-of, not additive). Guests are
      // handled in the in-memory block above; this is the authed server write.
      if (currentUser) {
        for (const mode in batch.typingBestWpm) {
          const w = batch.typingBestWpm[mode];
          tasks.push(db.ref(`users/${currentUser.uid}/stats/typingBestWpm/${mode}`)
            .transaction((c) => (c == null || w > c) ? w : c));
        }
        for (const mode in batch.typingBestScore) {
          const sc = batch.typingBestScore[mode];
          tasks.push(db.ref(`users/${currentUser.uid}/stats/typingBestScore/${mode}`)
            .transaction((c) => (c == null || sc > c) ? sc : c));
        }
      }

      try {
        await Promise.all(tasks);
        // A burst exceeded the per-write cap and was chunked — drain the rest
        // promptly. 1100ms spacing keeps consecutive totalClicks/bySource
        // writes past the rules' 1s throttle (same cadence as the migration).
        if (hasPendingBacklog()) {
          if (drainTimer) clearTimeout(drainTimer);
          drainTimer = setTimeout(() => { drainTimer = null; flushPending(); }, 1100);
        }
      } catch (e) {
        // Restore the batch so it retries on the next flush. Some sub-writes
        // may have succeeded, so we may double-count under repeated failures —
        // that's preferable to losing the user's clicks entirely.
        pending.userCoins  += batch.userCoins;
        pending.userClicks += batch.userClicks;
        pending.global     += batch.global;
        pending.daily      += batch.daily;
        for (const k in batch.byCountry)    pending.byCountry[k]    = (pending.byCountry[k]    || 0) + batch.byCountry[k];
        for (const k in batch.bySkin)       pending.bySkin[k]       = (pending.bySkin[k]       || 0) + batch.bySkin[k];
        for (const k in batch.byCharacter)  pending.byCharacter[k]  = (pending.byCharacter[k]  || 0) + batch.byCharacter[k];
        for (const k in batch.allTimeSkin)  pending.allTimeSkin[k]  = (pending.allTimeSkin[k]  || 0) + batch.allTimeSkin[k];
        for (const k in batch.bySource)     pending.bySource[k]     = (pending.bySource[k]     || 0) + batch.bySource[k];
        for (const k in batch.userBySource) pending.userBySource[k] = (pending.userBySource[k] || 0) + batch.userBySource[k];
        pending.typingWords += batch.typingWords;
        for (const k in batch.typingBestWpm) pending.typingBestWpm[k] = Math.max(pending.typingBestWpm[k] || 0, batch.typingBestWpm[k]);
        for (const k in batch.typingBestScore) pending.typingBestScore[k] = Math.max(pending.typingBestScore[k] || 0, batch.typingBestScore[k]);
        for (const k in batch.fishdex) pending.fishdex[k] = (pending.fishdex[k] || 0) + batch.fishdex[k];
        for (const inst of batch.specimens) pending.specimens.push(inst);
        // Also roll back the inFlight bumps from the snapshot — the data is
        // back in pending now and will be re-sent on the next flush attempt.
        inFlightGlobal     = wasInFlightGlobal;
        inFlightSkin       = wasInFlightSkin;
        inFlightUserCoins  = wasInFlightUserCoins;
        inFlightUserClicks = wasInFlightUserClicks;
        savePending();
        if (typeof renderClickCounter === 'function') renderClickCounter();
        if (typeof renderSenseiBar    === 'function') renderSenseiBar();
      } finally {
        isFlushing = false;
      }
    }

    // Tab-close / hide best-effort flush. We can't await on these handlers,
    // but firing the call gives the Firebase SDK a chance to send before the
    // page is torn down. The localStorage backup is the real safety net.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPending();
    });
    window.addEventListener('pagehide', flushPending);

    // If we recovered a pending batch from localStorage on startup, kick a
    // flush after auth resolves.
    authReady.then(() => {
      if (hasPendingBacklog()) scheduleFlush();
    });

    // System time pill — updates every minute, aligned to the next minute boundary
    const timeEl = document.querySelector('#system-time .pill-value');
    function renderTime() {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      timeEl.textContent = `${hh}:${mm}`;
    }
    renderTime();
    setTimeout(function tick() {
      renderTime();
      setTimeout(tick, 60000);
    }, 60000 - (Date.now() % 60000));

    // --- Intro Walking Animation ---
    // (introActive is hoisted to the top of the script so applyVariant can read it during
    // initial setup without hitting the TDZ.)
    let walkTimer = null;
    let currentWalkAnim = null;
    let walkDirection = 1;
    let currentWalkX = 0;
    const STEP_VW = 10;
    const STEP_MS = 500;
    const PAUSE_MS = 500;

    function getWalkRange() {
      return window.innerWidth < 600 ? 25 : 35;
    }

    function startIntroWalk() {
      character.classList.add('intro-walk');
      // Default sprite faces left — flip to face right for initial rightward walk
      aobaImg.style.transform = 'scaleX(-1)';

      function step() {
        if (!introActive) return;

        const range = getWalkRange();
        let nextX = currentWalkX + STEP_VW * walkDirection;

        // Bounds check — turn around and pause before walking back
        if (nextX > range || nextX < -range) {
          walkDirection *= -1;
          aobaImg.style.transform = walkDirection > 0 ? 'scaleX(-1)' : '';
          if (introActive) {
            walkTimer = setTimeout(step, PAUSE_MS);
          }
          return;
        }

        currentWalkAnim = animate(character, {
          translateX: nextX + 'vw',
          duration: STEP_MS,
          ease: 'inOutQuad',
          onComplete: () => {
            currentWalkX = nextX;
            if (introActive) {
              walkTimer = setTimeout(step, PAUSE_MS);
            }
          }
        });
      }

      walkTimer = setTimeout(step, 600);
    }

    function endIntro(opts) {
      if (!introActive) return;
      introActive = false;
      const fromLobby = opts && opts.source === 'lobby';
      const source = opts && opts.source === 'keyboard' ? 'keyboard' : 'mouse';

      if (walkTimer) clearTimeout(walkTimer);
      if (currentWalkAnim) currentWalkAnim.pause();

      aobaImg.style.transform = '';

      // Entering the lobby is navigation, so it does not count as a click or
      // trigger character reactions. The shell owns the boot exit animation.
      if (fromLobby) {
        applyMode('clicker');
        character.classList.remove('intro-walk');
        character.style.transform = '';
        const { character: ch, variant: v } = getVariant(settings.skin);
        if (ch.bgm || v.bgm) bgm.play().then(() => { bgmPlaying = true; }).catch(() => {});
        scheduleIdleBubble();
        rearmAutoLoop();
        return;
      }

      animate(character, {
        translateX: '0vw',
        duration: 350,
        ease: 'outQuad',
        onComplete: () => {
          character.classList.remove('intro-walk');
          character.style.transform = '';

          // Fade curtain
          const curtainEl = document.getElementById('curtain');
          if (curtainEl) {
            animate(curtainEl, {
              opacity: 0,
              duration: 500,
              ease: 'outQuad',
              onComplete: () => curtainEl.remove()
            });
          }

          // First click — full click effects
          const { character: ch, variant: v } = getVariant(settings.skin);
          recordClick(source);

          playsfx();
          bumpCombo();

          aobaImg.src = resolveActiveSrc(v);

          bounceAnimation = animate(character, {
            translateY: [
              { to: '-80px', duration: 300, ease: 'outQuad' },
              { to: '0px', duration: 400, ease: 'outBounce' },
            ],
            onComplete: () => goIdle(),
          });

          if (settings.effects) spawnParticles();
          if (ch.bgm || v.bgm) {
            bgm.play().then(() => { bgmPlaying = true; }).catch(() => {});
          }

          // Arm the idle-text bubble timer now that intro is over
          scheduleIdleBubble();
          // Same trigger point for the shop auto-clicker — suppressed during intro.
          rearmAutoLoop();
        }
      });
    }

    if (document.getElementById('boot-start')) {
      window.addEventListener('aobingstart', () => endIntro({ source: 'lobby' }), { once: true });
    } else {
      document.getElementById('curtain').addEventListener('click', endIntro);
      startIntroWalk();
    }

    // Purely-cosmetic character reaction: SFX, combo bump, sprite swap, bounce,
    // particles. Carries NO economy (no recordClick / coins / totalClicks).
    // Shared by the clicker (via triggerClick) and the typing game, which calls
    // it through the injected `reactCharacter` dep for its per-word/per-key toggle.
    function reactCharacter() {
      const { variant: v } = getVariant(settings.skin);

      // 1. Play SFX — each click spawns its own audio, oldest evicted at cap
      playsfx();
      // While typing, the typing engine owns #combo-display via renderTypingCombo;
      // suppress the click-combo paint so the two don't fight over the element.
      if (!isTypingActive) bumpCombo();

      // 2. Swap to active image
      aobaImg.src = resolveActiveSrc(v);

      // 3. Damped bounce animation
      if (bounceAnimation) {
        bounceAnimation.pause();
      }
      character.style.transform = '';

      bounceAnimation = animate(character, {
        translateY: [
          { to: '-80px', duration: 300, ease: 'outQuad' },
          { to: '0px', duration: 400, ease: 'outBounce' },
        ],
        onComplete: () => goIdle(),
      });

      // 4. Spawn text particles (if effects enabled)
      if (settings.effects) spawnParticles();
    }

    function triggerClick(opts) {
      const source = opts && opts.source === 'keyboard' ? 'keyboard' : 'mouse';

      // During intro, end intro (first click counts)
      if (introActive) {
        endIntro({ source });
        return;
      }

      // All Firebase writes (per-user mouse stats AND global counters) flow
      // through the batcher. See pending / flushPending below.
      recordClick(source);
      reactCharacter();
    }

    // --- Typing game host seam ------------------------------------------------
    // While the typing panel input is focused, isTypingActive suppresses the
    // global keydown clicker handler so per-key typing never double-fires clicks.
    let isTypingActive = false;
    function setTypingActive(v) { isTypingActive = !!v; }

    // Routes typing earnings into the existing pending batch so the optimistic
    // UI and the 5s flush apply — WITHOUT touching userClicks/totalClicks (the
    // clicker leaderboard stays typing-free).
    //
    // Typing coins are DELIBERATELY decoupled from shopMul.coin: the clicker
    // coin multiplier can reach ~100x on a maxed save, and compounding it on top
    // of comboPowerLevel (up to 100x) and the combo cap (50x) is what let a
    // single session print ~100M. Instead we apply a flat TYPING_COIN_RATE, sized
    // so a maxed-Combo-Power, no-miss ~15s run lands around 5M and never inflates
    // as clicking upgrades grow.
    //   coins:        raw per-word payout from the engine (wordBuffer x effMul)
    //   words:        completed-word count -> stats/typingWords + words board
    //   opts.mode +   run-end ranked WPM submit, best-of per mode
    //   opts.bestWpm
    function creditTyping(coins, words, opts) {
      const coinGain = Math.floor((coins || 0) * TYPING_COIN_RATE);
      if (coinGain) pending.userCoins += coinGain;
      if (words > 0) pending.typingWords += words;
      if (opts && opts.mode && opts.bestWpm > 0) {
        const cur = pending.typingBestWpm[opts.mode] || 0;
        if (opts.bestWpm > cur) pending.typingBestWpm[opts.mode] = opts.bestWpm;
      }
      if (opts && opts.mode && opts.runScore > 0) {
        const curS = pending.typingBestScore[opts.mode] || 0;
        if (opts.runScore > curS) pending.typingBestScore[opts.mode] = opts.runScore;
      }
      // Global daily records (shown in analytics) — only ranked-eligible runs reach
      // here with bestWpm/runScore. Monotonic max, same pattern as the combo peak.
      if (opts && (opts.bestWpm > 0 || opts.runScore > 0)) {
        recordTypingDaily(opts.bestWpm || 0, opts.runScore || 0);
      }
      savePendingDeferred();
      scheduleFlush();
      if (typeof scheduleOptimisticRender === 'function') scheduleOptimisticRender();
    }

    // Record one caught specimen: credit coins, update the in-memory aggregate +
    // specimen list (guests persist via saveLocalUserData), and queue Firebase writes.
    function recordCatch(specimen, coins, isNew) {
      // 1. coins through the standard batched path
      if (coins > 0) { pending.userCoins += Math.floor(coins); }

      // 2. fishdex aggregate (in-memory; mirrors the Firebase shape)
      const sp = specimen.species;
      const agg = userStats.fishdex[sp] || { count: 0, maxSize: 0, bestFloat: 1, shinyCaught: false };
      agg.count += 1;
      agg.maxSize = Math.max(agg.maxSize, specimen.size);
      agg.bestFloat = Math.min(agg.bestFloat, specimen.float); // lower float is better
      agg.shinyCaught = agg.shinyCaught || !!specimen.shiny;
      userStats.fishdex[sp] = agg;

      // 3. specimen instance (in-memory list; unbounded keep-all)
      const inst = {
        species: sp, size: specimen.size, float: specimen.float,
        shiny: !!specimen.shiny, caughtAt: Date.now(),
      };
      userStats.aquariumSpecimens.push(inst);

      // 4. queue Firebase writes for signed-in users
      if (currentUser) {
        pending.fishdex[sp] = (pending.fishdex[sp] || 0) + 1;
        pending.specimens.push(inst);
      }

      // 5. persist + flush
      saveLocalUserData();       // guests persist here; signed-in users rely on the Firebase flush
      savePendingDeferred();
      scheduleFlush();
    }

    function recordTypingDaily(wpm, score) {
      const day = todayKey();
      if (wpm > 0) {
        db.ref('daily/' + day + '/typingMaxWpm').transaction((cur) => (cur == null || wpm > cur) ? wpm : undefined);
      }
      if (score > 0) {
        db.ref('daily/' + day + '/typingMaxScore').transaction((cur) => (cur == null || score > cur) ? score : undefined);
      }
    }

    character.addEventListener('click', (e) => {
      triggerClick({ source: 'mouse' });
      // Visual feedback specific to mouse/tap — anchors near the character
      const rect = character.getBoundingClientRect();
      spawnPlusOne(
        rect.left + rect.width * (0.4 + Math.random() * 0.2),
        rect.top  + rect.height * 0.2
      );
      // Brief sensei XP pulse so the bar reacts to the increment
      senseiXpFillEl.classList.remove('pulse');
      void senseiXpFillEl.offsetWidth;
      senseiXpFillEl.classList.add('pulse');
    });
    document.addEventListener('keydown', (event) => {
      if (document.getElementById('curtain') || document.getElementById('game-library')?.open) return;
      if (event.defaultPrevented || event.target.closest('button, input, select, textarea, a, [contenteditable="true"]')) return;
      if (isTypingActive) return; // typing panel owns the keyboard while focused
      if (settings.keyboardClicks === false) return;
      triggerClick({ source: 'keyboard' });
    });

    // --- Combo System (cosmetic only) ----------------------------------------
    // Counts consecutive clicks; resets after 10s of inactivity. Doesn't touch
    // the global / per-skin counters. Five milestones with escalating effects.
    const COMBO_EXPIRE_MS = 10000;
    const COMBO_TIERS = [
      { threshold: 5,    tier: 1, effect: 'pulse'   },
      { threshold: 10,   tier: 2, effect: 'pulse'   },
      { threshold: 25,   tier: 3, effect: 'confetti-sm' },
      { threshold: 50,   tier: 4, effect: 'confetti-lg' },
      { threshold: 100,  tier: 5, effect: 'finale'  },
      { threshold: 250,  tier: 6, effect: 'fireworks'     },
      { threshold: 500,  tier: 7, effect: 'fireworks-big' },
      { threshold: 1000, tier: 8, effect: 'supernova'     },
    ];
    const COMBO_CAP_TIER = 8; // top milestone at 1000x; combo still climbs past it
    // Past the top milestone the number keeps rising — re-fire an "encore" burst
    // every N clicks so a sustained high combo never goes visually silent.
    const COMBO_ENCORE_EVERY = 50;

    // When a variant declares an optional `active2` sprite, it swaps in for
    // `active` on clicks where the manual click-rate (mouse + keyboard, in
    // the last CPS_WINDOW_MS) is at or above this threshold. Auto-clicker
    // pushes are intentionally excluded — only the user's raw click speed
    // triggers the swap. Variants without `active2` are unaffected.
    const CPS_TIER_THRESHOLD = 10;
    function resolveActiveSrc(variant) {
      if (!variant.active2) return variant.active;
      const cutoff = performance.now() - CPS_WINDOW_MS;
      let cps = 0;
      for (let i = manualCpsTimestamps.length - 1; i >= 0; i--) {
        if (manualCpsTimestamps[i] >= cutoff) cps++;
        else break;
      }
      return cps >= CPS_TIER_THRESHOLD ? variant.active2 : variant.active;
    }

    const comboEl = document.getElementById('combo-display');
    const comboContentEl = document.getElementById('combo-content');
    const comboNumEl = comboEl.querySelector('.combo-number');
    const comboLabelEl = comboEl.querySelector('.combo-label');
    const comboBarFillEl = comboEl.querySelector('.combo-bar-fill');
    const comboCpsValueEl = document.getElementById('combo-cps-value');

    // Sliding-window CPS — counts every recordClick (mouse + keyboard + auto)
    // in the last 1000ms. The combo bar already fades the whole #combo-display
    // out when no clicks happen for 10s, so the CPS readout naturally fades
    // with it. Refresh every 100ms; cps stays at 0 quietly while idle.
    const CPS_WINDOW_MS = 1000;
    const CPS_REFRESH_MS = 100;
    const cpsTimestamps = [];
    // Manual-only sliding window — mouse + keyboard, NOT auto-clicks. Used by
    // resolveActiveSrc so auto-clicker rate can't trigger the active2 sprite.
    const manualCpsTimestamps = [];
    setInterval(() => {
      const cutoff = performance.now() - CPS_WINDOW_MS;
      while (cpsTimestamps.length && cpsTimestamps[0] < cutoff) cpsTimestamps.shift();
      while (manualCpsTimestamps.length && manualCpsTimestamps[0] < cutoff) manualCpsTimestamps.shift();
      if (comboCpsValueEl) {
        comboCpsValueEl.textContent = settings.rawCps ? manualCpsTimestamps.length : cpsTimestamps.length;
      }
    }, CPS_REFRESH_MS);
    let comboCount = 0;
    let comboExpireTimer = null;
    let comboLastTier = 0;
    let comboBumpAnim = null;
    let comboPeak = 0; // highest count this combo run — recorded to Firebase on expiry
    let comboPeakWritten = 0; // last value pushed to Firebase during the in-flight run
    let comboPeakFlushTimer = null;
    const COMBO_PEAK_FLUSH_DEBOUNCE_MS = 5000;

    function setComboTier(tier) {
      for (let t = 1; t <= COMBO_CAP_TIER; t++) comboEl.classList.toggle('tier-' + t, t === tier);
    }

    function expireCombo() {
      if (comboCount === 0) return;
      // Record the run's peak to Firebase BEFORE resetting state so the analytics
      // page can show "biggest combo for the day / month / year / all time".
      if (comboPeakFlushTimer) { clearTimeout(comboPeakFlushTimer); comboPeakFlushTimer = null; }
      recordComboPeak(comboPeak);
      comboCount = 0;
      comboPeak = 0;
      comboPeakWritten = 0;
      comboLastTier = 0;
      comboEl.classList.remove('active');
      setComboTier(0);
      comboLabelEl.textContent = I18N.t('combo.label');
      // Stop the bar transition so it doesn't keep animating during fade-out.
      comboBarFillEl.style.transition = 'none';
      comboBarFillEl.style.transform = 'scaleX(1)';
      // Wait for fade-out before clearing number, so it doesn't snap to 0 mid-fade.
      setTimeout(() => { if (comboCount === 0) comboNumEl.textContent = '0'; }, 400);
    }

    // Persist the running combo peak periodically so a hard tab crash mid-run
    // doesn't lose a world-record attempt. Debounced to 5s so a long combo
    // emits at most one peak write every 5s plus the final write on expiry.
    function scheduleComboPeakWrite() {
      if (comboPeakFlushTimer) return;
      comboPeakFlushTimer = setTimeout(() => {
        comboPeakFlushTimer = null;
        if (comboPeak > comboPeakWritten) {
          comboPeakWritten = comboPeak;
          recordComboPeak(comboPeak);
        }
      }, COMBO_PEAK_FLUSH_DEBOUNCE_MS);
    }

    function recordComboPeak(peak) {
      if (peak < 2) return; // ignore trivial one-click "runs"
      // Compare-and-set: only overwrite if the new peak exceeds the stored one.
      const updater = (cur) => (cur == null || peak > cur) ? peak : undefined;
      db.ref('combo/allTime').transaction(updater);
      db.ref('daily/' + todayKey() + '/maxCombo').transaction(updater);
    }

    function bumpCombo() {
      if (comboExpireTimer) clearTimeout(comboExpireTimer);
      comboCount++;
      if (comboCount > comboPeak) {
        comboPeak = comboCount;
        // Schedule a periodic peak write only if the peak actually grew past
        // what we last persisted — avoids redundant writes if combo is
        // oscillating (which it won't, but cheap to guard).
        if (comboPeak > comboPeakWritten && comboPeak >= 2) scheduleComboPeakWrite();
      }
      comboNumEl.textContent = comboCount.toLocaleString();
      comboEl.classList.add('active');

      // Reset 10s expiry timer.
      comboExpireTimer = setTimeout(expireCombo, COMBO_EXPIRE_MS);

      // Reset the bar to full instantly, then transition-drain over 10 s.
      // The reflow read between the two writes forces the browser to apply
      // the "scaleX(1) with no transition" state before installing the
      // 10 s transition — otherwise it would animate from the previous drain.
      comboBarFillEl.style.transition = 'none';
      comboBarFillEl.style.transform = 'scaleX(1)';
      void comboBarFillEl.offsetWidth;
      comboBarFillEl.style.transition = `transform ${COMBO_EXPIRE_MS}ms linear`;
      comboBarFillEl.style.transform = 'scaleX(0)';

      // Always do a scale-pop on every click for satisfying feedback. The pop
      // grows with the current tier so high combos punch harder per click.
      if (comboBumpAnim) comboBumpAnim.pause();
      comboContentEl.style.transform = '';
      const popScale = 1.15 + Math.min(comboLastTier, COMBO_CAP_TIER) * 0.02;
      comboBumpAnim = animate(comboContentEl, {
        scale: [{ to: popScale, duration: 90, ease: 'outQuad' }, { to: 1, duration: 220, ease: 'outBack' }],
      });

      // Walk through tiers and fire the highest newly-reached effect.
      let newTier = comboLastTier;
      let firedEffect = null;
      for (const t of COMBO_TIERS) {
        if (comboCount >= t.threshold && t.tier > comboLastTier) {
          newTier = t.tier;
          firedEffect = t.effect;
        }
      }
      if (newTier > comboLastTier) {
        comboLastTier = newTier;
        if (newTier <= COMBO_CAP_TIER) {
          setComboTier(newTier);
          fireComboEffect(firedEffect, newTier);
        }
      }

      // Encore: once past the finale tier (100x), keep the screen alive with a
      // small firework burst every COMBO_ENCORE_EVERY clicks. `firedEffect` is
      // non-null only when a milestone fired this click, so this skips the exact
      // milestone thresholds, which already play their own bigger effect.
      if (comboLastTier >= 5 && firedEffect === null && comboCount % COMBO_ENCORE_EVERY === 0) {
        spawnFireworks(2, 20);
      }
    }

    // --- Typing combo bridge --------------------------------------------------
    // The typing engine owns its own multiplier; this only paints #combo-display.
    // It deliberately skips recordComboPeak / the expiry timer (click-only).
    // n   = raw combo streak (drives the tier effects — long no-miss runs still
    //       earn confetti even after the multiplier caps)
    // mult = the effective ×multiplier actually applied to a word (streak clamped
    //       by the casual cap + the 50× hard cap). We DISPLAY this so the number
    //       matches what you earn rather than the inflated raw streak.
    function renderTypingCombo(n, mult) {
      if (!(n > 0)) { resetTypingCombo(); return; }
      const shown = (mult > 0) ? mult : n;
      comboNumEl.textContent = '×' + shown.toLocaleString();
      comboEl.classList.add('active');
      let tier = 0;
      for (const tr of COMBO_TIERS) if (n >= tr.threshold) tier = Math.min(tr.tier, COMBO_CAP_TIER);
      setComboTier(tier);
    }
    function resetTypingCombo() {
      comboEl.classList.remove('active');
      setComboTier(0);
      comboNumEl.textContent = '0';
      comboLabelEl.textContent = I18N.t('combo.label');
    }
    // CPS readout pulse — bounces the "N cps" line per keystroke (imitates the click bounce).
    const comboCpsEl = comboEl.querySelector('.combo-cps');
    function pulseCps() {
      if (!comboCpsEl) return;
      comboCpsEl.classList.remove('cps-pulse');
      void comboCpsEl.offsetWidth;
      comboCpsEl.classList.add('cps-pulse');
    }
    // Typing countdown — chip clock hidden for now (redundant with the in-run
    // timing). Kept as a no-op stub so the engine's tick calls stay harmless and
    // re-enabling is a one-line change.
    const modeTimerEl = document.getElementById('mode-timer');
    function setTypingTimer(_text) {
      if (!modeTimerEl) return;
      modeTimerEl.textContent = '';
      modeTimerEl.hidden = true;
    }

    function fireComboEffect(effect, tier) {
      if (effect === 'pulse') {
        spawnComboRing();
      } else if (effect === 'confetti-sm') {
        spawnConfetti(28);
      } else if (effect === 'confetti-lg') {
        spawnConfetti(55);
      } else if (effect === 'finale') {
        comboLabelEl.textContent = I18N.t('combo.max');
        screenFlash();
        spawnConfetti(110);
        // Followup confetti waves for drama.
        setTimeout(() => spawnConfetti(80), 250);
        setTimeout(() => spawnConfetti(60), 600);
      } else if (effect === 'fireworks') {       // 250x
        comboLabelEl.textContent = I18N.t('combo.fire');
        screenFlash();
        spawnFireworks(3, 26);
        setTimeout(() => spawnFireworks(2, 22), 220);
      } else if (effect === 'fireworks-big') {   // 500x
        comboLabelEl.textContent = I18N.t('combo.insane');
        screenFlash();
        spawnConfetti(90);
        spawnFireworks(5, 30);
        setTimeout(() => spawnFireworks(4, 26), 200);
        setTimeout(() => spawnFireworks(3, 24), 480);
      } else if (effect === 'supernova') {       // 1000x
        comboLabelEl.textContent = I18N.t('combo.godlike');
        screenFlash();
        setTimeout(screenFlash, 300);
        spawnConfetti(140);
        spawnFireworks(7, 34);
        setTimeout(() => spawnFireworks(6, 32), 200);
        setTimeout(() => spawnFireworks(6, 30), 460);
        setTimeout(() => spawnFireworks(5, 28), 760);
      }
    }

    function spawnComboRing() {
      const ring = document.createElement('div');
      ring.className = 'combo-ring';
      comboContentEl.appendChild(ring);
      animate(ring, {
        scale: [0.4, 2.2],
        opacity: [0.9, 0],
        duration: 700,
        ease: 'outQuad',
        onComplete: () => ring.remove(),
      });
    }

    const CONFETTI_COLORS = ['#4dabf7', '#f4cb4d', '#ff5fa8', '#69db7c', '#da77f2', '#ffa94d', '#ffffff'];
    function spawnConfetti(count) {
      // Burst origin = combo display centre, so confetti looks like it shoots
      // out of the number itself.
      const r = comboEl.getBoundingClientRect();
      burstAt(document.getElementById('particles'), r.left + r.width / 2, r.top + r.height / 2, count);
    }

    // Fire `bursts` separate confetti explosions at random points across the
    // upper screen — high-tier combos fill the whole view instead of shooting
    // everything from the combo number. Staggered so they read as fireworks.
    function spawnFireworks(bursts, perBurst) {
      const container = document.getElementById('particles');
      for (let b = 0; b < bursts; b++) {
        const ox = window.innerWidth  * (0.12 + Math.random() * 0.76);
        const oy = window.innerHeight * (0.10 + Math.random() * 0.5);
        setTimeout(() => burstAt(container, ox, oy, perBurst), b * 80);
      }
    }

    function burstAt(container, cx, cy, count) {
      for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.className = 'confetti';
        const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
        p.style.left = cx + 'px';
        p.style.top = cy + 'px';
        p.style.background = color;
        p.style.transform = `rotate(${Math.random() * 360}deg)`;
        container.appendChild(p);
        // Burst outward then drop (gravity-ish via inQuad ease on the down phase).
        const angle = Math.random() * Math.PI * 2;
        const speed = 140 + Math.random() * 220;
        const dx = Math.cos(angle) * speed;
        const peakY = Math.sin(angle) * speed - 60;
        animate(p, {
          translateX: dx,
          translateY: [
            { to: peakY, duration: 380, ease: 'outQuad' },
            { to: peakY + 380 + Math.random() * 200, duration: 900, ease: 'inQuad' },
          ],
          rotate: '+=' + (Math.random() * 720 - 360),
          opacity: [{ to: 1, duration: 100 }, { to: 1, duration: 900 }, { to: 0, duration: 380 }],
          duration: 1380,
          onComplete: () => p.remove(),
        });
      }
    }

    function screenFlash() {
      const flash = document.createElement('div');
      flash.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,0.55);z-index:95;pointer-events:none;';
      document.body.appendChild(flash);
      animate(flash, {
        opacity: [0.55, 0],
        duration: 500,
        ease: 'outQuad',
        onComplete: () => flash.remove(),
      });
    }
    // -------------------------------------------------------------------------

    // --- Idle Text Bubble ---
    const IDLE_BUBBLE_DELAY_MS = 15000;
    const IDLE_BUBBLE_DURATION_MS = 5000;
    const TYPEWRITER_CHAR_MS = 45; // VN-style reveal speed
    const idleBubbleEl = document.getElementById('idle-bubble');
    const idleBubbleTextEl = document.getElementById('idle-bubble-text');
    let idleTimer = null;
    let bubbleHideTimer = null;
    let typewriterTimer = null;

    function stopTypewriter() {
      if (typewriterTimer) { clearTimeout(typewriterTimer); typewriterTimer = null; }
      idleBubbleEl.classList.remove('typing');
    }

    function startTypewriter(text) {
      stopTypewriter();
      idleBubbleEl.dataset.fullText = text;
      idleBubbleEl.setAttribute('aria-label', text);
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        idleBubbleTextEl.textContent = text;
        return;
      }
      idleBubbleTextEl.textContent = '';
      idleBubbleEl.classList.add('typing');
      let i = 0;
      const tick = () => {
        if (i < text.length) {
          idleBubbleTextEl.textContent += text.charAt(i++);
          typewriterTimer = setTimeout(tick, TYPEWRITER_CHAR_MS);
        } else {
          typewriterTimer = null;
          idleBubbleEl.classList.remove('typing');
        }
      };
      tick();
    }

    function hideBubble() {
      if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
      stopTypewriter();
      idleBubbleEl.hidden = true;
    }

    function showBubble() {
      const { character: ch } = getVariant(settings.skin);
      if (!ch.idleTexts || ch.idleTexts.length === 0) return;
      const text = ch.idleTexts[Math.floor(Math.random() * ch.idleTexts.length)];
      startTypewriter(text);
      idleBubbleEl.hidden = false;
      bubbleHideTimer = setTimeout(() => {
        hideBubble();
        scheduleIdleBubble();
      }, IDLE_BUBBLE_DURATION_MS);
    }

    function scheduleIdleBubble() {
      if (introActive) return; // only after intro ends
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(showBubble, IDLE_BUBBLE_DELAY_MS);
    }

    idleBubbleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      hideBubble();
      scheduleIdleBubble();
    });

    // Activity reset listeners.
    // Active input (pointerdown / keydown) dismisses any visible bubble and re-arms.
    // Mousemove is passive — it only re-arms, so a visible bubble stays readable while
    // the user glances at the mouse.
    let lastMouseReset = 0;
    function activeInputReset() {
      if (!idleBubbleEl.hidden) hideBubble();
      scheduleIdleBubble();
    }
    document.addEventListener('pointerdown', activeInputReset);
    document.addEventListener('keydown', activeInputReset);
    document.addEventListener('mousemove', () => {
      const now = Date.now();
      if (now - lastMouseReset < 500) return;
      lastMouseReset = now;
      scheduleIdleBubble();
    });

    window._idleBubbleReady = true;

    // --- Re-render dynamic strings on language change ------------------------
    // I18N.apply() handles every [data-i18n] node, but JS-rendered content
    // (skin list, Chart.js charts, the live combo label, sensei bar) has to
    // be rebuilt.
    window.addEventListener('i18nchange', () => {
      renderSkinList();
      renderSenseiBar();
      renderShopPanel();   // shop kicker/context is rendered from the active game mode
      // Combo label: apply() restored the static "COMBO!"; if a MAX COMBO! is
      // currently showing, keep that wording in the new language.
      if (comboEl.classList.contains('tier-' + COMBO_CAP_TIER)) {
        comboLabelEl.textContent = I18N.t('combo.max');
      }
      // Charts only need rebuilding if the modal is open — otherwise the next
      // open() will rebuild from scratch with current translations anyway.
      if (statsModal.classList.contains('open')) loadStats();
    });

    // --- Update detection -----------------------------------------------------
    // Polls the deployed index.html for the version string embedded in
    // `<div class="settings-version">vX.Y.Z</div>` (the same value the user
    // bumps on each release). When the remote version differs from the one
    // baked into this loaded page, surface a small modal and reload after a
    // short countdown so users on an idle tab pick up new builds.
    (() => {
      const versionEl = document.querySelector('.settings-version');
      const LOADED_VERSION = versionEl ? versionEl.textContent.trim() : '';
      if (!LOADED_VERSION) return;  // nothing to compare against

      const POLL_MS          = 90_000;
      const REFRESH_DELAY_MS = 5_000;
      const VERSION_RE       = /class="settings-version">\s*(v[^<\s]+)\s*</;
      let modalShown = false;
      let checking   = false;

      async function checkForUpdate() {
        if (modalShown || checking) return;
        checking = true;
        try {
          // Cache-busting query + no-store so a stale CDN/SW response can't
          // mask a fresh deploy. Same-origin, so no CORS concern.
          const res = await fetch('./?_v=' + Date.now(), { cache: 'no-store' });
          if (!res.ok) return;
          const text = await res.text();
          const m = text.match(VERSION_RE);
          if (!m) return;
          const remote = m[1].trim();
          if (remote && remote !== LOADED_VERSION) showUpdateModal(remote);
        } catch {
          // Offline or transient network error — retry on the next tick.
        } finally {
          checking = false;
        }
      }

      function showUpdateModal(remoteVersion) {
        if (modalShown) return;
        modalShown = true;

        const overlay = document.createElement('div');
        overlay.id = 'update-modal';
        overlay.innerHTML = `
          <div class="update-card" role="alertdialog" aria-live="polite">
            <div class="update-title">✨ Update available</div>
            <div class="update-body">${escapeHtml(LOADED_VERSION)} → ${escapeHtml(remoteVersion)}</div>
            <div class="update-countdown">Refreshing in <span id="update-countdown-n">${Math.ceil(REFRESH_DELAY_MS / 1000)}</span>s…</div>
            <button class="update-btn" id="update-refresh-now" type="button">Refresh now</button>
          </div>
        `;
        document.body.appendChild(overlay);

        const countdownEl = overlay.querySelector('#update-countdown-n');
        let remaining = Math.ceil(REFRESH_DELAY_MS / 1000);
        const tick = () => {
          remaining -= 1;
          if (countdownEl) countdownEl.textContent = String(Math.max(0, remaining));
          if (remaining <= 0) location.reload();
          else setTimeout(tick, 1000);
        };
        setTimeout(tick, 1000);

        overlay.querySelector('#update-refresh-now').addEventListener('click', () => location.reload());
      }

      // Early sweep at 30s catches users who landed on a CDN-cached HTML
      // that already trails the just-deployed version. Steady-state polling
      // takes over after that.
      setTimeout(checkForUpdate, 30_000);
      setInterval(checkForUpdate, POLL_MS);
      // Re-check the moment an idle tab comes back into focus — typical
      // scenario: developer pushes a build while the user is away.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
    })();

    // --- Typing game wiring ----------------------------------------------------
    // typing.js is a separate classic script loaded AFTER app.js. We publish the
    // host dependencies it needs on window; typing.js self-initialises from them
    // (it never reaches into app.js's lexical scope directly — the seam stays
    // explicit). Whichever script finishes second triggers init, so the
    // handshake is order-independent.
    window.__typingDeps = {
      db: db,
      getCurrentUser:    function () { return currentUser; },
      getUserShop:       function () { return userShop || {}; },
      getUserStats:      function () { return userStats || {}; },
      getSpendableCoins: function () { return shopAffordableCoins(); },
      typingCosts:       TYPING_MOD_COSTS,
      settings:          settings,
      saveSettings:      function () { saveSettings(settings); },
      creditTyping:      creditTyping,
      reactCharacter:    reactCharacter,
      recordKeyboard:    function () { recordClick('keyboard'); },
      setTypingActive:   setTypingActive,
      buyTypingMod:      buyTypingMod,
      buyTypingUpgrade:  buyTypingUpgrade,
      comboPowerLevel:   function () { return comboPowerLevelOf(userShop || {}); },
      casualComboCap:    function () { return casualComboCapOf(userShop || {}); },
      comboPowerCost:    comboPowerCost,
      casualCapCost:     casualCapCost,
      comboPowerMax:     COMBO_POWER_MAX,
      casualCapTiers:    CASUAL_CAP_TIERS,
      renderTypingCombo: renderTypingCombo,
      resetTypingCombo:  resetTypingCombo,
      pulseCps:          pulseCps,
      setTypingTimer:    setTypingTimer,
      t:                 function (k, p) { return I18N.t(k, p); },
      escapeHtml:        escapeHtml,
      flagFromCountry:   flagFromCountry,
      activityImg:       activityImg,
    };
    if (window.TypingGame && typeof window.TypingGame.init === 'function') {
      window.TypingGame.init(window.__typingDeps);
    }

    // --- VSRG (Rhythm) game wiring ---------------------------------------------
    // Same seam as typing.js: vsrg.js self-initialises from these host deps and
    // Shared hitsound engine (hitsound.js) — both rhythm modes call window.Hitsound.
    window.__hitsoundDeps = { settings: settings, saveSettings: function () { saveSettings(settings); } };
    if (window.Hitsound && typeof window.Hitsound.init === 'function') window.Hitsound.init(window.__hitsoundDeps);

    // never reaches into app.js's scope. BGM is paused for the duration of a run
    // (it would compete with the chart's music) and restored on exit.
    window.__vsrgDeps = {
      settings:    settings,
      saveSettings: function () { saveSettings(settings); },
      // While the rhythm panel is open it owns the keyboard — suppress the global
      // keydown clicker handler (same isTypingActive gate the typing panel uses)
      // so lane keys don't trigger the character behind the overlay.
      captureKeyboard: function (on) { setTypingActive(!!on); },
      pauseBgm:    function () { try { bgm.pause(); bgmPlaying = false; } catch (e) {} },
      resumeBgm:   function () {
        try { if ((settings.musicVol || 0) > 0) { bgm.play().then(function(){ bgmPlaying = true; }).catch(function(){}); } } catch (e) {}
      },
      t:           function (k, p) { return I18N.t(k, p); },
      escapeHtml:  escapeHtml,
    };
    if (window.VsrgGame && typeof window.VsrgGame.init === 'function') {
      window.VsrgGame.init(window.__vsrgDeps);
    }

    // --- osu!standard wiring (same seam; reuses VSRG's settings/deps shape) -----
    window.__osustdDeps = {
      settings:    settings,
      saveSettings: function () { saveSettings(settings); },
      captureKeyboard: function (on) { setTypingActive(!!on); },
      pauseBgm:    function () { try { bgm.pause(); bgmPlaying = false; } catch (e) {} },
      resumeBgm:   function () {
        try { if ((settings.musicVol || 0) > 0) { bgm.play().then(function(){ bgmPlaying = true; }).catch(function(){}); } } catch (e) {}
      },
      t:           function (k, p) { return I18N.t(k, p); },
      escapeHtml:  escapeHtml,
    };
    if (window.OsuStdGame && typeof window.OsuStdGame.init === 'function') {
      window.OsuStdGame.init(window.__osustdDeps);
    }

    // --- Fishing mode wiring ------------------------------------------------
    window.__fishingDeps = {
      settings: settings,
      saveSettings: function () { saveSettings(settings); },
      t: function (k, p) { return I18N.t(k, p); },
      escapeHtml: escapeHtml,
      captureKeyboard: function (on) { setTypingActive(!!on); },
      pauseBgm: function () { try { bgm.pause(); bgmPlaying = false; } catch (e) {} },
      resumeBgm: function () { try { if ((settings.musicVol || 0) > 0) { bgm.play().then(function(){ bgmPlaying = true; }).catch(function(){}); } } catch (e) {} },
      getVariant: function (id) { return getVariant(id); },
      getSkin: function () { return settings.skin; },
      playSfx: function () { try { if (typeof playsfx === 'function') playsfx(); } catch (e) {} },
      getFishdex: function () { return (userStats && userStats.fishdex) || {}; },
      getSpecimens: function () { return (userStats && userStats.aquariumSpecimens) || []; },
      recordCatch: function (specimen, coins, isNew) { recordCatch(specimen, coins, isNew); },
    };
    if (window.FishingGame && typeof window.FishingGame.init === 'function') {
      window.FishingGame.init(window.__fishingDeps);
    }

    // --- Project Diva wiring (same seam; reuses the rhythm deps shape) ----------
    window.__divaftDeps = {
      settings:    settings,
      saveSettings: function () { saveSettings(settings); },
      captureKeyboard: function (on) { setTypingActive(!!on); },
      pauseBgm:    function () { try { bgm.pause(); bgmPlaying = false; } catch (e) {} },
      resumeBgm:   function () {
        try { if ((settings.musicVol || 0) > 0) { bgm.play().then(function(){ bgmPlaying = true; }).catch(function(){}); } } catch (e) {}
      },
      t:           function (k, p) { return I18N.t(k, p); },
      escapeHtml:  escapeHtml,
    };
    if (window.DivaGame && typeof window.DivaGame.init === 'function') {
      window.DivaGame.init(window.__divaftDeps);
    }

    // --- Persistent shop launcher and game-library mode integration ---
    const modeMenuEl      = document.getElementById('mode-menu');
    const modeChipEl      = document.getElementById('mode-chip');
    const modeChipLabelEl = document.getElementById('mode-chip-label');
    function renderModeMenu() {
      document.body.dataset.gameMode = settings.gameMode || 'clicker';
      if (modeChipLabelEl) modeChipLabelEl.textContent = I18N.t('shop.title');
      if (modeChipEl) {
        modeChipEl.setAttribute('aria-haspopup', 'dialog');
        modeChipEl.setAttribute('aria-controls', 'shop-panel');
      }
    }
    function closeModePop() {
      if (modeMenuEl) modeMenuEl.classList.remove('open');
      if (modeChipEl) modeChipEl.setAttribute('aria-expanded', 'false');
    }
    function applyMode(mode, sub) {
      // 'rhythm' is an umbrella over the two rhythm sub-modes (osu standard / vsrg
      // mania); resolve it to the concrete gameMode the panels understand. A direct
      // 'vsrg'/'osu' selection also records which rhythm sub-mode is active.
      if (mode === 'rhythm') mode = (settings.rhythmSubMode === 'mania') ? 'vsrg' : (settings.rhythmSubMode === 'diva') ? 'diva' : 'osu';
      else if (mode === 'vsrg') settings.rhythmSubMode = 'mania';
      else if (mode === 'osu') settings.rhythmSubMode = 'standard';
      else if (mode === 'diva') settings.rhythmSubMode = 'diva';
      settings.gameMode = (mode === 'typing' || mode === 'vsrg' || mode === 'osu' || mode === 'diva' || mode === 'fishing') ? mode : 'clicker';
      // Close whichever mode panel is not the newly-selected one. Each close()
      // only resets gameMode when it still owns it, so setting gameMode first
      // keeps these from stomping the new selection.
      if (settings.gameMode !== 'typing' && window.TypingGame && window.TypingGame.close) window.TypingGame.close();
      if (settings.gameMode !== 'vsrg' && window.VsrgGame && window.VsrgGame.close) window.VsrgGame.close();
      if (settings.gameMode !== 'osu' && window.OsuStdGame && window.OsuStdGame.close) window.OsuStdGame.close();
      if (settings.gameMode !== 'fishing' && window.FishingGame && window.FishingGame.close) window.FishingGame.close();
      if (settings.gameMode !== 'diva' && window.DivaGame && window.DivaGame.close) window.DivaGame.close();
      if (settings.gameMode === 'typing') {
        if (sub && window.TypingGame && window.TypingGame.setSubMode) window.TypingGame.setSubMode(sub);
        else saveSettings(settings);
        if (window.TypingGame && window.TypingGame.open) window.TypingGame.open();
        if (window.TypingGame && window.TypingGame.refreshKeyboardPanel) window.TypingGame.refreshKeyboardPanel();
      } else if (settings.gameMode === 'vsrg') {
        saveSettings(settings);
        if (window.VsrgGame && window.VsrgGame.open) window.VsrgGame.open();
      } else if (settings.gameMode === 'osu') {
        saveSettings(settings);
        if (window.OsuStdGame && window.OsuStdGame.open) window.OsuStdGame.open();
      } else if (settings.gameMode === 'fishing') {
        saveSettings(settings);
        if (window.FishingGame && window.FishingGame.open) window.FishingGame.open();
      } else if (settings.gameMode === 'diva') {
        saveSettings(settings);
        if (window.DivaGame && window.DivaGame.open) window.DivaGame.open();
      } else {
        saveSettings(settings);
      }
      renderModeMenu();
      syncMusicMode();    // pause/restore the clicker background for music-game modes
    }
    window.addEventListener('aobinglaunch', (event) => {
      const mode = typeof event.detail === 'string' ? event.detail : event.detail?.mode;
      const sub = event.detail?.submode;
      if (!['clicker', 'typing', 'fishing', 'osu', 'vsrg', 'diva'].includes(mode)) return;
      applyMode(mode, sub === 'ranked' || sub === 'casual' ? sub : settings.typingSubMode || 'casual');
      closeModePop();
    });
    if (modeMenuEl) {
      if (modeChipEl) modeChipEl.addEventListener('click', (e) => {
        e.stopPropagation();
        closeModePop();
        shopBtn.click();
      });
      // The shop now has its own library-style window and navigation button.
      if (typeof renderShopPanel === 'function') renderShopPanel();
      renderModeMenu();
      window.addEventListener('i18nchange', renderModeMenu);
      window.addEventListener('gamemodechange', renderModeMenu);
    }
    // Music-game performance mode: while a rhythm panel is open it fully covers the
    // screen (opaque overlay), so freeze the clicker background underneath — stop its
    // auto-click timers and coin floaters and hide its animated visuals (CSS, below).
    // This keeps weak machines from rendering work that isn't even visible.
    //
    // Idle income is NOT lost: instead of ticking the auto-clicker many times per
    // second (the expensive part), we record when music mode began + the per-tick
    // rate, then credit the whole elapsed span in ONE batch on exit (and on tab-hide).
    // Same coins the timer would have produced, at zero per-frame cost during play.
    function creditAutoBatch(ticks) {
      if (ticks <= 0) return;
      const m = shopMul(Date.now());
      pending.userCoins += Math.floor(m.coin) * ticks;
      if (m.lbAuto) {   // leaderboard-auto unlocked: batch the same click stats recordClick('auto') would add
        const clickGain = Math.floor(m.click) * ticks;
        if (clickGain > 0) {
          const { character: ch, variant: v } = getVariant(settings.skin);
          pending.userClicks += clickGain; pending.global += clickGain; pending.daily += clickGain;
          if (visitorCountry) pending.byCountry[visitorCountry] = (pending.byCountry[visitorCountry] || 0) + clickGain;
          pending.bySkin[v.id]         = (pending.bySkin[v.id]         || 0) + clickGain;
          pending.byCharacter[ch.id]   = (pending.byCharacter[ch.id]   || 0) + clickGain;
          pending.allTimeSkin[v.id]    = (pending.allTimeSkin[v.id]    || 0) + clickGain;
          pending.bySource['auto']     = (pending.bySource['auto']     || 0) + clickGain;
          pending.userBySource['auto'] = (pending.userBySource['auto'] || 0) + clickGain;
          sessionClicks += clickGain;
        }
      }
      savePendingDeferred(); scheduleFlush(); scheduleOptimisticRender();
    }
    function beginMusicIdle() {
      const cps = currentAutoCps();
      musicIdlePeriodMs = cps > 0 ? Math.max(AUTO_PERIOD_MS_FLOOR, 1000 / cps) : 0;   // 0 = no auto-clicker, nothing to accrue
      musicIdleStart = performance.now();
    }
    function bankMusicIdle() {
      if (!musicIdlePeriodMs) return;
      const ticks = Math.floor((performance.now() - musicIdleStart) / musicIdlePeriodMs);
      if (ticks > 0) { creditAutoBatch(ticks); musicIdleStart += ticks * musicIdlePeriodMs; }   // keep the sub-tick remainder
    }
    function setMusicMode(on) {
      on = !!on;
      if (on === musicModeOn) return;
      musicModeOn = on;
      document.body.classList.toggle('music-mode', on);
      if (on) {
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        stopAutoCoinFloater();
        beginMusicIdle();   // start accruing idle income (credited in a batch on exit)
      } else {
        bankMusicIdle();    // credit everything earned while the game had the CPU
        rearmAutoLoop();    // resume the live auto-click timer + coin floater
      }
    }
    function syncMusicMode() { setMusicMode(settings.gameMode === 'vsrg' || settings.gameMode === 'osu'); }
    window.addEventListener('gamemodechange', syncMusicMode);
    syncMusicMode();   // set the initial state to match the restored gameMode
    window.__aobingAppReady = true;

