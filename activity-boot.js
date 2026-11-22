    if (location.hostname.endsWith('.discordsays.com')) {
      // The on-screen log stays hidden on success; it only reveals itself if boot errors,
      // so you can still diagnose in the wild. (All steps are also in the console.)
      const box = document.getElementById('activity-log');
      const log = (m) => { box.textContent += m + '\n'; console.log('[activity]', m); };
      const bounded = (promise, ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Discord connection timed out')), ms);
        Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
      });
      (async () => {
        try {
          // Cache-bust everything this thin shell loads, so updates land without waiting on
          // a cache. (index.html itself is the only file with GitHub Pages' ~10min cache.)
          const ts = Date.now();
          const { DiscordSDK, patchUrlMappings } = await bounded(import('/vendor/discord-embedded-app-sdk.js?t=' + ts), 20000);
          // URL mappings live in a cache-busted file so we can add/change them without ever
          // editing index.html. Same-origin fetch (allowed by connect-src 'self' before the
          // mappings are even applied). Minimal inline fallback only if that fetch fails.
          let mappings = [{ prefix: '/kei', target: 'kei.aobing.it' }];
          try { mappings = await bounded(fetch('/activity-mappings.json?t=' + ts).then(r => { if (!r.ok) throw new Error('mappings'); return r.json(); }), 8000); }
          catch (e) { log('mappings.json fetch failed; using minimal fallback'); }
          patchUrlMappings(mappings);
          log('SDK + ' + mappings.length + ' mappings loaded. init…');
          const sdk = new DiscordSDK('1514146586748256306');
          await bounded(sdk.ready(), 30000);
          log('ready. authorizing…');
          const { code } = await bounded(sdk.commands.authorize({
            client_id: '1514146586748256306', response_type: 'code', state: '', prompt: 'none', scope: ['identify'],
          }), 60000);
          log('authorized. exchanging token…');
          const resp = await bounded(fetch('https://kei.aobing.it/api/activity/token', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
          }), 20000);
          if (!resp.ok) throw new Error('token HTTP ' + resp.status);
          const data = await bounded(resp.json(), 10000);
          if (!data.token || !data.uid || !data.appCheckToken) throw new Error('Incomplete Activity sign-in response');
          // Hand off to app.js: it reads window.__ACTIVITY__ to use the custom App Check provider + signIn.
          window.__ACTIVITY__ = {
            customToken: data.token,
            appCheckToken: data.appCheckToken,
            appCheckTtlMillis: data.appCheckTtlMillis,
            uid: data.uid,
            keiBase: 'https://kei.aobing.it',
            // Discord identity (from kei-bot's /token exchange): id is the merge key
            // between the SDK participants roster and the RTDB game nodes; name/avatar
            // persist into the user's profile so the web leaderboard photo-picker works.
            // Optional — the presence panel degrades gracefully if any are absent.
            instanceId: sdk.instanceId,
            discordId: data.discordId,
            discordName: data.discordName,
            discordPhotoURL: data.discordPhotoURL,
            // Roster accessors for the in-game presence panel (presence.js via app.js).
            getParticipants: () => sdk.commands.getInstanceConnectedParticipants(),
            subscribeParticipants: (cb) => {
              sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', cb);
              return () => { try { sdk.unsubscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', cb); } catch (e) {} };
            },
            // External links must go through the SDK in the Activity — a normal navigation
            // to an external site is blocked by the iframe and freezes the app.
            openExternalLink: (url) => sdk.commands.openExternalLink({ url }),
          };
          log('token ok (uid=' + data.uid + '). loading game…');
          window.__loadLibsAndApp();   // now load libs (proxied) + app.js
          log('boot handed to app.js');
        } catch (e) {
          box.style.display = 'block';   // reveal the log only when something went wrong
          log('ERROR: ' + (e && e.message || e));
          console.error('[activity] boot failed', e);
          const retry = document.createElement('button');
          retry.textContent = window.I18N ? I18N.t('mp.retry') : 'Retry';
          retry.onclick = () => location.reload(); box.appendChild(retry);
        }
      })();
    }
  
