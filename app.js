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
      firebase.auth().signInWithCustomToken(window.__ACTIVITY__.customToken)
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
    // Lightweight built-in. translations[lang][key] = string. {var} placeholders
    // are interpolated by t(). data-i18n="key" updates textContent; data-i18n-attr
    // takes "attr:key" pairs (comma-separated) to update HTML attributes.
    const I18N = (() => {
      const SUPPORTED = ['en','ja','ko','zh-Hans','zh-Hant','th','vi','ar'];
      const NATIVE = {
        'en':'English','ja':'日本語','ko':'한국어','zh-Hans':'简体中文','zh-Hant':'繁體中文','th':'ไทย','vi':'Tiếng Việt','ar':'العربية'
      };
      const T = {
        en: {
          'settings.title':'Settings','settings.music':'Music','settings.sfx':'SFX','settings.effects':'Effects',
          'settings.language':'Language','settings.join_discord':'Join Discord','settings.follow_x':'Follow me on X','settings.keyboard_clicks':'Keyboard clicks','settings.raw_cps':'Show raw CPS','settings.auto_clicker':'Auto-clicker','settings.reset_defaults':'Reset defaults',
          'skins.title':'Skins','skins.variants':'{n} variants','skins.variant':'{n} variant',
          'sensei.trainer':'Trainer',
          'auth.sign_in_google':'Sign in with Google','auth.sign_out':'Sign out',
          'auth.already_linked':'This Google account is already linked to another player. Signing you in to that one instead.',
          'profile.title':'Profile',
          'profile.anon_blurb':'Sign in to save your progress across devices and appear on the leaderboard.',
          'profile.display_name':'Display name','profile.country':'Country','profile.save':'Save',
          'profile.name_length_error':'Display name must be 1-24 characters.',
          'profile.country_change_to':'Change to {flag} {code}',
          'leaderboard.title':'Leaderboard',
          'leaderboard.info_banner':"Only mouse and tap clicks count toward your rank. Keyboard mashing is fun, but it's not on the board.",
          'leaderboard.sign_in_cta':'Sign in to join the leaderboard →',
          'leaderboard.your_rank':'Your rank: #{rank} of {total} players',
          'leaderboard.your_rank_outside':'Your rank: #{rank} (not in top 100)',
          'leaderboard.no_rank_yet':'Click to start climbing the board!',
          'shop.title':'Shop',
          'shop.permanent':'Permanent',
          'shop.auto':'Auto',
          'shop.buffs':'Buffs (60s)',
          'shop.item.coinMul.name':'Coin Multiplier',
          'shop.item.coinMul.desc':'+50% coins per click',
          'shop.item.clickMul.name':'Click Multiplier',
          'shop.item.clickMul.desc':'+50% clicks per click',
          'shop.item.autoLevel.name':'Auto-Clicker',
          'shop.item.autoLevel.desc':'+0.5 auto-clicks per second',
          'shop.item.leaderboardAuto.name':'Leaderboard Auto',
          'shop.item.leaderboardAuto.desc':'Auto-clicks count toward your rank',
          'shop.item.buffCoins.name':'×2 coins',
          'shop.item.buffClicks.name':'×2 clicks',
          'shop.item.buffAutoRate.name':'×2 auto-rate',
          'shop.atMax':'MAX',
          'shop.owned':'Owned',
          'shop.error.notEnough':'Not enough coins',
          'shop.prestige.title':'Prestige',
          'shop.prestige.name':'Prestige',
          'shop.prestige.locked':'Reach Lv {n} on any upgrade to unlock',
          'shop.prestige.cta':'Reset',
          'shop.prestige.coinsLabel':'coins',
          'shop.prestige.permanent':'(permanent)',
          'shop.prestige.confirm':'Reset all shop levels and coin balance to gain ★{n}? Your lifetime clicks and prestige stars are preserved.',
          'bond.title':'Bond',
          'bond.cta':'Bond',
          'bond.button':'Bond — reset level for +10% coins permanent',
          'bond.confirm':'Bond with {name}? Resets the visible level back to 0 and adds ♥{n}. Permanent +10% coins when using this skin.',
          'bond.count':'♥{n} bond level',
          'settings.admin_mode':'Admin mode',
          'admin.banner':'Admin mode is ON. Use × to hide a row, ↺ to unhide. Hidden rows are dimmed.',
          'admin.delete_row':'Hide from leaderboard',
          'admin.confirm_delete':'Hide "{name}" from the leaderboard?',
          'admin.hide_row':'Hide from leaderboard',
          'admin.show_row':'Unhide row',
          'tag.default':'Default','tag.plushie':'Plushie','tag.track':'Track','tag.idol':'Idol','tag.swimsuit':'Swimsuit',
          'character.aoba.name':'Aoba','character.mari.name':'Mari','character.miyu.name':'Miyu',
          'skin.aoba.name':'Aoba','skin.aobaplush.name':'Aoba Plush',
          'skin.mari.name':'Mari','skin.maritrack.name':'Track Mari','skin.mariidol.name':'Idol Mari',
          'skin.miyu.name':'Miyu','skin.miyuswim.name':'Miyu Swimsuit',
          'analytics.title':'Analytics',
          'stats.preset.today':'Today','stats.preset.7d':'7d','stats.preset.30d':'30d','stats.preset.all':'All time',
          'stats.tile.clicks_today':'Clicks today','stats.tile.clicks':'Clicks',
          'stats.tile.visitors_today':'Visitors today','stats.tile.visitors':'Visitors',
          'stats.tile.cpv':'Clicks per visitor',
          'stats.tile.max_combo_today':'Max combo today','stats.tile.max_combo':'Max combo',
          'stats.chart.clicks_over_time':'Clicks over time','stats.chart.visitors_over_time':'Visitors over time',
          'stats.chart.top_countries':'Top countries','stats.chart.characters_used':'Characters used',
          'stats.chart.skins_per_character':'Skins per character',
          'stats.chart.click_sources':'Click sources',
          'stats.source.mouse':'Mouse / Tap',
          'stats.source.keyboard':'Keyboard',
          'stats.source.auto':'Auto-click',
          'stats.no_data':'No data',
          'stats.range.today':'today','stats.range.last_7_days':'last 7 days',
          'stats.range.last_30_days':'last 30 days','stats.range.all_time':'all time',
          'combo.label':'COMBO!','combo.max':'MAX COMBO!','combo.fire':'ON FIRE!','combo.insane':'INSANE!!','combo.godlike':'GODLIKE!!!',
          'tooltip.click_counter':'Global clicks | Current skin clicks',
          'disclaimer':'Aobing.it is not affiliated with Nexon, Nexon Games or Yostar. All game artwork, information and assets used are the property and copyright of the respective authors.',
          'meta.description':'Click to make Aoba squeak!',
          'alt.character':'Character','aria.close':'Close',
          'typing.title':'Typing',
          'typing.stop':'Stop',
          'typing.modifiers':'Modifiers',
          'typing.boards':'Leaderboards',
          'typing.board_words':'Words','typing.board_wpm':'WPM',
          'typing.words':'words','typing.wpm':'WPM','typing.accuracy':'accuracy',
          'typing.ranked':'Ranked','typing.casual':'Casual',
          'typing.mod.freedom':'Freedom mode','typing.mod.nobackspace':'No backspace',
          'typing.mod.stoponerror':'Stop on error','typing.mod.qol':'QoL pack (live WPM)',
          'typing.toggle.on_word':'Bounce on word','typing.toggle.per_key':'Bounce on each key',
          'typing.loading':'Loading…','typing.board_empty':'No entries yet','typing.board_error':'Could not load board',
        },
        ja: {
          'typing.title':'タイピング','typing.stop':'停止','typing.modifiers':'モディファイア','typing.boards':'ランキング',
          'typing.board_words':'単語数','typing.board_wpm':'WPM','typing.words':'単語','typing.wpm':'WPM','typing.accuracy':'正確率',
          'typing.ranked':'ランク','typing.casual':'カジュアル','typing.mod.freedom':'フリーダムモード','typing.mod.nobackspace':'バックスペース無効',
          'typing.mod.stoponerror':'エラーで停止','typing.mod.qol':'QoLパック（リアルタイムWPM）','typing.toggle.on_word':'単語ごとにバウンス','typing.toggle.per_key':'キーごとにバウンス',
          'typing.loading':'読み込み中…','typing.board_empty':'まだ記録がありません','typing.board_error':'ボードを読み込めませんでした',
          'settings.title':'設定','settings.music':'音楽','settings.sfx':'効果音','settings.effects':'エフェクト',
          'settings.language':'言語','settings.join_discord':'Discordに参加','settings.follow_x':'Xでフォロー','settings.keyboard_clicks':'キーボードクリック','settings.raw_cps':'生CPSを表示','settings.auto_clicker':'オートクリッカー','settings.reset_defaults':'デフォルトに戻す',
          'skins.title':'スキン','skins.variants':'{n}種','skins.variant':'{n}種',
          'tag.default':'デフォルト','tag.plushie':'ぬいぐるみ','tag.track':'体操服','tag.idol':'アイドル','tag.swimsuit':'水着',
          'character.aoba.name':'アオバ','character.mari.name':'マリー','character.miyu.name':'ミユ',
          'skin.aoba.name':'アオバ','skin.aobaplush.name':'アオバ ぬいぐるみ',
          'skin.mari.name':'マリー','skin.maritrack.name':'体操服マリー','skin.mariidol.name':'アイドル マリー',
          'skin.miyu.name':'ミユ','skin.miyuswim.name':'水着ミユ',
          'analytics.title':'アナリティクス',
          'stats.preset.today':'今日','stats.preset.7d':'7日','stats.preset.30d':'30日','stats.preset.all':'全期間',
          'stats.tile.clicks_today':'今日のクリック','stats.tile.clicks':'クリック',
          'stats.tile.visitors_today':'今日の訪問者','stats.tile.visitors':'訪問者',
          'stats.tile.cpv':'訪問者あたりのクリック',
          'stats.tile.max_combo_today':'今日の最大コンボ','stats.tile.max_combo':'最大コンボ',
          'stats.chart.clicks_over_time':'クリック推移','stats.chart.visitors_over_time':'訪問者推移',
          'stats.chart.top_countries':'国別ランキング','stats.chart.characters_used':'使用キャラクター',
          'stats.chart.skins_per_character':'キャラクター別スキン',
          'stats.chart.click_sources':'クリックソース',
          'stats.source.mouse':'マウス / タップ',
          'stats.source.keyboard':'キーボード',
          'stats.source.auto':'自動クリック',
          'stats.no_data':'データなし',
          'stats.range.today':'今日','stats.range.last_7_days':'直近7日',
          'stats.range.last_30_days':'直近30日','stats.range.all_time':'全期間',
          'combo.label':'コンボ!','combo.max':'マックスコンボ!','combo.fire':'ヒートアップ!','combo.insane':'クレイジー!!','combo.godlike':'ゴッドライク!!!',
          'tooltip.click_counter':'全体クリック | 現在のスキンクリック',
          'disclaimer':'Aobing.itはNexon、Nexon Games、Yostarとは無関係です。使用されているすべてのゲームアートワーク、情報、アセットはそれぞれの著作者の所有物および著作権物です。',
          'meta.description':'クリックでアオバが鳴く!',
          'alt.character':'キャラクター','aria.close':'閉じる',
          'sensei.trainer':'先生',
          'auth.sign_in_google':'Googleでログイン','auth.sign_out':'ログアウト',
          'auth.already_linked':'このGoogleアカウントは別のプレイヤーにすでに連携されています。そちらでログインします。',
          'profile.title':'プロフィール',
          'profile.anon_blurb':'ログインすると進行状況がデバイス間で保存され、リーダーボードに表示されます。',
          'profile.display_name':'表示名','profile.country':'国','profile.save':'保存',
          'profile.name_length_error':'表示名は1〜24文字で入力してください。',
          'profile.country_change_to':'{flag} {code} に変更',
          'leaderboard.title':'リーダーボード',
          'leaderboard.info_banner':'マウス/タップのクリックだけがランクに反映されます。キーボード連打は楽しいですが、ランキング対象外です。',
          'leaderboard.sign_in_cta':'ログインしてリーダーボードに参加 →',
          'leaderboard.your_rank':'あなたの順位: #{rank} / {total} 人',
          'leaderboard.your_rank_outside':'あなたの順位: #{rank} (トップ100圏外)',
          'leaderboard.no_rank_yet':'クリックしてランキングを駆け上がろう!',
          'shop.title':'ショップ',
          'shop.permanent':'永続',
          'shop.auto':'オート',
          'shop.buffs':'バフ (60秒)',
          'shop.item.coinMul.name':'コイン倍率',
          'shop.item.coinMul.desc':'クリックあたりのコイン +50%',
          'shop.item.clickMul.name':'クリック倍率',
          'shop.item.clickMul.desc':'クリックあたりのクリック数 +50%',
          'shop.item.autoLevel.name':'オートクリッカー',
          'shop.item.autoLevel.desc':'毎秒の自動クリック +0.5',
          'shop.item.leaderboardAuto.name':'ランキング オート',
          'shop.item.leaderboardAuto.desc':'オートクリックがランキングに反映されます',
          'shop.item.buffCoins.name':'×2 コイン',
          'shop.item.buffClicks.name':'×2 クリック',
          'shop.item.buffAutoRate.name':'×2 オート速度',
          'shop.atMax':'最大',
          'shop.owned':'購入済み',
          'shop.error.notEnough':'コインが足りません',
          'shop.prestige.title':'プレステージ',
          'shop.prestige.name':'プレステージ',
          'shop.prestige.locked':'いずれかのアップグレードでLv {n}に到達するとアンロック',
          'shop.prestige.cta':'リセット',
          'shop.prestige.coinsLabel':'コイン',
          'shop.prestige.permanent':'(永続)',
          'shop.prestige.confirm':'すべてのショップレベルとコイン残高をリセットして★{n}を獲得しますか?累計クリックとプレステージスターは保持されます。',
        },
        ko: {
          'typing.title':'타이핑','typing.stop':'중지','typing.modifiers':'모디파이어','typing.boards':'리더보드',
          'typing.board_words':'단어 수','typing.board_wpm':'WPM','typing.words':'단어','typing.wpm':'WPM','typing.accuracy':'정확도',
          'typing.ranked':'랭크','typing.casual':'캐주얼','typing.mod.freedom':'프리덤 모드','typing.mod.nobackspace':'백스페이스 비활성화',
          'typing.mod.stoponerror':'오류 시 정지','typing.mod.qol':'QoL 팩 (실시간 WPM)','typing.toggle.on_word':'단어마다 바운스','typing.toggle.per_key':'키마다 바운스',
          'typing.loading':'불러오는 중…','typing.board_empty':'아직 기록이 없습니다','typing.board_error':'보드를 불러올 수 없습니다',
          'settings.title':'설정','settings.music':'음악','settings.sfx':'효과음','settings.effects':'이펙트',
          'settings.language':'언어','settings.join_discord':'디스코드 참여','settings.follow_x':'X에서 팔로우','settings.keyboard_clicks':'키보드 클릭','settings.raw_cps':'원시 CPS 표시','settings.auto_clicker':'자동 클리커','settings.reset_defaults':'기본값 복원',
          'skins.title':'스킨','skins.variants':'{n}개','skins.variant':'{n}개',
          'tag.default':'기본','tag.plushie':'인형','tag.track':'체육복','tag.idol':'아이돌','tag.swimsuit':'수영복',
          'character.aoba.name':'아오바','character.mari.name':'마리','character.miyu.name':'미유',
          'skin.aoba.name':'아오바','skin.aobaplush.name':'아오바 인형',
          'skin.mari.name':'마리','skin.maritrack.name':'체육복 마리','skin.mariidol.name':'아이돌 마리',
          'skin.miyu.name':'미유','skin.miyuswim.name':'수영복 미유',
          'analytics.title':'분석',
          'stats.preset.today':'오늘','stats.preset.7d':'7일','stats.preset.30d':'30일','stats.preset.all':'전체',
          'stats.tile.clicks_today':'오늘 클릭','stats.tile.clicks':'클릭',
          'stats.tile.visitors_today':'오늘 방문자','stats.tile.visitors':'방문자',
          'stats.tile.cpv':'방문자당 클릭',
          'stats.tile.max_combo_today':'오늘 최고 콤보','stats.tile.max_combo':'최고 콤보',
          'stats.chart.clicks_over_time':'시간대별 클릭','stats.chart.visitors_over_time':'시간대별 방문자',
          'stats.chart.top_countries':'상위 국가','stats.chart.characters_used':'사용 캐릭터',
          'stats.chart.skins_per_character':'캐릭터별 스킨',
          'stats.chart.click_sources':'클릭 소스',
          'stats.source.mouse':'마우스 / 탭',
          'stats.source.keyboard':'키보드',
          'stats.source.auto':'자동 클릭',
          'stats.no_data':'데이터 없음',
          'stats.range.today':'오늘','stats.range.last_7_days':'최근 7일',
          'stats.range.last_30_days':'최근 30일','stats.range.all_time':'전체 기간',
          'combo.label':'콤보!','combo.max':'최대 콤보!','combo.fire':'불타오른다!','combo.insane':'미쳤다!!','combo.godlike':'갓라이크!!!',
          'tooltip.click_counter':'전체 클릭 | 현재 스킨 클릭',
          'disclaimer':'Aobing.it은 Nexon, Nexon Games 또는 Yostar와 관련이 없습니다. 사용된 모든 게임 아트워크, 정보 및 자료의 소유권과 저작권은 각 저작자에게 있습니다.',
          'meta.description':'클릭해서 아오바를 울려보세요!',
          'alt.character':'캐릭터','aria.close':'닫기',
          'sensei.trainer':'선생',
          'auth.sign_in_google':'Google로 로그인','auth.sign_out':'로그아웃',
          'auth.already_linked':'이 Google 계정은 다른 플레이어에 이미 연결되어 있습니다. 해당 계정으로 로그인합니다.',
          'profile.title':'프로필',
          'profile.anon_blurb':'로그인하면 진행 상황이 기기 간 저장되고 리더보드에 표시됩니다.',
          'profile.display_name':'표시 이름','profile.country':'국가','profile.save':'저장',
          'profile.name_length_error':'표시 이름은 1~24자여야 합니다.',
          'profile.country_change_to':'{flag} {code} 로 변경',
          'leaderboard.title':'리더보드',
          'leaderboard.info_banner':'마우스/탭 클릭만 순위에 반영됩니다. 키보드 연타는 재미있지만 순위에는 들어가지 않습니다.',
          'leaderboard.sign_in_cta':'로그인해서 리더보드에 참여하기 →',
          'leaderboard.your_rank':'내 순위: #{rank} / 총 {total}명',
          'leaderboard.your_rank_outside':'내 순위: #{rank} (TOP 100 밖)',
          'leaderboard.no_rank_yet':'클릭해서 순위를 올려보세요!',
          'shop.title':'상점',
          'shop.permanent':'영구',
          'shop.auto':'자동',
          'shop.buffs':'버프 (60초)',
          'shop.item.coinMul.name':'코인 배수',
          'shop.item.coinMul.desc':'클릭당 코인 +50%',
          'shop.item.clickMul.name':'클릭 배수',
          'shop.item.clickMul.desc':'클릭당 클릭 수 +50%',
          'shop.item.autoLevel.name':'자동 클리커',
          'shop.item.autoLevel.desc':'초당 자동 클릭 +0.5',
          'shop.item.leaderboardAuto.name':'리더보드 자동',
          'shop.item.leaderboardAuto.desc':'자동 클릭이 순위에 반영됩니다',
          'shop.item.buffCoins.name':'×2 코인',
          'shop.item.buffClicks.name':'×2 클릭',
          'shop.item.buffAutoRate.name':'×2 자동 속도',
          'shop.atMax':'최대',
          'shop.owned':'소유 중',
          'shop.error.notEnough':'코인이 부족합니다',
          'shop.prestige.title':'프레스티지',
          'shop.prestige.name':'프레스티지',
          'shop.prestige.locked':'아무 업그레이드를 Lv {n}까지 올려 잠금 해제',
          'shop.prestige.cta':'리셋',
          'shop.prestige.coinsLabel':'코인',
          'shop.prestige.permanent':'(영구)',
          'shop.prestige.confirm':'모든 상점 레벨과 코인 잔액을 리셋하고 ★{n}을(를) 획득하시겠습니까? 누적 클릭과 프레스티지 스타는 유지됩니다.',
        },
        'zh-Hans': {
          'typing.title':'打字','typing.stop':'停止','typing.modifiers':'修饰器','typing.boards':'排行榜',
          'typing.board_words':'单词数','typing.board_wpm':'WPM','typing.words':'单词','typing.wpm':'WPM','typing.accuracy':'准确率',
          'typing.ranked':'排位','typing.casual':'休闲','typing.mod.freedom':'自由模式','typing.mod.nobackspace':'禁用退格',
          'typing.mod.stoponerror':'出错暂停','typing.mod.qol':'QoL 包（实时 WPM）','typing.toggle.on_word':'完成单词时弹跳','typing.toggle.per_key':'每次按键弹跳',
          'typing.loading':'加载中…','typing.board_empty':'暂无记录','typing.board_error':'无法加载排行榜',
          'settings.title':'设置','settings.music':'音乐','settings.sfx':'音效','settings.effects':'特效',
          'settings.language':'语言','settings.join_discord':'加入 Discord','settings.follow_x':'在 X 上关注我','settings.keyboard_clicks':'键盘点击','settings.raw_cps':'显示原始 CPS','settings.auto_clicker':'自动点击器','settings.reset_defaults':'恢复默认',
          'skins.title':'皮肤','skins.variants':'{n} 款','skins.variant':'{n} 款',
          'tag.default':'默认','tag.plushie':'玩偶','tag.track':'体操服','tag.idol':'偶像','tag.swimsuit':'泳装',
          'character.aoba.name':'青叶','character.mari.name':'玛丽','character.miyu.name':'美游',
          'skin.aoba.name':'青叶','skin.aobaplush.name':'青叶玩偶',
          'skin.mari.name':'玛丽','skin.maritrack.name':'体操服玛丽','skin.mariidol.name':'偶像玛丽',
          'skin.miyu.name':'美游','skin.miyuswim.name':'泳装美游',
          'analytics.title':'数据分析',
          'stats.preset.today':'今日','stats.preset.7d':'7天','stats.preset.30d':'30天','stats.preset.all':'全部',
          'stats.tile.clicks_today':'今日点击','stats.tile.clicks':'点击',
          'stats.tile.visitors_today':'今日访客','stats.tile.visitors':'访客',
          'stats.tile.cpv':'每访客点击数',
          'stats.tile.max_combo_today':'今日最高连击','stats.tile.max_combo':'最高连击',
          'stats.chart.clicks_over_time':'点击趋势','stats.chart.visitors_over_time':'访客趋势',
          'stats.chart.top_countries':'国家排行','stats.chart.characters_used':'使用角色',
          'stats.chart.skins_per_character':'角色皮肤分布',
          'stats.chart.click_sources':'点击来源',
          'stats.source.mouse':'鼠标 / 触摸',
          'stats.source.keyboard':'键盘',
          'stats.source.auto':'自动点击',
          'stats.no_data':'暂无数据',
          'stats.range.today':'今日','stats.range.last_7_days':'近 7 天',
          'stats.range.last_30_days':'近 30 天','stats.range.all_time':'全部时间',
          'combo.label':'连击!','combo.max':'极限连击!','combo.fire':'火力全开!','combo.insane':'疯狂!!','combo.godlike':'神之连击!!!',
          'tooltip.click_counter':'全球点击 | 当前皮肤点击',
          'disclaimer':'Aobing.it 与 Nexon、Nexon Games 及 Yostar 无任何关联。所使用的全部游戏美术、信息和资源版权归各自作者所有。',
          'meta.description':'点击让青叶发出叫声!',
          'alt.character':'角色','aria.close':'关闭',
          'sensei.trainer':'老师',
          'auth.sign_in_google':'使用 Google 登录','auth.sign_out':'退出登录',
          'auth.already_linked':'此 Google 账号已与其他玩家关联。将使用该账号登录。',
          'profile.title':'个人资料',
          'profile.anon_blurb':'登录后可跨设备保存进度并出现在排行榜上。',
          'profile.display_name':'显示名称','profile.country':'国家','profile.save':'保存',
          'profile.name_length_error':'显示名称需为 1–24 个字符。',
          'profile.country_change_to':'更改为 {flag} {code}',
          'leaderboard.title':'排行榜',
          'leaderboard.info_banner':'只有鼠标/点击计入排名。键盘连按很有趣,但不计入榜单。',
          'leaderboard.sign_in_cta':'登录加入排行榜 →',
          'leaderboard.your_rank':'你的排名: 第 {rank} / 共 {total} 位玩家',
          'leaderboard.your_rank_outside':'你的排名: 第 {rank} (前 100 名外)',
          'leaderboard.no_rank_yet':'点击开始攀登排行榜!',
          'shop.title':'商店',
          'shop.permanent':'永久',
          'shop.auto':'自动',
          'shop.buffs':'增益 (60秒)',
          'shop.item.coinMul.name':'金币倍率',
          'shop.item.coinMul.desc':'每次点击金币 +50%',
          'shop.item.clickMul.name':'点击倍率',
          'shop.item.clickMul.desc':'每次点击次数 +50%',
          'shop.item.autoLevel.name':'自动点击器',
          'shop.item.autoLevel.desc':'每秒自动点击 +0.5',
          'shop.item.leaderboardAuto.name':'排行榜自动',
          'shop.item.leaderboardAuto.desc':'自动点击计入排名',
          'shop.item.buffCoins.name':'×2 金币',
          'shop.item.buffClicks.name':'×2 点击',
          'shop.item.buffAutoRate.name':'×2 自动速度',
          'shop.atMax':'已满',
          'shop.owned':'已拥有',
          'shop.error.notEnough':'金币不足',
          'shop.prestige.title':'转生',
          'shop.prestige.name':'转生',
          'shop.prestige.locked':'将任一升级提升至 Lv {n} 即可解锁',
          'shop.prestige.cta':'重置',
          'shop.prestige.coinsLabel':'金币',
          'shop.prestige.permanent':'(永久)',
          'shop.prestige.confirm':'重置所有商店等级和金币余额以获得 ★{n}？您的累计点击和转生星不会丢失。',
        },
        'zh-Hant': {
          'typing.title':'打字','typing.stop':'停止','typing.modifiers':'修飾器','typing.boards':'排行榜',
          'typing.board_words':'單字數','typing.board_wpm':'WPM','typing.words':'單字','typing.wpm':'WPM','typing.accuracy':'準確率',
          'typing.ranked':'排位','typing.casual':'休閒','typing.mod.freedom':'自由模式','typing.mod.nobackspace':'停用退格',
          'typing.mod.stoponerror':'出錯暫停','typing.mod.qol':'QoL 包（即時 WPM）','typing.toggle.on_word':'完成單字時彈跳','typing.toggle.per_key':'每次按鍵彈跳',
          'typing.loading':'載入中…','typing.board_empty':'尚無紀錄','typing.board_error':'無法載入排行榜',
          'settings.title':'設定','settings.music':'音樂','settings.sfx':'音效','settings.effects':'特效',
          'settings.language':'語言','settings.join_discord':'加入 Discord','settings.follow_x':'在 X 上追蹤我','settings.keyboard_clicks':'鍵盤點擊','settings.raw_cps':'顯示原始 CPS','settings.auto_clicker':'自動點擊器','settings.reset_defaults':'還原預設',
          'skins.title':'造型','skins.variants':'{n} 款','skins.variant':'{n} 款',
          'tag.default':'預設','tag.plushie':'玩偶','tag.track':'體操服','tag.idol':'偶像','tag.swimsuit':'泳裝',
          'character.aoba.name':'青葉','character.mari.name':'瑪麗','character.miyu.name':'美遊',
          'skin.aoba.name':'青葉','skin.aobaplush.name':'青葉玩偶',
          'skin.mari.name':'瑪麗','skin.maritrack.name':'體操服瑪麗','skin.mariidol.name':'偶像瑪麗',
          'skin.miyu.name':'美遊','skin.miyuswim.name':'泳裝美遊',
          'analytics.title':'數據分析',
          'stats.preset.today':'今日','stats.preset.7d':'7天','stats.preset.30d':'30天','stats.preset.all':'全部',
          'stats.tile.clicks_today':'今日點擊','stats.tile.clicks':'點擊',
          'stats.tile.visitors_today':'今日訪客','stats.tile.visitors':'訪客',
          'stats.tile.cpv':'每訪客點擊數',
          'stats.tile.max_combo_today':'今日最高連擊','stats.tile.max_combo':'最高連擊',
          'stats.chart.clicks_over_time':'點擊趨勢','stats.chart.visitors_over_time':'訪客趨勢',
          'stats.chart.top_countries':'國家排行','stats.chart.characters_used':'使用角色',
          'stats.chart.skins_per_character':'角色造型分布',
          'stats.chart.click_sources':'點擊來源',
          'stats.source.mouse':'滑鼠 / 觸控',
          'stats.source.keyboard':'鍵盤',
          'stats.source.auto':'自動點擊',
          'stats.no_data':'暫無數據',
          'stats.range.today':'今日','stats.range.last_7_days':'近 7 天',
          'stats.range.last_30_days':'近 30 天','stats.range.all_time':'全部時間',
          'combo.label':'連擊!','combo.max':'極限連擊!','combo.fire':'火力全開!','combo.insane':'瘋狂!!','combo.godlike':'神之連擊!!!',
          'tooltip.click_counter':'全球點擊 | 當前造型點擊',
          'disclaimer':'Aobing.it 與 Nexon、Nexon Games 及 Yostar 無任何關聯。所使用的全部遊戲美術、資訊和資源版權歸各自作者所有。',
          'meta.description':'點擊讓青葉發出叫聲!',
          'alt.character':'角色','aria.close':'關閉',
          'sensei.trainer':'老師',
          'auth.sign_in_google':'使用 Google 登入','auth.sign_out':'登出',
          'auth.already_linked':'此 Google 帳戶已與其他玩家連結。將使用該帳戶登入。',
          'profile.title':'個人資料',
          'profile.anon_blurb':'登入後可跨裝置保存進度並顯示在排行榜上。',
          'profile.display_name':'顯示名稱','profile.country':'國家','profile.save':'儲存',
          'profile.name_length_error':'顯示名稱需為 1–24 個字元。',
          'profile.country_change_to':'變更為 {flag} {code}',
          'leaderboard.title':'排行榜',
          'leaderboard.info_banner':'只有滑鼠/點擊計入排名。鍵盤連按很有趣,但不計入榜單。',
          'leaderboard.sign_in_cta':'登入加入排行榜 →',
          'leaderboard.your_rank':'你的排名: 第 {rank} / 共 {total} 位玩家',
          'leaderboard.your_rank_outside':'你的排名: 第 {rank} (前 100 名外)',
          'leaderboard.no_rank_yet':'點擊開始攀登排行榜!',
          'shop.title':'商店',
          'shop.permanent':'永久',
          'shop.auto':'自動',
          'shop.buffs':'增益 (60秒)',
          'shop.item.coinMul.name':'金幣倍率',
          'shop.item.coinMul.desc':'每次點擊金幣 +50%',
          'shop.item.clickMul.name':'點擊倍率',
          'shop.item.clickMul.desc':'每次點擊次數 +50%',
          'shop.item.autoLevel.name':'自動點擊器',
          'shop.item.autoLevel.desc':'每秒自動點擊 +0.5',
          'shop.item.leaderboardAuto.name':'排行榜自動',
          'shop.item.leaderboardAuto.desc':'自動點擊計入排名',
          'shop.item.buffCoins.name':'×2 金幣',
          'shop.item.buffClicks.name':'×2 點擊',
          'shop.item.buffAutoRate.name':'×2 自動速度',
          'shop.atMax':'已滿',
          'shop.owned':'已擁有',
          'shop.error.notEnough':'金幣不足',
          'shop.prestige.title':'轉生',
          'shop.prestige.name':'轉生',
          'shop.prestige.locked':'將任一升級提升至 Lv {n} 即可解鎖',
          'shop.prestige.cta':'重置',
          'shop.prestige.coinsLabel':'金幣',
          'shop.prestige.permanent':'(永久)',
          'shop.prestige.confirm':'重置所有商店等級和金幣餘額以獲得 ★{n}？您的累計點擊和轉生星不會遺失。',
        },
        th: {
          'typing.title':'พิมพ์ดีด','typing.stop':'หยุด','typing.modifiers':'ตัวปรับแต่ง','typing.boards':'กระดานผู้นำ',
          'typing.board_words':'จำนวนคำ','typing.board_wpm':'WPM','typing.words':'คำ','typing.wpm':'WPM','typing.accuracy':'ความแม่นยำ',
          'typing.ranked':'จัดอันดับ','typing.casual':'ทั่วไป','typing.mod.freedom':'โหมดอิสระ','typing.mod.nobackspace':'ปิดปุ่มลบ',
          'typing.mod.stoponerror':'หยุดเมื่อผิด','typing.mod.qol':'แพ็ก QoL (WPM แบบสด)','typing.toggle.on_word':'เด้งเมื่อจบคำ','typing.toggle.per_key':'เด้งทุกการกดปุ่ม',
          'typing.loading':'กำลังโหลด…','typing.board_empty':'ยังไม่มีข้อมูล','typing.board_error':'โหลดกระดานไม่สำเร็จ',
          'settings.title':'ตั้งค่า','settings.music':'เพลง','settings.sfx':'เสียงเอฟเฟกต์','settings.effects':'เอฟเฟกต์',
          'settings.language':'ภาษา','settings.join_discord':'เข้าร่วม Discord','settings.follow_x':'ติดตามบน X','settings.keyboard_clicks':'การกดคีย์บอร์ด','settings.raw_cps':'แสดง CPS ดิบ','settings.auto_clicker':'คลิกอัตโนมัติ','settings.reset_defaults':'คืนค่าเริ่มต้น',
          'skins.title':'สกิน','skins.variants':'{n} แบบ','skins.variant':'{n} แบบ',
          'tag.default':'ค่าเริ่มต้น','tag.plushie':'ตุ๊กตา','tag.track':'ชุดพละ','tag.idol':'ไอดอล','tag.swimsuit':'ชุดว่ายน้ำ',
          'character.aoba.name':'อาโอบะ','character.mari.name':'มาริ','character.miyu.name':'มิยุ',
          'skin.aoba.name':'อาโอบะ','skin.aobaplush.name':'ตุ๊กตาอาโอบะ',
          'skin.mari.name':'มาริ','skin.maritrack.name':'มาริชุดพละ','skin.mariidol.name':'ไอดอลมาริ',
          'skin.miyu.name':'มิยุ','skin.miyuswim.name':'มิยุชุดว่ายน้ำ',
          'analytics.title':'สถิติ',
          'stats.preset.today':'วันนี้','stats.preset.7d':'7 วัน','stats.preset.30d':'30 วัน','stats.preset.all':'ทั้งหมด',
          'stats.tile.clicks_today':'คลิกวันนี้','stats.tile.clicks':'คลิก',
          'stats.tile.visitors_today':'ผู้เข้าชมวันนี้','stats.tile.visitors':'ผู้เข้าชม',
          'stats.tile.cpv':'คลิกต่อผู้เข้าชม',
          'stats.tile.max_combo_today':'คอมโบสูงสุดวันนี้','stats.tile.max_combo':'คอมโบสูงสุด',
          'stats.chart.clicks_over_time':'คลิกตามช่วงเวลา','stats.chart.visitors_over_time':'ผู้เข้าชมตามช่วงเวลา',
          'stats.chart.top_countries':'ประเทศยอดนิยม','stats.chart.characters_used':'ตัวละครที่ใช้',
          'stats.chart.skins_per_character':'สกินต่อตัวละคร',
          'stats.chart.click_sources':'แหล่งที่มาของคลิก',
          'stats.source.mouse':'เมาส์ / แตะ',
          'stats.source.keyboard':'คีย์บอร์ด',
          'stats.source.auto':'คลิกอัตโนมัติ',
          'stats.no_data':'ไม่มีข้อมูล',
          'stats.range.today':'วันนี้','stats.range.last_7_days':'7 วันที่ผ่านมา',
          'stats.range.last_30_days':'30 วันที่ผ่านมา','stats.range.all_time':'ตลอดกาล',
          'combo.label':'คอมโบ!','combo.max':'คอมโบสูงสุด!','combo.fire':'ไฟลุก!','combo.insane':'บ้าระห่ำ!!','combo.godlike':'ดุจเทพ!!!',
          'tooltip.click_counter':'คลิกทั้งหมด | คลิกของสกินปัจจุบัน',
          'disclaimer':'Aobing.it ไม่มีส่วนเกี่ยวข้องกับ Nexon, Nexon Games หรือ Yostar งานศิลป์ ข้อมูล และทรัพย์สินของเกมทั้งหมดเป็นลิขสิทธิ์ของเจ้าของผลงานนั้นๆ',
          'meta.description':'คลิกเพื่อให้อาโอบะร้อง!',
          'alt.character':'ตัวละคร','aria.close':'ปิด',
          'sensei.trainer':'เซนเซย์',
          'auth.sign_in_google':'เข้าสู่ระบบด้วย Google','auth.sign_out':'ออกจากระบบ',
          'auth.already_linked':'บัญชี Google นี้เชื่อมโยงกับผู้เล่นคนอื่นแล้ว ระบบจะเข้าสู่ระบบด้วยบัญชีนั้น',
          'profile.title':'โปรไฟล์',
          'profile.anon_blurb':'เข้าสู่ระบบเพื่อบันทึกความคืบหน้าข้ามอุปกรณ์และปรากฏบนกระดานผู้นำ',
          'profile.display_name':'ชื่อที่แสดง','profile.country':'ประเทศ','profile.save':'บันทึก',
          'profile.name_length_error':'ชื่อที่แสดงต้องมี 1–24 ตัวอักษร',
          'profile.country_change_to':'เปลี่ยนเป็น {flag} {code}',
          'leaderboard.title':'กระดานผู้นำ',
          'leaderboard.info_banner':'เฉพาะคลิกเมาส์/แตะเท่านั้นที่นับเข้าอันดับ การกดคีย์บอร์ดสนุกแต่ไม่อยู่บนกระดาน',
          'leaderboard.sign_in_cta':'เข้าสู่ระบบเพื่อร่วมกระดานผู้นำ →',
          'leaderboard.your_rank':'อันดับของคุณ: #{rank} จาก {total} คน',
          'leaderboard.your_rank_outside':'อันดับของคุณ: #{rank} (นอก 100 อันดับแรก)',
          'leaderboard.no_rank_yet':'คลิกเพื่อเริ่มไต่อันดับ!',
          'shop.title':'ร้านค้า',
          'shop.permanent':'ถาวร',
          'shop.auto':'อัตโนมัติ',
          'shop.buffs':'บัฟ (60 วินาที)',
          'shop.item.coinMul.name':'ตัวคูณเหรียญ',
          'shop.item.coinMul.desc':'+50% เหรียญต่อคลิก',
          'shop.item.clickMul.name':'ตัวคูณคลิก',
          'shop.item.clickMul.desc':'+50% คลิกต่อคลิก',
          'shop.item.autoLevel.name':'คลิกอัตโนมัติ',
          'shop.item.autoLevel.desc':'+0.5 คลิกอัตโนมัติต่อวินาที',
          'shop.item.leaderboardAuto.name':'อันดับอัตโนมัติ',
          'shop.item.leaderboardAuto.desc':'คลิกอัตโนมัตินับเข้าอันดับของคุณ',
          'shop.item.buffCoins.name':'×2 เหรียญ',
          'shop.item.buffClicks.name':'×2 คลิก',
          'shop.item.buffAutoRate.name':'×2 ความเร็วอัตโนมัติ',
          'shop.atMax':'สูงสุด',
          'shop.owned':'มีอยู่แล้ว',
          'shop.error.notEnough':'เหรียญไม่พอ',
          'shop.prestige.title':'เพรสทีจ',
          'shop.prestige.name':'เพรสทีจ',
          'shop.prestige.locked':'อัปเกรดใดให้ถึง Lv {n} เพื่อปลดล็อก',
          'shop.prestige.cta':'รีเซ็ต',
          'shop.prestige.coinsLabel':'เหรียญ',
          'shop.prestige.permanent':'(ถาวร)',
          'shop.prestige.confirm':'รีเซ็ตทุกระดับร้านค้าและยอดเหรียญเพื่อรับ ★{n}? คลิกสะสมและดาวเพรสทีจของคุณจะถูกเก็บไว้',
        },
        ar: {
          'typing.title':'الكتابة','typing.stop':'إيقاف','typing.modifiers':'المُعدِّلات','typing.boards':'لوحة المتصدرين',
          'typing.board_words':'الكلمات','typing.board_wpm':'WPM','typing.words':'كلمات','typing.wpm':'WPM','typing.accuracy':'الدقة',
          'typing.ranked':'مُصنَّف','typing.casual':'عادي','typing.mod.freedom':'وضع الحرية','typing.mod.nobackspace':'بدون مسافة للخلف',
          'typing.mod.stoponerror':'التوقف عند الخطأ','typing.mod.qol':'حزمة QoL (WPM مباشر)','typing.toggle.on_word':'ارتداد عند اكتمال الكلمة','typing.toggle.per_key':'ارتداد عند كل مفتاح',
          'typing.loading':'جارٍ التحميل…','typing.board_empty':'لا توجد إدخالات بعد','typing.board_error':'تعذّر تحميل اللوحة',
          'settings.title':'الإعدادات','settings.music':'الموسيقى','settings.sfx':'المؤثرات الصوتية','settings.effects':'المؤثرات',
          'settings.language':'اللغة','settings.join_discord':'انضم إلى Discord','settings.follow_x':'تابعني على X','settings.keyboard_clicks':'نقرات لوحة المفاتيح','settings.raw_cps':'إظهار CPS الخام','settings.auto_clicker':'النقر التلقائي','settings.reset_defaults':'استعادة الإعدادات الافتراضية',
          'skins.title':'الأزياء','skins.variants':'{n} أزياء','skins.variant':'{n} زي',
          'tag.default':'افتراضي','tag.plushie':'دمية','tag.track':'رياضي','tag.idol':'نجمة','tag.swimsuit':'ملابس السباحة',
          'character.aoba.name':'آوبا','character.mari.name':'ماري','character.miyu.name':'ميو',
          'skin.aoba.name':'آوبا','skin.aobaplush.name':'دمية آوبا',
          'skin.mari.name':'ماري','skin.maritrack.name':'ماري الرياضية','skin.mariidol.name':'ماري النجمة',
          'skin.miyu.name':'ميو','skin.miyuswim.name':'ميو بملابس السباحة',
          'analytics.title':'التحليلات',
          'stats.preset.today':'اليوم','stats.preset.7d':'٧ أيام','stats.preset.30d':'٣٠ يومًا','stats.preset.all':'كل الأوقات',
          'stats.tile.clicks_today':'نقرات اليوم','stats.tile.clicks':'النقرات',
          'stats.tile.visitors_today':'زوار اليوم','stats.tile.visitors':'الزوار',
          'stats.tile.cpv':'النقرات لكل زائر',
          'stats.tile.max_combo_today':'أعلى كومبو اليوم','stats.tile.max_combo':'أعلى كومبو',
          'stats.chart.clicks_over_time':'النقرات عبر الوقت','stats.chart.visitors_over_time':'الزوار عبر الوقت',
          'stats.chart.top_countries':'أهم الدول','stats.chart.characters_used':'الشخصيات المستخدمة',
          'stats.chart.skins_per_character':'الأزياء لكل شخصية',
          'stats.chart.click_sources':'مصادر النقر',
          'stats.source.mouse':'الفأرة / اللمس',
          'stats.source.keyboard':'لوحة المفاتيح',
          'stats.source.auto':'نقر تلقائي',
          'stats.no_data':'لا توجد بيانات',
          'stats.range.today':'اليوم','stats.range.last_7_days':'آخر ٧ أيام',
          'stats.range.last_30_days':'آخر ٣٠ يومًا','stats.range.all_time':'كل الأوقات',
          'combo.label':'كومبو!','combo.max':'أقصى كومبو!','combo.fire':'مشتعل!','combo.insane':'جنون!!','combo.godlike':'كالآلهة!!!',
          'tooltip.click_counter':'النقرات الإجمالية | نقرات الزي الحالي',
          'disclaimer':'Aobing.it غير تابعة لشركة Nexon أو Nexon Games أو Yostar. جميع الرسوم والمعلومات والأصول المستخدمة من اللعبة هي ملكية وحقوق نشر لأصحابها الأصليين.',
          'meta.description':'اضغط لتجعل آوبا يصدر صوتًا!',
          'alt.character':'شخصية','aria.close':'إغلاق',
          'sensei.trainer':'المعلم',
          'auth.sign_in_google':'تسجيل الدخول بحساب Google','auth.sign_out':'تسجيل الخروج',
          'auth.already_linked':'حساب Google هذا مرتبط بالفعل بلاعب آخر. سيتم تسجيل الدخول إلى ذلك الحساب.',
          'profile.title':'الملف الشخصي',
          'profile.anon_blurb':'سجّل الدخول لحفظ تقدمك عبر الأجهزة والظهور في لوحة المتصدرين.',
          'profile.display_name':'اسم العرض','profile.country':'الدولة','profile.save':'حفظ',
          'profile.name_length_error':'يجب أن يتكون اسم العرض من 1 إلى 24 حرفًا.',
          'profile.country_change_to':'تغيير إلى {flag} {code}',
          'leaderboard.title':'لوحة المتصدرين',
          'leaderboard.info_banner':'فقط نقرات الفأرة/اللمس تُحتسب في تصنيفك. لعب لوحة المفاتيح ممتع لكنه لا يدخل اللوحة.',
          'leaderboard.sign_in_cta':'سجّل الدخول للانضمام إلى لوحة المتصدرين →',
          'leaderboard.your_rank':'ترتيبك: #{rank} من {total} لاعبًا',
          'leaderboard.your_rank_outside':'ترتيبك: #{rank} (خارج أفضل 100)',
          'leaderboard.no_rank_yet':'انقر لتبدأ تسلق اللوحة!',
          'shop.title':'المتجر',
          'shop.permanent':'دائم',
          'shop.auto':'تلقائي',
          'shop.buffs':'تعزيزات (60 ث)',
          'shop.item.coinMul.name':'مضاعف العملات',
          'shop.item.coinMul.desc':'+50% عملات لكل نقرة',
          'shop.item.clickMul.name':'مضاعف النقرات',
          'shop.item.clickMul.desc':'+50% نقرات لكل نقرة',
          'shop.item.autoLevel.name':'النقر التلقائي',
          'shop.item.autoLevel.desc':'+0.5 نقرة تلقائية في الثانية',
          'shop.item.leaderboardAuto.name':'تلقائي للترتيب',
          'shop.item.leaderboardAuto.desc':'النقرات التلقائية تُحتسب في ترتيبك',
          'shop.item.buffCoins.name':'×2 عملات',
          'shop.item.buffClicks.name':'×2 نقرات',
          'shop.item.buffAutoRate.name':'×2 سرعة تلقائية',
          'shop.atMax':'الحد الأقصى',
          'shop.owned':'مملوك',
          'shop.error.notEnough':'لا توجد عملات كافية',
          'shop.prestige.title':'هيبة',
          'shop.prestige.name':'هيبة',
          'shop.prestige.locked':'ارفع أي ترقية إلى Lv {n} للفتح',
          'shop.prestige.cta':'إعادة تعيين',
          'shop.prestige.coinsLabel':'عملات',
          'shop.prestige.permanent':'(دائم)',
          'shop.prestige.confirm':'إعادة تعيين جميع مستويات المتجر ورصيد العملات لكسب ★{n}؟ نقراتك التراكمية ونجوم الهيبة محفوظة.',
        },
        vi: {
          'typing.title':'Gõ phím','typing.stop':'Dừng','typing.modifiers':'Bộ điều chỉnh','typing.boards':'Bảng xếp hạng',
          'typing.board_words':'Số từ','typing.board_wpm':'WPM','typing.words':'từ','typing.wpm':'WPM','typing.accuracy':'độ chính xác',
          'typing.ranked':'Xếp hạng','typing.casual':'Thường','typing.mod.freedom':'Chế độ tự do','typing.mod.nobackspace':'Không xóa lùi',
          'typing.mod.stoponerror':'Dừng khi sai','typing.mod.qol':'Gói QoL (WPM trực tiếp)','typing.toggle.on_word':'Nảy khi xong từ','typing.toggle.per_key':'Nảy mỗi phím',
          'typing.loading':'Đang tải…','typing.board_empty':'Chưa có mục nào','typing.board_error':'Không tải được bảng',
          'settings.title':'Cài đặt','settings.music':'Nhạc','settings.sfx':'Âm thanh','settings.effects':'Hiệu ứng',
          'settings.language':'Ngôn ngữ','settings.join_discord':'Tham gia Discord','settings.follow_x':'Theo dõi tôi trên X','settings.keyboard_clicks':'Nhấn bằng bàn phím','settings.raw_cps':'Hiện CPS thô','settings.auto_clicker':'Tự động nhấn','settings.reset_defaults':'Đặt lại mặc định',
          'skins.title':'Trang phục','skins.variants':'{n} biến thể','skins.variant':'{n} biến thể',
          'sensei.trainer':'Huấn luyện viên',
          'auth.sign_in_google':'Đăng nhập bằng Google','auth.sign_out':'Đăng xuất',
          'auth.already_linked':'Tài khoản Google này đã được liên kết với người chơi khác. Đang đăng nhập bạn vào tài khoản đó.',
          'profile.title':'Hồ sơ',
          'profile.anon_blurb':'Đăng nhập để lưu tiến trình trên mọi thiết bị và xuất hiện trên bảng xếp hạng.',
          'profile.display_name':'Tên hiển thị','profile.country':'Quốc gia','profile.save':'Lưu',
          'profile.name_length_error':'Tên hiển thị phải có từ 1-24 ký tự.',
          'profile.country_change_to':'Đổi thành {flag} {code}',
          'leaderboard.title':'Bảng xếp hạng',
          'leaderboard.info_banner':'Chỉ lượt nhấn chuột và chạm mới được tính vào thứ hạng. Nhấn bàn phím thì vui, nhưng không được tính lên bảng.',
          'leaderboard.sign_in_cta':'Đăng nhập để tham gia bảng xếp hạng →',
          'leaderboard.your_rank':'Thứ hạng của bạn: #{rank} trên {total} người chơi',
          'leaderboard.your_rank_outside':'Thứ hạng của bạn: #{rank} (ngoài top 100)',
          'leaderboard.no_rank_yet':'Nhấn để bắt đầu leo hạng!',
          'shop.title':'Cửa hàng',
          'shop.permanent':'Vĩnh viễn',
          'shop.auto':'Tự động',
          'shop.buffs':'Tăng cường (60 giây)',
          'shop.item.coinMul.name':'Hệ số xu',
          'shop.item.coinMul.desc':'+50% xu mỗi lượt nhấn',
          'shop.item.clickMul.name':'Hệ số nhấn',
          'shop.item.clickMul.desc':'+50% lượt nhấn mỗi lần nhấn',
          'shop.item.autoLevel.name':'Tự động nhấn',
          'shop.item.autoLevel.desc':'+0,5 lượt tự động nhấn mỗi giây',
          'shop.item.leaderboardAuto.name':'Tự động lên bảng',
          'shop.item.leaderboardAuto.desc':'Lượt tự động nhấn được tính vào thứ hạng',
          'shop.item.buffCoins.name':'×2 xu',
          'shop.item.buffClicks.name':'×2 lượt nhấn',
          'shop.item.buffAutoRate.name':'×2 tốc độ tự động',
          'shop.atMax':'TỐI ĐA',
          'shop.owned':'Đã sở hữu',
          'shop.error.notEnough':'Không đủ xu',
          'shop.prestige.title':'Thăng hoa',
          'shop.prestige.name':'Thăng hoa',
          'shop.prestige.locked':'Đạt Cấp {n} ở bất kỳ nâng cấp nào để mở khóa',
          'shop.prestige.cta':'Đặt lại',
          'shop.prestige.coinsLabel':'xu',
          'shop.prestige.permanent':'(vĩnh viễn)',
          'shop.prestige.confirm':'Đặt lại toàn bộ cấp cửa hàng và số dư xu để nhận ★{n}? Tổng lượt nhấn và sao thăng hoa của bạn được giữ nguyên.',
          'bond.title':'Gắn kết',
          'bond.cta':'Gắn kết',
          'bond.button':'Gắn kết — đặt lại cấp để nhận +10% xu vĩnh viễn',
          'bond.confirm':'Gắn kết với {name}? Đặt lại cấp hiển thị về 0 và thêm ♥{n}. +10% xu vĩnh viễn khi dùng trang phục này.',
          'bond.count':'♥{n} cấp gắn kết',
          'settings.admin_mode':'Chế độ quản trị',
          'admin.banner':'Chế độ quản trị đang BẬT. Dùng × để ẩn một hàng, ↺ để hiện lại. Hàng bị ẩn sẽ mờ đi.',
          'admin.delete_row':'Ẩn khỏi bảng xếp hạng',
          'admin.confirm_delete':'Ẩn "{name}" khỏi bảng xếp hạng?',
          'admin.hide_row':'Ẩn khỏi bảng xếp hạng',
          'admin.show_row':'Hiện lại hàng',
          'tag.default':'Mặc định','tag.plushie':'Thú bông','tag.track':'Đồ thể thao','tag.idol':'Thần tượng','tag.swimsuit':'Đồ bơi',
          'character.aoba.name':'Aoba','character.mari.name':'Mari','character.miyu.name':'Miyu',
          'skin.aoba.name':'Aoba','skin.aobaplush.name':'Aoba Thú Bông',
          'skin.mari.name':'Mari','skin.maritrack.name':'Mari Thể Thao','skin.mariidol.name':'Mari Thần Tượng',
          'skin.miyu.name':'Miyu','skin.miyuswim.name':'Miyu Đồ Bơi',
          'analytics.title':'Phân tích',
          'stats.preset.today':'Hôm nay','stats.preset.7d':'7 ngày','stats.preset.30d':'30 ngày','stats.preset.all':'Toàn thời gian',
          'stats.tile.clicks_today':'Lượt nhấn hôm nay','stats.tile.clicks':'Lượt nhấn',
          'stats.tile.visitors_today':'Khách hôm nay','stats.tile.visitors':'Khách',
          'stats.tile.cpv':'Lượt nhấn mỗi khách',
          'stats.tile.max_combo_today':'Combo cao nhất hôm nay','stats.tile.max_combo':'Combo cao nhất',
          'stats.chart.clicks_over_time':'Lượt nhấn theo thời gian','stats.chart.visitors_over_time':'Khách theo thời gian',
          'stats.chart.top_countries':'Quốc gia hàng đầu','stats.chart.characters_used':'Nhân vật đã dùng',
          'stats.chart.skins_per_character':'Trang phục theo nhân vật',
          'stats.chart.click_sources':'Nguồn nhấn',
          'stats.source.mouse':'Chuột / Chạm',
          'stats.source.keyboard':'Bàn phím',
          'stats.source.auto':'Tự động nhấn',
          'stats.no_data':'Không có dữ liệu',
          'stats.range.today':'hôm nay','stats.range.last_7_days':'7 ngày qua',
          'stats.range.last_30_days':'30 ngày qua','stats.range.all_time':'toàn thời gian',
          'combo.label':'COMBO!','combo.max':'COMBO TỐI ĐA!','combo.fire':'BỐC CHÁY!','combo.insane':'ĐIÊN RỒ!!','combo.godlike':'NHƯ THẦN!!!',
          'tooltip.click_counter':'Tổng lượt nhấn | Lượt nhấn trang phục hiện tại',
          'disclaimer':'Aobing.it không liên kết với Nexon, Nexon Games hay Yostar. Mọi hình ảnh, thông tin và tài nguyên trò chơi được sử dụng đều thuộc quyền sở hữu và bản quyền của các tác giả tương ứng.',
          'meta.description':'Nhấn để Aoba kêu chít chít!',
          'alt.character':'Nhân vật','aria.close':'Đóng',
        },
      };
      let current = 'en';

      function detect(stored) {
        if (stored && SUPPORTED.includes(stored)) return stored;
        const nav = (navigator.language || 'en').toLowerCase();
        if (nav.startsWith('ja')) return 'ja';
        if (nav.startsWith('ko')) return 'ko';
        if (nav.startsWith('th')) return 'th';
        if (nav.startsWith('vi')) return 'vi';
        if (nav.startsWith('ar')) return 'ar';
        if (nav.startsWith('zh')) {
          if (/(^|[-_])(hant|tw|hk|mo)/i.test(nav)) return 'zh-Hant';
          return 'zh-Hans';
        }
        return 'en';
      }

      function t(key, params) {
        const dict = T[current] || T.en;
        let s = dict[key];
        if (s === undefined) s = (T.en[key] !== undefined) ? T.en[key] : key;
        if (params) {
          for (const k in params) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
        }
        return s;
      }

      function apply() {
        document.documentElement.lang = current;
        document.documentElement.dir = (current === 'ar') ? 'rtl' : 'ltr';
        document.querySelectorAll('[data-i18n]').forEach(el => {
          el.textContent = t(el.dataset.i18n);
        });
        document.querySelectorAll('[data-i18n-attr]').forEach(el => {
          el.dataset.i18nAttr.split(',').forEach(pair => {
            const idx = pair.indexOf(':');
            if (idx < 0) return;
            const attr = pair.slice(0, idx).trim();
            const key = pair.slice(idx + 1).trim();
            el.setAttribute(attr, t(key));
          });
        });
      }

      function set(lang) {
        if (!SUPPORTED.includes(lang)) lang = 'en';
        current = lang;
        apply();
        window.dispatchEvent(new CustomEvent('i18nchange', { detail: { lang } }));
      }

      return { SUPPORTED, NATIVE, t, set, detect, apply, get current() { return current; } };
    })();
    // -------------------------------------------------------------------------

    // --- Settings Persistence ---
    const SETTINGS_KEY = 'aobing-settings';
    const DEFAULT_SETTINGS = {
      musicVol: 10, sfxVol: 50, effects: true, skin: 'aoba', keyboardClicks: true,
      adminMode: false, rawCps: false, autoClicker: true,
      // Typing game (typing.js)
      typingClickOnWord: true,    // word-complete fires reactCharacter()
      typingClickPerKey: false,   // each keystroke fires reactCharacter()
      typingMode: 's30',          // s15 | s30 | s60 | endless
      typingPack: 'english-common',
      typingFreedomOn: false, typingNoBackspaceOn: false, typingStopOnErrorOn: false,
      gameMode: 'clicker',        // 'clicker' | 'typing' — left mode menu top level
      typingSubMode: 'casual',    // 'casual' | 'ranked' — only meaningful in typing mode
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
      keyboardToggle.classList.toggle('on', s.keyboardClicks);
      adminToggle.classList.toggle('on', s.adminMode);
      rawCpsToggle.classList.toggle('on', s.rawCps);
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
          return `<div class="skin-item${v.id === settings.skin ? ' active' : ''}${canBond ? ' bond-ready' : ''}" data-variant="${v.id}"${bondAttrs}>
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
          <button class="skin-group-header" type="button">
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
      if (typeof renderShopPanel === 'function') renderShopPanel();
    });
    shopPanel.addEventListener('click', (e) => e.stopPropagation());

    // Close panels on outside click
    document.addEventListener('click', (e) => {
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
                labels: { color: '#1f2c40', font: { size: 11, weight: '600' }, boxWidth: 12 },
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
                labels: { color: '#1f2c40', font: { size: 11, weight: '600' }, boxWidth: 12 },
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
                labels: { color: '#1f2c40', font: { size: 11, weight: '600' }, boxWidth: 12 },
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
                ticks: { color: 'rgba(31,44,64,0.55)', font: { size: 10, weight: '600' }, precision: 0 },
                grid: { color: 'rgba(60,90,130,0.10)' },
                border: { color: 'rgba(60,90,130,0.15)' },
              },
              y: {
                stacked: true,
                ticks: { color: 'rgba(31,44,64,0.8)', font: { size: 11, weight: '700' } },
                grid: { display: false },
                border: { color: 'rgba(60,90,130,0.15)' },
              },
            },
          },
        });
      }
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
            ticks: { color: 'rgba(31,44,64,0.55)', font: { size: 10, weight: '600' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
            grid: { color: 'rgba(60,90,130,0.10)' },
            border: { color: 'rgba(60,90,130,0.15)' },
          },
          y: {
            beginAtZero: true,
            ticks: { color: 'rgba(31,44,64,0.55)', font: { size: 10, weight: '600' }, precision: 0 },
            grid: { color: 'rgba(60,90,130,0.10)' },
            border: { color: 'rgba(60,90,130,0.15)' },
          },
        },
      };
    }

    function tooltipStyle() {
      return {
        backgroundColor: 'rgba(255,255,255,0.98)',
        borderColor: 'rgba(160,195,230,0.55)',
        borderWidth: 1,
        titleColor: '#1f2c40',
        titleFont: { weight: '700' },
        bodyColor: 'rgba(31,44,64,0.85)',
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
        localStorage.setItem(LOCAL_USER_KEY, JSON.stringify({ stats: userStats, shop: userShop }));
      } catch {}
    }
    function clearLocalUserData() {
      try { localStorage.removeItem(LOCAL_USER_KEY); } catch {}
    }

    // --- Shop helpers -----------------------------------------------------------
    const SHOP_MAX_LEVEL = 30;
    const SHOP_BUFF_COST = 200;
    const SHOP_BUFF_DURATION_MS = 60_000;
    const SHOP_LBAUTO_COST = 10_000;

    function shopFieldFor(which) {
      if (which === 'coinMul')    return 'coinMulLevel';
      if (which === 'clickMul')   return 'clickMulLevel';
      if (which === 'autoLevel')  return 'autoLevel';
      return null;
    }

    function shopCostFor(which, level) {
      if (which === 'coinMul' || which === 'clickMul') return Math.round(50 * Math.pow(1.5, level));
      if (which === 'autoLevel')                       return Math.round(75 * Math.pow(1.4, level));
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
      // Permanent +5% coins per prestige star. Applies to coins only — clicks
      // (which feed totalClicks/leaderboard) are untouched by design, so prestige
      // can't be used to inflate leaderboard standing.
      const stars = (userStats && userStats.prestigeStars) || 0;
      const prestigeMul = 1 + 0.05 * stars;
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
        rearmAutoLoop();
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
      const lv = levelOf(clicks);
      const cur = clicksInLevel(clicks);
      const need = clicksToNextLevel(clicks);
      senseiLevelEl.textContent = 'Lv.' + lv;
      senseiXpFillEl.style.width = (need > 0 ? Math.min(100, cur / need * 100) : 0) + '%';
      senseiXpTextEl.textContent = cur.toLocaleString() + ' / ' + need.toLocaleString();
      senseiCoinsEl.textContent = coins.toLocaleString();
      const stars = (userStats && userStats.prestigeStars) || 0;
      senseiPrestigeEl.hidden = stars <= 0;
      if (stars > 0) senseiPrestigeEl.textContent = '★' + stars;

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
            photoURL:    userProfile.photoURL || '',
            totalClicks: userStats.totalClicks || 0,
          }).catch(() => {});
          // Typing boards — same profile-gated mirror. Words board tracks all
          // typed words; WPM board tracks the user's single best ranked run.
          const typingWords = userStats.typingWords || 0;
          if (typingWords > 0) {
            db.ref('leaderboard/typingWords/' + uid).update({
              name:        userProfile.displayName || I18N.t('sensei.trainer'),
              country:     userProfile.country || 'XX',
              photoURL:    userProfile.photoURL || '',
              typingWords: typingWords,
            }).catch(() => {});
          }
          const bestWpmMap = userStats.typingBestWpm || {};
          let bestWpm = 0, bestMode = '';
          for (const md in bestWpmMap) { if (bestWpmMap[md] > bestWpm) { bestWpm = bestWpmMap[md]; bestMode = md; } }
          if (bestWpm > 0) {
            db.ref('leaderboard/typingWpm/' + uid).update({
              name:     userProfile.displayName || I18N.t('sensei.trainer'),
              country:  userProfile.country || 'XX',
              photoURL: userProfile.photoURL || '',
              wpm:      bestWpm,
              mode:     bestMode,
            }).catch(() => {});
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

    function openLeaderboard() {
      leaderboardModal.classList.add('open');
      leaderboardModal.setAttribute('aria-hidden', 'false');
      loadLeaderboard();
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
            <span class="lb-level">Lv.${levelOf(r.totalClicks || 0)}</span>
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
        photoURL:    profile.photoURL,
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
        || Object.keys(pending.typingBestWpm).length > 0;
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
          && pending.typingWords === 0 && Object.keys(pending.typingBestWpm).length === 0) return;
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
      if (currentUser && (hasClickActivity || hasCoinChange || hasTypingWords)) {
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
      if (pending.userCoins !== 0 || pending.userClicks > 0 || pending.global > 0) scheduleFlush();
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
      const source = opts && opts.source === 'keyboard' ? 'keyboard' : 'mouse';

      if (walkTimer) clearTimeout(walkTimer);
      if (currentWalkAnim) currentWalkAnim.pause();

      aobaImg.style.transform = '';

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

    document.getElementById('curtain').addEventListener('click', endIntro);
    startIntroWalk();

    // Purely-cosmetic character reaction: SFX, combo bump, sprite swap, bounce,
    // particles. Carries NO economy (no recordClick / coins / totalClicks).
    // Shared by the clicker (via triggerClick) and the typing game, which calls
    // it through the injected `reactCharacter` dep for its per-word/per-key toggle.
    function reactCharacter() {
      const { variant: v } = getVariant(settings.skin);

      // 1. Play SFX — each click spawns its own audio, oldest evicted at cap
      playsfx();
      bumpCombo();

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

    // Routes typing earnings into the existing pending batch so shopMul.coin,
    // buffs, optimistic UI, and the 5s flush all apply — WITHOUT touching
    // userClicks/totalClicks (the clicker leaderboard stays typing-free).
    //   coins:        base per-word coins (multiplied by shopMul.coin here)
    //   words:        completed-word count -> stats/typingWords + words board
    //   opts.mode +   run-end ranked WPM submit, best-of per mode
    //   opts.bestWpm
    function creditTyping(coins, words, opts) {
      const m = shopMul(Date.now());
      const coinGain = Math.floor((coins || 0) * m.coin);
      if (coinGain) pending.userCoins += coinGain;
      if (words > 0) pending.typingWords += words;
      if (opts && opts.mode && opts.bestWpm > 0) {
        const cur = pending.typingBestWpm[opts.mode] || 0;
        if (opts.bestWpm > cur) pending.typingBestWpm[opts.mode] = opts.bestWpm;
      }
      savePendingDeferred();
      scheduleFlush();
      if (typeof scheduleOptimisticRender === 'function') scheduleOptimisticRender();
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
    document.addEventListener('keydown', () => {
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
      t:                 function (k, p) { return I18N.t(k, p); },
      escapeHtml:        escapeHtml,
      flagFromCountry:   flagFromCountry,
    };
    if (window.TypingGame && typeof window.TypingGame.init === 'function') {
      window.TypingGame.init(window.__typingDeps);
    }

