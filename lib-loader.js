    window.__loadLibsAndApp = function () {
      // In the Discord Activity, patchUrlMappings rewrites fetch/XHR/WebSocket but NOT a
      // dynamically-set <script>.src, so CSP blocks external lib scripts. Rewrite those
      // URLs to Discord's /.proxy/<prefix> path ourselves (prefixes match the Dev Portal
      // URL Mappings). No-op on the normal web.
      var IN_ACTIVITY = location.hostname.endsWith('.discordsays.com');
      var PROXY_MAP = {
        'www.gstatic.com':     '/gstatic',
        'cdn.jsdelivr.net':    '/jsdelivr',
        'fonts.googleapis.com':'/gfonts',
        'fonts.gstatic.com':   '/gfonts-static',
      };
      function proxify(url) {
        if (!IN_ACTIVITY) return url;
        try {
          var u = new URL(url, location.href);
          var prefix = PROXY_MAP[u.hostname];
          if (prefix) return '/.proxy' + prefix + u.pathname + u.search;
        } catch (e) {}
        return url;
      }
      function loadScript(src) {
        return new Promise(function (res, rej) {
          var s = document.createElement('script');
          s.src = proxify(src); s.async = false;
          s.onload = res; s.onerror = function () { rej(new Error('lib load failed: ' + s.src)); };
          document.head.appendChild(s);
        });
      }
      var FB = 'https://www.gstatic.com/firebasejs/10.12.0/';
      // firebase-app must load before the other firebase modules
      loadScript(FB + 'firebase-app-compat.js')
        .then(function () {
          var mods = [
            loadScript(FB + 'firebase-auth-compat.js'),
            loadScript(FB + 'firebase-database-compat.js'),
            loadScript(FB + 'firebase-app-check-compat.js'),
            loadScript('https://cdn.jsdelivr.net/npm/animejs@4/dist/bundles/anime.umd.min.js'),
            loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js'),
          ];
          // Analytics is skipped in the Activity (gtag/installations are CSP-blocked there).
          if (!IN_ACTIVITY) mods.push(loadScript(FB + 'firebase-analytics-compat.js'));
          return Promise.all(mods);
        })
        // Fishing mode engine + session + controller load before app.js so the globals
        // (FishingEngine, FishData, FishSprite, FishingSession, FishingGame) exist when
        // app.js injects its deps into window.__fishingDeps.
        .then(function () { return loadScript('fishing.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        .then(function () { return loadScript('fish-data.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        .then(function () { return loadScript('fish-sprite.js?v=anime-motion-v1' + (IN_ACTIVITY ? '&t=' + Date.now() : '')); })
        .then(function () { return loadScript('fishing-session.js?v=catch-reveal-1s' + (IN_ACTIVITY ? '&t=' + Date.now() : '')); })
        .then(function () { return loadScript('fishing-scene.js?v=anime-motion-v1' + (IN_ACTIVITY ? '&t=' + Date.now() : '')); })
        .then(function () { return loadScript('fishing-ui.js?v=catch-notice-v1' + (IN_ACTIVITY ? '&t=' + Date.now() : '')); })
        .then(function () { return loadScript('fishing-dex.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        .then(function () { return loadScript('fishing-dex-ui.js?v=anime-motion-v1' + (IN_ACTIVITY ? '&t=' + Date.now() : '')); })
        .then(function () { return loadScript('gems.js?v=1'); })
        .then(function () { return loadScript('gems-ui.js?v=1'); })
        .then(function () { return loadScript('marble.js?v=1'); })
        .then(function () { return loadScript('marble-ui.js?v=1'); })
        .then(function () { return loadScript('drift.js?v=1'); })
        .then(function () { return loadScript('drift-ui.js?v=1'); })
        .then(function () { return loadScript('snake.js?v=1'); })
        .then(function () { return loadScript('snake-ui.js?v=1'); })
        // In the Activity, cache-bust app.js each launch so code changes appear immediately
        // (Discord's proxy + embedded browser otherwise cache it). Web caches normally.
        .then(function () { return loadScript('app.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '?v=drift-snake-1')); })
        // hitsound.js (shared rhythm hitsound engine) loads after app.js and self-
        // initialises from window.__hitsoundDeps; vsrg.js/osustd.js call window.Hitsound.
        .then(function () { return loadScript('rhythm-core.js?v=2'); })
        .then(function () { return loadScript('rhythm-mania.js?v=2'); })
        .then(function () { return loadScript('rhythm-standard.js?v=2'); })
        .then(function () { return loadScript('rhythm-ui.js?v=2'); })
        .then(function () { return loadScript('rhythm-select.js?v=1'); })
        .then(function () { return loadScript('hitsound.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '?v=replay-2')); })
        // typing.js loads AFTER app.js and self-initialises from window.__typingDeps.
        .then(function () { return loadScript('typing.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        // vsrg.js (Rhythm mode) loads after app.js and self-initialises from
        // window.__vsrgDeps. Inert on the web until the mode is opened.
        .then(function () { return loadScript('vsrg.js?v=rhythm-stage-1' + (IN_ACTIVITY ? '&t=' + Date.now() : '')); })
        // osustd.js (osu!standard mode) loads after app.js and self-initialises from
        // window.__osustdDeps. Inert until the mode is opened.
        .then(function () { return loadScript('osustd.js?v=rhythm-stage-1' + (IN_ACTIVITY ? '&t=' + Date.now() : '')); })
        .then(function () { return loadScript('multiplayer.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '?v=multiplayer-4')).catch(function (e) { console.warn('Multiplayer unavailable', e); }); })
        // divaft.js (Project Diva mode) self-initialises from window.__divaftDeps.
        // divadsc.js (binary .dsc decoder) + divapvdb.js (pv_db parser) feed divaft.js's
        // folder import; load them first so window.DivaDsc / window.DivaPvdb exist.
        .then(function () { return loadScript('divadsc.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        .then(function () { return loadScript('divapvdb.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        // cpk.js (CRI CPK reader, AES content decrypt) lets divaft.js import base-game songs.
        .then(function () { return loadScript('cpk.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        // phsong.js (Project Heartbeat song parser) feeds divaft.js's PH import.
        .then(function () { return loadScript('phsong.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        .then(function () { return loadScript('divaft.js?v=ui-polish-1' + (IN_ACTIVITY ? '&t=' + Date.now() : '')); })
        // presence.js (Discord Activity presence panel) loads after app.js; app.js calls
        // window.Presence.init(...) once the user's profile is ready. Inert on the web.
        .then(function () { return loadScript('dos-runtime.js?v=5'); })
        .then(function () { return loadScript('dos-games.js?v=4'); })
        .then(function () { return loadScript('dos-bindings.js?v=1'); })
        .then(function () { return loadScript('dos-ui.js?v=4'); })
        .then(function () { return loadScript('presence.js' + (IN_ACTIVITY ? '?t=' + Date.now() : '')); })
        .then(function () { return loadScript('activity-games.js?v=7').catch(function (e) { console.warn('Activity chat unavailable', e); }); })
        .then(function () { if (IN_ACTIVITY) return loadScript('activity-replay.js?v=4').catch(function (e) { console.warn('Activity replay unavailable', e); }); })
        .then(async function () {
          if (!window.__aobingAppReady) throw new Error('Game initialization failed');
          await window.ActivityGames?.init();
          window.dispatchEvent(new Event('aobingready'));
        })
        .catch(function (e) { console.error('lib load failed', e); window.dispatchEvent(new Event('aobingloaderror')); });
    };
    // Coordinator: on web, load immediately; in Activity, the module below calls this after Discord flow
    if (!location.hostname.endsWith('.discordsays.com')) {
      window.__loadLibsAndApp();
    }
  
