# Discord Activity — Architecture & "Will my feature work in the Activity?" Guide

The aobing app runs in **two environments from one codebase**:

1. **Web** — `https://aobing.it` (GitHub Pages), normal browser. Auth via Google/Discord, App Check via reCAPTCHA Enterprise.
2. **Discord Activity** — the same app embedded in an iframe inside Discord (`https://<app-id>.discordsays.com`), served through Discord's proxy.

Everything is gated by **iframe detection**:

```js
const IN_ACTIVITY = location.hostname.endsWith('.discordsays.com');
```

> **Golden rule:** the web path must never change behavior. All Activity-specific code is gated on `IN_ACTIVITY` / `window.__ACTIVITY__`. If you touch the boot, verify the web app still works (load it, sign in, click, check the leaderboard).

---

## 1. The hard constraint: Discord's iframe CSP

Inside the Activity, Discord enforces a strict Content Security Policy. **Only same-origin (`discordsays.com`) and a few Discord hosts are allowed.** Everything else is blocked unless routed through Discord's proxy:

- `script-src 'self' …` → external `<script>` (Firebase SDK, CDN libs) is **blocked**.
- `connect-src 'self' wss://…discordsays.com …` → `fetch`/WebSocket/XHR to external hosts is **blocked**.
- `img-src 'self' … cdn.discordapp.com media.discordapp.net` → external images (Google avatars) are **blocked**.

To reach any external host you must (a) register a **URL Mapping**, and (b) make the request go through Discord's `/.proxy/<prefix>` path.

---

## 2. The proxy / URL-mapping system

Two halves that **must match exactly**:

### a) Client side — `activity-mappings.json` + `patchUrlMappings`
The boot module (in `index.html`, gated to the iframe) fetches `activity-mappings.json` and calls the SDK's `patchUrlMappings(...)`. That patches `fetch`, `WebSocket`, and `XHR` so requests to a mapped host get rewritten to `https://<app>.discordsays.com/.proxy/<prefix>/…`.

**To add a new external host the client calls at runtime (fetch/ws/xhr):** add one line to `activity-mappings.json` — that's it (it's cache-busted, no `index.html` change needed):
```json
{ "prefix": "/my-service", "target": "my-service.example.com" }
```

### b) Discord Dev Portal — URL Mappings
For each entry in `activity-mappings.json`, add a **matching** row in **Dev Portal → your app → Activities → URL Mappings**:
- Prefix: `/my-service`  •  Target: `my-service.example.com` (bare host — no `https://`, no trailing slash, no path).

**Current mappings** (keep `activity-mappings.json` and the Dev Portal in sync):

| Prefix | Target | For |
|---|---|---|
| `/` | `aobing.it` | the app itself (root) |
| `/kei` | `kei.aobing.it` | kei-bot (auth tokens, image proxy) |
| `/firebase-db/{subdomain}` | `{subdomain}.firebaseio.com` | RTDB (see wildcard note) |
| `/firebase-appcheck` | `firebaseappcheck.googleapis.com` | App Check |
| `/firebase-auth` | `identitytoolkit.googleapis.com` | Firebase Auth |
| `/firebase-token` | `securetoken.googleapis.com` | Auth token refresh |
| `/gstatic` | `www.gstatic.com` | Firebase SDK scripts |
| `/jsdelivr` | `cdn.jsdelivr.net` | anime.js, Chart.js |
| `/gfonts` | `fonts.googleapis.com` | Google Fonts CSS |
| `/gfonts-static` | `fonts.gstatic.com` | Google Fonts files |

### Wildcard subdomains (`{subdomain}`)
Some services use **dynamic hosts**. RTDB connects to a regional websocket host like `s-gke-usc1-nssi3-46.firebaseio.com`, *not* the project DB host. A fixed mapping can't match it — use a **parameter-matched** mapping:
`/firebase-db/{subdomain}` → `{subdomain}.firebaseio.com`. The `{subdomain}` placeholder matches any subdomain and is preserved through the proxy. Use the same syntax in both `activity-mappings.json` and the Dev Portal.

---

## 3. Three things that DON'T "just work" in the iframe (and the workarounds)

`patchUrlMappings` reliably rewrites `fetch`/`WebSocket`/`XHR`, but **not** dynamically-set element `src` attributes. We handle those manually:

### a) `<script src>` → manual `proxify()` in the loader
External lib scripts (Firebase/anime/Chart from gstatic/jsdelivr) are loaded dynamically. In the Activity, the loader (`window.__loadLibsAndApp` in `index.html`) rewrites their URLs to `/.proxy/<prefix>/…` itself via `proxify()`. **If you add a new external `<script>`, add its host to `PROXY_MAP` in that loader AND to the mappings.**

### b) `<img src>` (avatars) → kei-bot image proxy
External images are CSP-blocked. We route them through kei-bot's **`GET /api/img?url=<encoded>`** (an allowlisted image proxy: `*.googleusercontent.com`, `cdn.discordapp.com`, `media.discordapp.net`). In `app.js`, the helper `activityImg(url)` rewrites avatar URLs to `/.proxy/kei/api/img?url=…` when in the Activity (Discord CDN images are left alone — already allowed).

**If you render a new external image in the Activity, wrap its URL with `activityImg(...)`.** If it's from a new host, add that host to the kei-bot `_img_host_allowed()` allowlist.

### c) External links / navigation → `openExternalLink` (NOT a normal `<a>`)
A normal `<a href="https://x.com/…">` (or `window.open`, or a same-origin page nav like `/discord/`) tries to **navigate the iframe away** → Discord blocks it → **the app freezes**. In the Activity you must open links via the Discord SDK: `sdk.commands.openExternalLink({ url })`.

We expose it as `window.__ACTIVITY__.openExternalLink(url)` (set in the boot module), and `app.js` installs a **capture-phase click interceptor** (only when `__ACTIVITY__` is set) that catches any `<a>` whose target leaves the current page and routes it through `openExternalLink` instead. Same-origin page navs (e.g. `/discord/`) are opened as `https://aobing.it/<path>` so they leave the iframe cleanly.

**If you add anything that navigates away** (a new external link, a `window.open`, a `location.href = …`), make sure it goes through `openExternalLink` in the Activity — don't navigate the iframe.

---

## 4. App Check (the key enabler)

App Check is **enforced** on RTDB + Auth. The iframe can't run reCAPTCHA, so it can't mint App Check tokens the normal way. Solution: **kei-bot mints them.**

- kei-bot (Python) replicates the Node Admin SDK's `createToken` (`bot/firebase.py: create_app_check_token`) — signs a service-account JWT and POSTs to `firebaseappcheck.googleapis.com/.../:exchangeCustomToken`. Requires env var **`FIREBASE_APP_ID`** on Railway.
- `POST /api/activity/token` returns `{ token (firebase custom token), uid, appCheckToken, appCheckTtlMillis }`.
- In the Activity, `app.js` activates App Check with a **`CustomProvider`** whose `getToken()` returns that token and refreshes via **`POST /api/activity/appcheck-token`** (~hourly).
- **Web path is unchanged** — it still uses `ReCaptchaEnterpriseProvider`. The branch is `if (window.__ACTIVITY__) { CustomProvider } else { ReCaptcha }`.

> Do **not** disable App Check enforcement to "fix" the Activity — it protects the web app (a large fraction of RTDB traffic is unverified/abuse). The custom-provider path keeps it enforced everywhere.

---

## 5. Auth & identity

- The Activity calls `discordSdk.commands.authorize()` → code → `/api/activity/token` → `signInWithCustomToken(customToken)`.
- The token's `uid` is the **canonical uid**: the user's linked Google uid if they've linked, else `discord:<id>`. So a linked user lands on the **same account** whether they play on web or in Discord.
- A Discord-platform custom token carries `platform: "discord"` + `discord_id` claims. **`discord_id` is a STRING** — Discord snowflake IDs exceed 2^53, so an int claim loses precision when Firebase RTDB rules / the JS client read it back. The `activities/*` presence rule compares the node's `discordId` against `auth.token.discord_id`, so they must stay string-equal.
- `/api/activity/token` also returns the player's **Discord identity** — `discordId` (string), `discordName`, `discordPhotoURL` — so the Activity can label the presence panel and persist a Discord avatar for the web leaderboard photo picker. The client never gets the Discord *access token* back (kei-bot exchanges the code server-side), which is why the SDK's authenticated participants API is unavailable — see §9.

---

## 6. Boot order (the Activity, in `index.html`)

```
detect IN_ACTIVITY
 → import vendored Discord SDK (cache-busted)
 → fetch activity-mappings.json (cache-busted) → patchUrlMappings(...)
 → DiscordSDK.ready() → authorize() → code
 → POST /api/activity/token → { customToken, appCheckToken, uid, discordId, discordName, discordPhotoURL }
 → window.__ACTIVITY__ = {...}   // also: instanceId, discordId, discordName, discordPhotoURL
 → window.__loadLibsAndApp()   // loads proxied libs + app.js + typing.js + presence.js
 → app.js: initializeApp → App Check CustomProvider → signInWithCustomToken → ensureDiscordProfile
```
The libs and `app.js` must load **after** `patchUrlMappings` (so their requests are rewritten) — that's why they're loaded dynamically, not via static `<head>` tags. `typing.js` and `presence.js` load after `app.js` (all cache-busted in the Activity).

> **Activity users get a profile too.** `signInWithCustomToken` is followed by `ensureDiscordProfile(uid, discordName, discordPhotoURL)` (mirrors the web Discord-login path). Without it `userProfile` stays null, which gates off the presence panel **and** the leaderboard photo picker (both require a profile).

---

## 7. Caching (why updates sometimes lag)

GitHub Pages forces `Cache-Control: max-age=600` (~10 min) and Discord's proxy caches accordingly. To keep updates landing:

- **`app.js`, `activity-mappings.json`, and the SDK are cache-busted** (`?t=<launch>`) in the Activity → always fresh on launch.
- **`index.html` is the only file with the ~10-min lag** (Discord loads `/` directly; its headers can't be overridden on GitHub Pages). It's a thin, stable shell — keep it that way. Mappings live in `activity-mappings.json` precisely so you don't need to touch `index.html` to change them.
- After an `index.html` change: wait ~10 min and **fully close/reopen** the Activity (a client reload can't evict Discord's server-side proxy cache).
- **Desktop vs mobile cache separately.** It's normal to see fresh data on mobile but a stale build on desktop (or vice-versa). On desktop, fully **Quit Discord** (system-tray → Quit, not just close the window) and reopen; or use the devtools trick below.

---

## 7.5 Debugging in the Activity (devtools gotchas)

You can only test the Activity by launching it in Discord. Open devtools in the activity window (`Ctrl+Shift+I`). Two things will trip you up:

1. **The console runs in the wrong frame by default.** The context dropdown (top-left of the Console tab) defaults to **`top`** = the Discord client, where `firebase`/your globals don't exist (`firebase is not defined`). **Switch it to the `…discordsays.com` frame** to run commands against the actual app. (Errors from all frames still show; only typed commands use the selected frame.)
2. **Use Network → "Disable cache"** (with devtools open) to bypass the client cache while iterating on desktop — the most reliable way to always pull fresh.
3. **CSP-blocked script URLs are redacted** to `<URL>` in the console. To see the real one, use **Network → filter JS → the red `blocked:csp` request**, not a `securitypolicyviolation` listener (which also runs in the wrong frame and fires before you attach it).
4. **The on-screen corner log** (`#activity-log`) is hidden on success and only reveals itself if the boot throws — so a visible green box means the boot errored; read it.

---

## 8. kei-bot endpoints used by the Activity

| Endpoint | Purpose |
|---|---|
| `POST /api/activity/token` | Discord code → Firebase custom token + bootstrap App Check token + Discord identity (`discordId`/`discordName`/`discordPhotoURL`) |
| `POST /api/activity/appcheck-token` | refresh App Check token (gated to `platform=discord`) |
| `GET /api/img?url=` | allowlisted image proxy for avatars |
| `POST /api/link/start` + `GET /api/link/callback` | web Discord linking (popup) |
| `GET /api/link/compare` + `POST /api/link/resolve` | "keep which save" merge |
| `POST /api/link/unlink` + `GET /api/link/status` | unlink Discord / linked-state |
| `POST /api/web/discord/start` + `GET /api/web/discord/callback` | web "Sign in with Discord" |

---

## 9. In-Activity presence panel + dual identity

An always-visible panel (bottom-right, above the `#system-time` clock) shows who else is in **this Activity instance**, with their Discord identity, in-game identity, and total / this-session clicks. Active members sit on top; departed members drop into a dimmed **"Left"** section. It also drives a **leaderboard photo picker** in the profile panel (Google / Discord / Hidden). All of this is Discord-only — `presence.js` is inert on the web (no `window.__ACTIVITY__`).

### The big gotcha: the SDK participants API doesn't work here → **pure-RTDB instead**
`getInstanceConnectedParticipants()` and the `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE` subscribe require an **`authenticate()`-d SDK session**. Our boot does `authorize()` but kei-bot exchanges the code server-side, so the client never gets the Discord *access token* to call `authenticate()`. Calling those APIs throws **`{ code: 4006, "Not authenticated or invalid scope" }`**.

So presence is **pure RTDB**: each client self-registers at `activities/{instanceId}/participants/{uid}`, writing its **own** Discord identity (from the `/api/activity/token` response), its in-game identity, click totals, and `active: true`. The panel renders entirely from that node list — no SDK roster. In an Activity "self-registered in this instance" == "in the call", so nothing real is lost.

- **Presence/leave:** `onDisconnect().update({ active: false, leftAt })` (NOT remove) so a departed player moves to "Left" instead of vanishing. Re-joining flips `active` back to true.
- **Identity trust:** the RTDB rule pins `participants/$uid/discordId === auth.token.discord_id` (the string claim), so a client can't spoof another's row. `totalClicks` is capped to the user's real `stats/totalClicks (+10k)`; `sessionClicks` is cosmetic.
- **Files:** `presence.js` (new, cache-busted) — pure layer (`buildRows` / `resolveLeaderboardPhoto` / `photoOptionsFor`, unit-tested in `presence.test.js`) + `window.Presence.init(deps)` browser wiring. `app.js` wires it after the profile loads. Panel position is set via **inline styles in `presence.js`**, so re-positioning needs no `index.html` change.

### Dual-identity leaderboard photo picker
The leaderboard **name** is always the custom display name; only the **photo** is selectable: Google avatar / Discord avatar / Hidden (placeholder). Stored at `users/{uid}/profile/leaderboardPhoto`. The leaderboard `photoURL` RTDB rule is relaxed to accept exactly `'' | profile.photoURL | profile.discordPhotoURL` (still anti-spoof). The Discord avatar is persisted to `users/{uid}/profile/discordPhotoURL` on Activity launch so the picker works on the **web** too.

### Gotcha: global `<script>` files share one scope
`app.js`, `typing.js`, and `presence.js` are plain (non-module) scripts — they all execute in the **same global scope**. Two of them declaring the same top-level `const`/`var` (e.g. both had `ENGINE`) throws `Identifier '…' has already been declared` at parse time and the **whole file silently fails to run**. Keep each file's top-level identifiers unique (presence.js uses `PRESENCE_ENGINE`).

> Most presence work ships **without touching `index.html`**: `presence.js` is cache-busted, RTDB rules deploy via `firebase deploy --only database`, and the kei-bot token fields deploy via Railway. So you skip the 10-min `index.html` cache lag (§7) — a relaunch picks up `presence.js`.

---

## ✅ Checklist: adding a feature — does it work in the Activity?

Before assuming a new feature works in Discord, ask:

1. **Does it load a new external `<script>`?** → add the host to `PROXY_MAP` (loader in `index.html`) **and** to `activity-mappings.json` + Dev Portal.
2. **Does it `fetch`/WebSocket/XHR a new external host?** → add it to `activity-mappings.json` + Dev Portal. (No code change beyond the JSON.) Watch for **dynamic subdomains** → use `{subdomain}` wildcard.
3. **Does it show a new external `<img>`?** → wrap the URL with `activityImg(...)`; add the host to kei-bot `_img_host_allowed()` if it's new.
4. **Does it open an external link or navigate away** (new `<a href>`, `window.open`, `location.href = …`)? → route it through `window.__ACTIVITY__.openExternalLink(url)` in the Activity, or it freezes the iframe.
5. **Does it make an RTDB/Auth call?** → already covered by App Check custom provider + the firebase mappings; nothing extra.
6. **Did you add a new `<head>` `<link>`/`<script>`?** → it'll be CSP-blocked in the iframe. Load it dynamically via the loader instead (and proxify/map it).
7. **Does it rely on `window`/`document` timing at parse?** → remember `app.js` loads *after* the Discord auth flow in the Activity, not at page parse.
8. **Web regression check** → load `aobing.it` (not the Activity) and confirm sign-in + leaderboard + clicking still work. The web path must be byte-identical.
9. **Does it call a Discord SDK command beyond `authorize`** (e.g. `getInstanceConnectedParticipants`, channel/guild reads)? → those need an **`authenticate()`-d** session, which our server-side-token-exchange boot can't establish → **error 4006**. Prefer an RTDB/kei-bot path (see §9).
10. **Add a new global `<script>`?** → it shares scope with `app.js`/`typing.js`/`presence.js`; keep top-level identifiers unique or it throws "already declared" and silently fails to run (§9).
11. **Test live** → the Activity can only be tested by launching it in Discord. Switch the console off `top` to the `discordsays.com` frame (§7.5); CSP errors name the exact host/script that needs a mapping.

---

## Status (as of 2026-06-16)

The Activity is **live and functional** on desktop and mobile: it loads, signs into the unified account (App Check via kei-bot minting), runs the game, syncs RTDB (stats, leaderboard, global count), shows avatars via the image proxy, opens external links via `openExternalLink`, and cache-busts updates. The **in-Activity presence panel** (pure-RTDB, with active/Left sections) and the **dual-identity leaderboard photo picker** are live (§9). The web app is unchanged.

**Known cosmetic issue:** a `Refused to load the script '<URL>'` (`script-src`) message appears a handful of times in the activity console. It does **not** break anything (auth + RTDB both work). The URL is redacted by Chrome; it was never pinned down. If you want to chase it, use Network → JS → the red `blocked:csp` request to get the real URL, then map or suppress whatever loads it.

---

*Last updated: 2026-06-16. If the proxy mapping list changes, update both `activity-mappings.json` (client) and the Discord Dev Portal URL Mappings — they must match.*
