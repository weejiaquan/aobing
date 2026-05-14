# Auth + Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-user identity (anonymous + Google-linkable), a Blue-Archive-style profile bar (name/level/XP/coins), a leaderboard ranked by mouse/tap clicks, and security rules that block casual cheating — all in a static frontend + Firebase RTDB project with no new hosting.

**Architecture:** Firebase Auth (anonymous baseline → linkWithPopup for Google) provides a stable UID per visitor. Per-user data lives at `users/{uid}/{profile,stats}` in RTDB. A denormalized `leaderboard/topClicks/{uid}` projection enables cheap board reads. All UI stays inline in `index.html` to match existing project style. Mouse/tap clicks write user stats; keyboard clicks only feed site-wide totals (so spam-keyboarding doesn't pad the leaderboard).

**Tech Stack:** Firebase Auth compat SDK v10, Firebase RTDB compat SDK v10 (already in use), vanilla JS (no build step), inline HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-05-14-auth-and-leaderboard-design.md`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `index.html` | Modify | All HTML/CSS/JS — auth init, sensei bar, profile panel, leaderboard modal, click write logic |
| `database.rules.json` | Modify | Add `users/{uid}/*` private gates and `leaderboard/topClicks/*` public read; preserve existing `clicks`, `daily`, `skins`, `combo`, `kei` rules |

No new files. Stays single-file static per existing project convention.

---

## Verification environment (referenced by tasks)

Tasks that verify in a browser assume this loop is running:

```bash
# Start in repo root
python -m http.server 8765
```

Playwright MCP (or just opening `http://localhost:8765/index.html` in any browser with DevTools) is used to interact with the page. Tasks reference specific browser-evaluatable assertions instead of pytest-style tests because the project has no test runner and isn't getting one.

**Firebase Console manual steps** are called out explicitly when needed. The user performs them — no code can enable Auth providers.

---

## Phase A — Auth foundation

### Task A1: Enable Auth providers in Firebase Console

**Files:** None (manual configuration in Firebase Console UI)

- [ ] **Step 1: Open the Firebase Console for the `aobing-dfe10` project**

Navigate to https://console.firebase.google.com/project/aobing-dfe10/authentication/providers

- [ ] **Step 2: Enable Anonymous provider**

Click "Anonymous" → toggle Enable → Save.

- [ ] **Step 3: Enable Google provider**

Click "Google" → toggle Enable → set "Project support email" → Save.

- [ ] **Step 4: Add the production domain to authorized domains**

In the Authentication → Settings → Authorized domains tab, confirm `aobing.it` and `localhost` are present. Add `aobing.it` if missing (default for new projects only includes the firebaseapp.com domain and localhost).

- [ ] **Step 5: Verify**

Reload the Firebase Console Auth tab; both providers should show "Enabled" status.

No commit (config-only task).

---

### Task A2: Add Firebase Auth SDK + anonymous sign-in on page load

**Files:**
- Modify: `index.html` (around line 1283, where Firebase scripts live)

- [ ] **Step 1: Add the Firebase Auth SDK script tag**

In `index.html`, locate the existing Firebase SDK scripts (look for `firebase-app-compat.js` and `firebase-database-compat.js`). Add the Auth SDK script *after* `firebase-app-compat.js`:

```html
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js"></script>
```

- [ ] **Step 2: Add auth initialization near the top of `<script>` (right after the Firebase initialization)**

Find:
```js
const db = firebase.database();
const clicksRef = db.ref('clicks');
```

Add immediately after:
```js
const auth = firebase.auth();

// --- User identity ------------------------------------------------------------
// auth.uid is the source of truth for per-user data. Anonymous on first visit;
// upgraded to Google via linkWithPopup later. The promise resolves once auth
// state is known so downstream code (click handlers, sensei bar) can read uid
// without races.
let currentUser = null;
const authReady = new Promise((resolve) => {
  auth.onAuthStateChanged((user) => {
    currentUser = user;
    if (!user) {
      auth.signInAnonymously().catch((e) => {
        console.error('Anonymous sign-in failed', e);
        resolve(null);
      });
      return;
    }
    resolve(user);
  });
});
```

- [ ] **Step 3: Start the dev server and verify in browser**

```bash
python -m http.server 8765
```

Open `http://localhost:8765/index.html` in DevTools. In the console:
```js
await authReady;
console.log(currentUser.uid, currentUser.isAnonymous);
```

Expected: A 28-char UID string and `true` (anonymous). No console errors.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add Firebase Auth with anonymous-by-default sign-in"
```

---

### Task A3: Replace `aobing_visitor_id` with `auth.uid` for daily-visitor uniqueness

**Files:**
- Modify: `index.html` (the visitor-tracking block, around line 1324)

- [ ] **Step 1: Locate the existing visitor-tracking block**

Find this block:
```js
// --- Track unique daily visitors ---
let visitorId = localStorage.getItem('aobing_visitor_id');
if (!visitorId) {
  visitorId = crypto.randomUUID();
  localStorage.setItem('aobing_visitor_id', visitorId);
}
const visitKey = 'aobing_visited_' + todayKey();
if (!sessionStorage.getItem(visitKey)) {
  sessionStorage.setItem(visitKey, '1');
  db.ref('daily/' + todayKey() + '/visitors/' + visitorId).set(true);
}
```

- [ ] **Step 2: Replace with UID-based tracking**

```js
// --- Track unique daily visitors ---
// Uses the Firebase Auth UID (28 chars, satisfies the `visitorId.length <= 64`
// rule). Old `aobing_visitor_id` is removed so localStorage isn't littered.
localStorage.removeItem('aobing_visitor_id');
authReady.then((user) => {
  if (!user) return;
  const visitKey = 'aobing_visited_' + todayKey();
  if (!sessionStorage.getItem(visitKey)) {
    sessionStorage.setItem(visitKey, '1');
    db.ref('daily/' + todayKey() + '/visitors/' + user.uid).set(true);
  }
});
```

- [ ] **Step 3: Verify**

In the browser console:
```js
localStorage.getItem('aobing_visitor_id')   // → null
await authReady;
// Check the actual write in Firebase Console RTDB under daily/{today}/visitors/
```

You should see a new entry keyed by the 28-char UID for today's date.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Use Firebase Auth UID as daily-visitor key"
```

---

### Task A4: Wire mouse/tap clicks to write per-user stats

**Files:**
- Modify: `index.html` (the `triggerClick` function, around line 2395, and the `endIntro` function around line 2354 which has the same write logic for the first-click)

- [ ] **Step 1: Add a helper that writes per-user click stats**

Insert near the other Firebase helpers (right after `subscribeCurrentSkinCount` near line 2257):

```js
// --- Per-user click stats ----------------------------------------------------
// Each mouse/tap fires a single multi-path update so totalClicks, coinBalance,
// and lastClickAt land together. ServerValue.increment + ServerValue.TIMESTAMP
// keep the increments atomic and the timestamp authoritative; the security
// rules enforce +1-only and the 15ms throttle, so a malicious client can't
// inflate values via the console.
function writeUserClick() {
  if (!currentUser) return;
  const uid = currentUser.uid;
  const inc = firebase.database.ServerValue.increment(1);
  const ts  = firebase.database.ServerValue.TIMESTAMP;
  db.ref().update({
    [`users/${uid}/stats/totalClicks`]: inc,
    [`users/${uid}/stats/coinBalance`]: inc,
    [`users/${uid}/stats/lastClickAt`]: ts,
  }).catch(() => {
    // Throttle hits / network blips: silent. We deliberately don't surface
    // them because the optimistic UI already showed the +1.
  });
}
```

- [ ] **Step 2: Split `triggerClick` into mouse vs keyboard paths**

Find:
```js
character.addEventListener('click', triggerClick);
document.addEventListener('keydown', triggerClick);
```

Replace with:
```js
character.addEventListener('click', () => triggerClick({ source: 'mouse' }));
document.addEventListener('keydown', (e) => {
  // Existing keyboard handler — every key counts as a click. New: opt-out
  // via setting, and never feeds per-user stats.
  if (settings.keyboardClicks === false) return;
  triggerClick({ source: 'keyboard' });
});
```

- [ ] **Step 3: Update `triggerClick` to accept the source param and call `writeUserClick` only for mouse**

Find `function triggerClick() {` (around line 2395) and update its signature:

```js
function triggerClick(opts) {
  const source = opts && opts.source === 'keyboard' ? 'keyboard' : 'mouse';

  // During intro, end intro (first click counts)
  if (introActive) {
    endIntro({ source });
    return;
  }

  // ... existing body up through the global writes ...

  // Per-user stats — mouse/tap only. Keyboard is a satisfaction feature,
  // not a leaderboard input.
  if (source === 'mouse') writeUserClick();

  // ... rest of existing body unchanged
}
```

Same change to `endIntro`: accept `opts` and call `writeUserClick()` only if `source === 'mouse'`.

- [ ] **Step 4: Verify in browser**

```js
await authReady;
// Mouse click: simulate via the dispatched event
document.getElementById('character').click();
// Wait a tick for the Firebase write to roundtrip
await new Promise(r => setTimeout(r, 600));
const snap = await firebase.database().ref('users/' + currentUser.uid + '/stats').once('value');
console.log(snap.val());
// Expected: { totalClicks: 1, coinBalance: 1, lastClickAt: <number> }

// Keyboard press: should NOT write to user stats
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
await new Promise(r => setTimeout(r, 600));
const snap2 = await firebase.database().ref('users/' + currentUser.uid + '/stats').once('value');
console.log(snap2.val());
// Expected: still { totalClicks: 1, coinBalance: 1, lastClickAt: <number> }
//           (unchanged from the mouse click above)
```

Note: this test runs against the *current* permissive rules. Security rules will block these writes until Task B1 is deployed — but the multi-path syntax and Firebase return values still work in tests. If writes fail with "PERMISSION_DENIED" before B1 is deployed, that's expected; the rules deploy is the gate.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Wire mouse/tap clicks to per-user stats; keyboard excluded"
```

---

### Task A5: Add "Keyboard clicks" toggle to settings panel

**Files:**
- Modify: `index.html` (settings panel HTML around line 1187 and the I18N module)

- [ ] **Step 1: Add the toggle row in the settings panel HTML**

Find the existing Effects row:
```html
<div class="settings-row">
  <span class="settings-label" data-i18n="settings.effects">Effects</span>
  <button id="effects-toggle" class="settings-toggle on"></button>
</div>
```

Add immediately after:
```html
<div class="settings-row">
  <span class="settings-label" data-i18n="settings.keyboard_clicks">Keyboard clicks</span>
  <button id="keyboard-toggle" class="settings-toggle on"></button>
</div>
```

- [ ] **Step 2: Add the toggle handler and persist it**

Find the existing `DEFAULT_SETTINGS`:
```js
const DEFAULT_SETTINGS = { musicVol: 10, sfxVol: 50, effects: true, skin: 'aoba' };
```

Replace with:
```js
const DEFAULT_SETTINGS = { musicVol: 10, sfxVol: 50, effects: true, skin: 'aoba', keyboardClicks: true };
```

Find the effects toggle handler block (search for `effectsToggle.addEventListener`) and add immediately after it:

```js
// --- Keyboard clicks toggle ---
const keyboardToggle = document.getElementById('keyboard-toggle');
if (settings.keyboardClicks === false) keyboardToggle.classList.remove('on');
keyboardToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  settings.keyboardClicks = !settings.keyboardClicks;
  keyboardToggle.classList.toggle('on', settings.keyboardClicks);
  saveSettings(settings);
});
```

Also update `applySettings` to sync the new toggle on reset:
```js
function applySettings(s) {
  bgm.volume = s.musicVol / 100;
  musicSlider.value = s.musicVol;
  sfxSlider.value = s.sfxVol;
  effectsToggle.classList.toggle('on', s.effects);
  keyboardToggle.classList.toggle('on', s.keyboardClicks);
  applyVariant(s.skin);
  renderSkinList();
}
```

- [ ] **Step 3: Add the English i18n key (other locales added in Phase F)**

In the `I18N` module, find the English block:
```js
'settings.language':'Language','settings.join_discord':'Join Discord','settings.follow_x':'Follow me on X','settings.reset_defaults':'Reset defaults',
```

Insert before `'settings.reset_defaults'`:
```js
'settings.keyboard_clicks':'Keyboard clicks',
```

- [ ] **Step 4: Verify**

Open the settings panel in the browser. The "Keyboard clicks" row appears with a toggle in the ON state. Click it OFF; press a key. Combo bar / particles do not fire. Click it back ON; press a key. They fire again.

```js
JSON.parse(localStorage.getItem('aobing-settings')).keyboardClicks
// Should reflect the toggle state
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add Keyboard clicks toggle (default ON) to settings"
```

---

## Phase B — Security rules

### Task B1: Update `database.rules.json` and deploy

**Files:**
- Modify: `database.rules.json`

- [ ] **Step 1: Add user-scoped and leaderboard sections**

Replace the contents of `database.rules.json` with:

```json
{
  "rules": {
    "clicks": {
      ".read": true,
      ".write": true,
      ".validate": "newData.isNumber()"
    },
    "skins": {
      ".read": true,
      "$variantId": {
        ".write": true,
        ".validate": "newData.isNumber() && $variantId.length <= 20"
      }
    },
    "combo": {
      ".read": true,
      "allTime": {
        ".write": true,
        ".validate": "newData.isNumber()"
      }
    },
    "daily": {
      ".read": true,
      "$date": {
        "total": {
          ".write": true,
          ".validate": "newData.isNumber()"
        },
        "countries": {
          "$country": {
            ".write": true,
            ".validate": "newData.isNumber() && $country.length == 2"
          }
        },
        "skins": {
          "$skinId": {
            ".write": true,
            ".validate": "newData.isNumber() && $skinId.length <= 20"
          }
        },
        "characters": {
          "$characterId": {
            ".write": true,
            ".validate": "newData.isNumber() && $characterId.length <= 20"
          }
        },
        "maxCombo": {
          ".write": true,
          ".validate": "newData.isNumber()"
        },
        "visitors": {
          "$visitorId": {
            ".write": true,
            ".validate": "newData.isBoolean() && $visitorId.length <= 64"
          }
        }
      }
    },
    "kei": {
      ".read": true,
      "completions":          { ".write": true, ".validate": "newData.isNumber()" },
      "totalHeadpatSeconds":  { ".write": true, ".validate": "newData.isNumber()" },
      "totalVoicelines":      { ".write": true, ".validate": "newData.isNumber()" },
      "totalInteractions":    { ".write": true, ".validate": "newData.isNumber()" },
      "totalPinches":         { ".write": true, ".validate": "newData.isNumber()" },
      "totalEyeTracks":       { ".write": true, ".validate": "newData.isNumber()" }
    },
    "users": {
      "$uid": {
        ".read":  "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid",
        "profile": {
          "displayName": { ".validate": "newData.isString() && newData.val().length >= 1 && newData.val().length <= 24" },
          "country":     { ".validate": "newData.isString() && newData.val().length === 2" },
          "photoURL":    { ".validate": "newData.isString() && newData.val().length <= 500" },
          "provider":    { ".validate": "newData.isString() && newData.val().length <= 32" },
          "linkedAt":    { ".validate": "newData.isNumber()" }
        },
        "stats": {
          "totalClicks": {
            ".validate": "newData.isNumber() && newData.val() === (data.val() || 0) + 1 && now - (data.parent().child('lastClickAt').val() || 0) >= 15 && newData.parent().child('lastClickAt').val() === now"
          },
          "coinBalance": {
            ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= (data.val() || 0) + 1"
          },
          "lastClickAt": {
            ".validate": "newData.val() === now"
          },
          "maxCombo": { ".validate": "newData.isNumber()" },
          "createdAt": { ".validate": "newData.isNumber()" },
          "skins": {
            "$variantId": {
              ".validate": "newData.isNumber() && $variantId.length <= 20"
            }
          }
        }
      }
    },
    "leaderboard": {
      "topClicks": {
        ".read": true,
        ".indexOn": "totalClicks",
        "$uid": {
          ".write": "auth != null && auth.uid === $uid && root.child('users').child($uid).child('profile').exists()",
          "name":        { ".validate": "newData.isString() && newData.val().length <= 24" },
          "country":     { ".validate": "newData.isString() && newData.val().length === 2" },
          "photoURL":    { ".validate": "newData.isString() && newData.val().length <= 500" },
          "totalClicks": { ".validate": "newData.isNumber()" },
          "level":       { ".validate": "newData.isNumber()" }
        }
      }
    },
    ".read": false,
    ".write": false
  }
}
```

- [ ] **Step 2: Deploy via Firebase CLI**

If Firebase CLI is installed (`firebase --version` returns a version):

```bash
firebase deploy --only database
```

Otherwise paste the file contents into Firebase Console → Realtime Database → Rules tab → Publish.

- [ ] **Step 3: Verify in browser**

```js
await authReady;
const uid = currentUser.uid;

// Should now succeed
document.getElementById('character').click();
await new Promise(r => setTimeout(r, 600));
const a = await firebase.database().ref('users/' + uid + '/stats/totalClicks').once('value');
console.log('totalClicks:', a.val());  // 1

// Should fail with PERMISSION_DENIED — increment by 1000 violates the +1 rule
firebase.database().ref('users/' + uid + '/stats/totalClicks').set(1001)
  .then(() => console.log('UNEXPECTED: write succeeded'))
  .catch(e => console.log('Expected denial:', e.code));
// Expected: "Expected denial: PERMISSION_DENIED"

// Should fail — writing to another UID
firebase.database().ref('users/some-other-uid/stats/totalClicks').set(1)
  .then(() => console.log('UNEXPECTED: write succeeded'))
  .catch(e => console.log('Expected denial:', e.code));
// Expected: "Expected denial: PERMISSION_DENIED"
```

- [ ] **Step 4: Commit**

```bash
git add database.rules.json
git commit -m "Add user-scoped + leaderboard security rules"
```

---

## Phase C — Sensei profile bar

### Task C1: Add the sensei bar HTML + CSS

**Files:**
- Modify: `index.html` (CSS section ~line 992 area; HTML around line 1168 with the other pills)

- [ ] **Step 1: Add the CSS for the sensei bar**

After the `#system-time` block (~line 393), add:

```css
/* --- Sensei Bar (BA-style profile pill, bottom-left) ----------------------- */
#sensei-bar {
  position: fixed;
  left: 16px;
  bottom: 28px;
  width: 240px;
  padding: 8px 12px 10px;
  background: var(--ba-card-bg);
  border: var(--ba-card-border);
  border-radius: 14px;
  box-shadow: var(--ba-card-shadow);
  color: var(--ba-text);
  font-size: 0.78rem;
  z-index: 50;
  cursor: pointer;
  user-select: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
#sensei-bar:hover { transform: translateY(-1px); box-shadow: 0 18px 48px rgba(0,30,60,0.28); }

.sensei-row1 { display: flex; align-items: center; gap: 8px; }
.sensei-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--ba-accent-soft);
  border: 1px solid rgba(160,195,230,0.45);
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; color: var(--ba-accent-strong);
  font-size: 0.85rem; flex-shrink: 0; object-fit: cover;
}
.sensei-name {
  flex: 1; min-width: 0;
  font-weight: 800;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--ba-text);
}
.sensei-flag { font-size: 0.95rem; }
.sensei-level {
  font-weight: 800; color: var(--ba-accent-strong);
  font-variant-numeric: tabular-nums;
}

.sensei-xp-bar {
  margin-top: 6px;
  height: 5px;
  background: rgba(60,90,130,0.18);
  border-radius: 3px;
  overflow: hidden;
}
.sensei-xp-fill {
  height: 100%; width: 0%;
  background: linear-gradient(90deg, var(--ba-accent), var(--ba-yellow));
  border-radius: 3px;
  transition: width 0.4s ease;
}
.sensei-xp-fill.pulse { animation: sensei-pulse 0.35s ease-out; }
@keyframes sensei-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(77,171,247,0.6); }
  100% { box-shadow: 0 0 0 14px rgba(77,171,247,0); }
}

.sensei-row2 {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 4px;
  font-size: 0.72rem; color: var(--ba-text-muted);
  font-variant-numeric: tabular-nums;
}
.sensei-coins { color: var(--ba-accent-strong); font-weight: 700; }
.sensei-cta { color: var(--ba-accent-strong); font-weight: 700; }

@media (max-width: 480px) {
  #sensei-bar { left: 8px; bottom: 18px; width: 200px; padding: 6px 10px 8px; }
  .sensei-avatar { width: 22px; height: 22px; font-size: 0.7rem; }
}
```

- [ ] **Step 2: Add the sensei bar HTML**

After the existing `#system-time` element (~line 1168), insert:

```html
<!-- Sensei profile bar (bottom-left) -->
<div id="sensei-bar" role="button" aria-label="Profile">
  <div class="sensei-row1">
    <div class="sensei-avatar" id="sensei-avatar">?</div>
    <span class="sensei-name" id="sensei-name" data-i18n="sensei.trainer">Trainer</span>
    <span class="sensei-flag" id="sensei-flag"></span>
    <span class="sensei-level" id="sensei-level">Lv.0</span>
  </div>
  <div class="sensei-xp-bar"><div class="sensei-xp-fill" id="sensei-xp-fill"></div></div>
  <div class="sensei-row2">
    <span><span id="sensei-xp-text">0 / 20</span></span>
    <span><span class="sensei-coins">💰 <span id="sensei-coins">0</span></span></span>
  </div>
</div>
```

- [ ] **Step 3: Add the English `sensei.trainer` i18n key**

In the `I18N` module's English block, add alongside the other `sensei.*` keys (you'll add them gradually; just `sensei.trainer` for now):

Find the line with `'settings.title':'Settings'` and add a new line below the settings block:
```js
'sensei.trainer':'Trainer',
```

- [ ] **Step 4: Verify**

Reload the page. A small profile card appears in the bottom-left showing `? Trainer Lv.0` and `0 / 20 💰 0`. Hovering raises it slightly.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add sensei profile bar UI (bottom-left, static)"
```

---

### Task C2: Subscribe sensei bar to live user stats

**Files:**
- Modify: `index.html` (script section, near the existing `subscribeCurrentSkinCount`)

- [ ] **Step 1: Add the level math and a renderer**

Insert after the user-stats helper from Task A4:

```js
// --- Sensei bar live state ---------------------------------------------------
// Level curve (cosmetic): level = floor(sqrt(clicks/20))
// Lv.1 at 20 clicks, Lv.10 at 2k, Lv.50 at 50k, Lv.100 at 200k.
function levelOf(clicks)             { return Math.floor(Math.sqrt(clicks / 20)); }
function clicksForLevel(n)           { return n * n * 20; }
function clicksInLevel(c)            { return c - clicksForLevel(levelOf(c)); }
function clicksToNextLevel(c)        { return clicksForLevel(levelOf(c) + 1) - clicksForLevel(levelOf(c)); }

const senseiAvatarEl = document.getElementById('sensei-avatar');
const senseiNameEl   = document.getElementById('sensei-name');
const senseiFlagEl   = document.getElementById('sensei-flag');
const senseiLevelEl  = document.getElementById('sensei-level');
const senseiXpFillEl = document.getElementById('sensei-xp-fill');
const senseiXpTextEl = document.getElementById('sensei-xp-text');
const senseiCoinsEl  = document.getElementById('sensei-coins');

let userStats = { totalClicks: 0, coinBalance: 0 };
let userProfile = null;
let userStatsUnsub = null;
let userProfileUnsub = null;

function flagFromCountry(code) {
  if (!code || code.length !== 2) return '';
  return code.toUpperCase().replace(/./g, c =>
    String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

function renderSenseiBar() {
  const clicks = userStats.totalClicks || 0;
  const lv = levelOf(clicks);
  const cur = clicksInLevel(clicks);
  const need = clicksToNextLevel(clicks);
  senseiLevelEl.textContent = 'Lv.' + lv;
  senseiXpFillEl.style.width = (need > 0 ? Math.min(100, cur / need * 100) : 0) + '%';
  senseiXpTextEl.textContent = cur.toLocaleString() + ' / ' + need.toLocaleString();
  senseiCoinsEl.textContent = (userStats.coinBalance || 0).toLocaleString();

  // Profile-dependent fields
  if (userProfile) {
    senseiNameEl.textContent = userProfile.displayName || I18N.t('sensei.trainer');
    senseiFlagEl.textContent = flagFromCountry(userProfile.country);
    if (userProfile.photoURL) {
      senseiAvatarEl.outerHTML = `<img class="sensei-avatar" id="sensei-avatar" src="${userProfile.photoURL}" alt="">`;
    }
  } else {
    senseiNameEl.textContent = I18N.t('sensei.trainer');
    senseiFlagEl.textContent = '';
  }
}

function subscribeUserData(uid) {
  if (userStatsUnsub)   { userStatsUnsub();   userStatsUnsub = null; }
  if (userProfileUnsub) { userProfileUnsub(); userProfileUnsub = null; }
  if (!uid) { userStats = { totalClicks: 0, coinBalance: 0 }; userProfile = null; renderSenseiBar(); return; }

  const statsRef = db.ref('users/' + uid + '/stats');
  const statsCb  = (snap) => { userStats = snap.val() || { totalClicks: 0, coinBalance: 0 }; renderSenseiBar(); };
  statsRef.on('value', statsCb);
  userStatsUnsub = () => statsRef.off('value', statsCb);

  const profRef = db.ref('users/' + uid + '/profile');
  const profCb  = (snap) => { userProfile = snap.val(); renderSenseiBar(); };
  profRef.on('value', profCb);
  userProfileUnsub = () => profRef.off('value', profCb);
}

// Wire to auth state — re-subscribe on UID change
auth.onAuthStateChanged((user) => {
  subscribeUserData(user ? user.uid : null);
});

// Initial render before any data lands
renderSenseiBar();
```

- [ ] **Step 2: Make the sensei bar re-render on language change**

Find the existing `i18nchange` event listener (near the end of the script) and append:

```js
// Re-render sensei bar on language change so the "Trainer" fallback retranslates
renderSenseiBar();
```

- [ ] **Step 3: Verify**

```js
await authReady;
// Click a few times via the actual button
const el = document.getElementById('character');
for (let i = 0; i < 5; i++) { el.click(); await new Promise(r => setTimeout(r, 100)); }
await new Promise(r => setTimeout(r, 500));
// Sensei bar should now show Lv.0 still, but the XP text should read "5 / 20"
// and the XP fill width should be 25%.
document.getElementById('sensei-xp-text').textContent
// → "5 / 20"
```

Visual check: open the page, click rapidly, the XP fill animates up and the coin counter increments live.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Wire sensei bar to live user stats subscriptions"
```

---

### Task C3: Mouse-click feedback — `+1` floater and XP fill pulse

**Files:**
- Modify: `index.html` (the `triggerClick` function from Task A4, and CSS for the floater)

- [ ] **Step 1: Add CSS for the floating `+1` indicator**

After the `.particle` styles (around line 1012):

```css
.click-plusone {
  position: fixed;
  font-weight: 900;
  font-size: 1.3rem;
  color: var(--ba-accent-strong);
  text-shadow: 0 2px 6px rgba(255,255,255,0.85), 0 0 8px rgba(77,171,247,0.45);
  pointer-events: none;
  user-select: none;
  z-index: 55;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 2: Add a `spawnPlusOne()` helper near `spawnParticles`**

```js
function spawnPlusOne(x, y) {
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
    onComplete: () => el.remove(),
  });
}
```

- [ ] **Step 3: Wire the floater + XP pulse on mouse clicks only**

Update the click handler that calls `triggerClick({ source: 'mouse' })`:

```js
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
  void senseiXpFillEl.offsetWidth;        // restart animation
  senseiXpFillEl.classList.add('pulse');
});
```

- [ ] **Step 4: Verify**

Click the character several times. Each click spawns a `+1` floating up. The sensei bar XP fill pulses. Press any keyboard key — no `+1`, no pulse, but the combo bar still bumps. This confirms the visual asymmetry that the spec calls "the absence is the signal".

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Visual feedback for mouse clicks: +1 floater and XP pulse"
```

---

## Phase D — Profile editor + Google sign-in

### Task D1: Profile panel scaffold + open/close from sensei bar

**Files:**
- Modify: `index.html` (CSS + HTML + click handler on sensei bar)

- [ ] **Step 1: Add CSS for the profile panel**

After the `#settings-panel` CSS (~line 440 area):

```css
/* --- Profile Panel (BA white card, anchored above sensei bar) ------------- */
#profile-panel {
  position: fixed;
  left: 16px;
  bottom: 100px;
  width: 280px;
  background: var(--ba-card-bg);
  border: var(--ba-card-border);
  border-radius: 14px;
  padding: 14px 16px 16px;
  color: var(--ba-text);
  font-size: 0.85rem;
  box-shadow: var(--ba-card-shadow);
  z-index: 60;
  transform: translateY(8px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
#profile-panel.open { opacity: 1; pointer-events: auto; transform: translateY(0); }

.profile-input, .profile-select {
  width: 100%;
  background: var(--ba-card-bg-soft);
  border: 1px solid var(--ba-divider);
  border-radius: 8px;
  color: var(--ba-text);
  padding: 6px 10px;
  font-family: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  margin-top: 4px;
}
.profile-button {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  background: var(--ba-accent);
  border: none;
  border-radius: 8px;
  color: white;
  font-weight: 800;
  font-size: 0.78rem;
  cursor: pointer;
  transition: background 0.15s ease;
}
.profile-button:hover { background: var(--ba-accent-strong); }
.profile-button.secondary {
  background: var(--ba-card-bg-soft);
  color: var(--ba-text-muted);
  border: 1px solid var(--ba-divider);
}
.profile-button.secondary:hover { color: var(--ba-accent-strong); }
.profile-error { color: #d04a4a; font-size: 0.72rem; margin-top: 4px; min-height: 0.9rem; }
```

- [ ] **Step 2: Add the panel HTML next to the sensei bar**

After the sensei bar element from Task C1, insert:

```html
<div id="profile-panel" role="dialog" aria-label="Profile">
  <!-- Anonymous view -->
  <div id="profile-anon">
    <div class="settings-title"><span data-i18n="profile.title">Profile</span></div>
    <p style="font-size: 0.78rem; color: var(--ba-text-muted); margin-bottom: 10px;"
       data-i18n="profile.anon_blurb">Sign in to save your progress across devices and appear on the leaderboard.</p>
    <button id="profile-google-btn" class="profile-button" data-i18n="auth.sign_in_google">Sign in with Google</button>
    <div class="profile-error" id="profile-error"></div>
  </div>
  <!-- Linked view -->
  <div id="profile-linked" hidden>
    <div class="settings-title"><span data-i18n="profile.title">Profile</span></div>
    <label style="font-size: 0.74rem; color: var(--ba-text-muted); font-weight: 700;"
           data-i18n="profile.display_name">Display name</label>
    <input id="profile-name-input" class="profile-input" maxlength="24" />
    <div style="height: 8px;"></div>
    <label style="font-size: 0.74rem; color: var(--ba-text-muted); font-weight: 700;"
           data-i18n="profile.country">Country</label>
    <select id="profile-country-select" class="profile-select"></select>
    <button id="profile-save-btn" class="profile-button" data-i18n="profile.save">Save</button>
    <button id="profile-signout-btn" class="profile-button secondary" data-i18n="auth.sign_out">Sign out</button>
    <div class="profile-error" id="profile-error-linked"></div>
  </div>
</div>
```

- [ ] **Step 3: Wire the open/close on sensei bar click**

Insert this in the script section, near the other panel toggles (after the `skinsBtn` click handler):

```js
// --- Profile panel toggle ---
const senseiBar       = document.getElementById('sensei-bar');
const profilePanel    = document.getElementById('profile-panel');
const profileAnonView = document.getElementById('profile-anon');
const profileLinkedView = document.getElementById('profile-linked');

function updateProfileView() {
  const linked = currentUser && !currentUser.isAnonymous;
  profileAnonView.hidden   = linked;
  profileLinkedView.hidden = !linked;
}

senseiBar.addEventListener('click', (e) => {
  e.stopPropagation();
  updateProfileView();
  profilePanel.classList.toggle('open');
});
profilePanel.addEventListener('click', (e) => e.stopPropagation());

// Close on outside click — extend the existing document click handler
document.addEventListener('click', (e) => {
  if (!profilePanel.contains(e.target) && e.target !== senseiBar && !senseiBar.contains(e.target)) {
    profilePanel.classList.remove('open');
  }
});

auth.onAuthStateChanged(() => updateProfileView());
```

- [ ] **Step 4: Verify**

Click the sensei bar — profile panel opens above it. Initially the anon view is shown (since the user is anonymous on first visit) with "Sign in with Google". Click outside the panel — it closes.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add profile panel scaffold (anon + linked views)"
```

---

### Task D2: Sign in with Google + link to anonymous account

**Files:**
- Modify: `index.html` (profile panel JS section)

- [ ] **Step 1: Add the Google linking handler**

Insert right after the `senseiBar` click handler from D1:

```js
// --- Google sign-in / linking -----------------------------------------------
const profileGoogleBtn = document.getElementById('profile-google-btn');
const profileError     = document.getElementById('profile-error');

profileGoogleBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  profileError.textContent = '';
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    if (currentUser && currentUser.isAnonymous) {
      // Upgrade the anonymous account — preserves UID and all stats
      const cred = await currentUser.linkWithPopup(provider);
      await initProfileFromCredential(cred);
    } else {
      // No current user (shouldn't normally happen) — plain sign-in
      const cred = await auth.signInWithPopup(provider);
      await initProfileFromCredential(cred);
    }
    profilePanel.classList.remove('open');
  } catch (err) {
    if (err.code === 'auth/credential-already-in-use') {
      // The Google account is already linked elsewhere. Sign in with it; the
      // anon UID and any stats accrued on this device are lost.
      profileError.textContent = I18N.t('auth.already_linked');
      try {
        const cred = await auth.signInWithCredential(err.credential);
        await initProfileFromCredential(cred);
        profilePanel.classList.remove('open');
      } catch (err2) {
        profileError.textContent = err2.message || 'Sign-in failed.';
      }
    } else if (err.code === 'auth/popup-closed-by-user') {
      // User dismissed the popup — silent
    } else {
      profileError.textContent = err.message || 'Sign-in failed.';
    }
  }
});

async function initProfileFromCredential(cred) {
  const u = auth.currentUser;
  if (!u) return;
  const existing = await db.ref('users/' + u.uid + '/profile').once('value');
  if (existing.exists()) return;  // Already linked from a previous session — don't overwrite name/country edits
  const ts = firebase.database.ServerValue.TIMESTAMP;
  const profile = {
    displayName: (u.displayName || 'Sensei').slice(0, 24),
    photoURL:    (u.photoURL || '').slice(0, 500),
    country:     visitorCountry || 'XX',
    provider:    'google',
    linkedAt:    ts,
  };
  await db.ref('users/' + u.uid + '/profile').set(profile);
  // Immediate leaderboard mirror so any clicks accrued while anonymous show up
  // on the board right away. Subsequent updates flow through the stats listener
  // (Task E1) — this is just for the moment-of-link case.
  const clicks = (userStats && userStats.totalClicks) || 0;
  await db.ref('leaderboard/topClicks/' + u.uid).set({
    name:        profile.displayName,
    country:     profile.country,
    photoURL:    profile.photoURL,
    totalClicks: clicks,
    level:       levelOf(clicks),
  }).catch(() => {});
}
```

- [ ] **Step 2: Add the relevant English i18n keys**

In the English block of `I18N`:
```js
'auth.sign_in_google':'Sign in with Google',
'auth.sign_out':'Sign out',
'auth.already_linked':'This Google account is already linked to another player. Signing you in to that one instead.',
'profile.title':'Profile',
'profile.anon_blurb':'Sign in to save your progress across devices and appear on the leaderboard.',
'profile.display_name':'Display name',
'profile.country':'Country',
'profile.save':'Save',
```

- [ ] **Step 3: Verify**

Click the sensei bar → "Sign in with Google" → complete the Google OAuth popup. The view flips to the "linked" form. Inspect:
```js
currentUser.isAnonymous         // false
currentUser.displayName         // your Google profile name
const snap = await firebase.database().ref('users/' + currentUser.uid + '/profile').once('value');
snap.val()
// { displayName, photoURL, country, provider: 'google', linkedAt }
```

The sensei bar avatar swaps to your Google profile photo on the next render (give it ~500ms for the listener to fire).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add Google sign-in via linkWithPopup; preserves anon UID"
```

---

### Task D3: Display name + country editor

**Files:**
- Modify: `index.html` (profile panel JS section)

- [ ] **Step 1: Populate the country dropdown**

Insert right after the profile-google handler in D2:

```js
// --- Profile editor (linked) ------------------------------------------------
const profileNameInput  = document.getElementById('profile-name-input');
const profileCountrySel = document.getElementById('profile-country-select');
const profileSaveBtn    = document.getElementById('profile-save-btn');
const profileSignoutBtn = document.getElementById('profile-signout-btn');
const profileErrLinked  = document.getElementById('profile-error-linked');

// All ISO 3166-1 alpha-2 country codes. Names are English-only for v1 —
// translating ~250 country names is out of scope; the flag emoji is universal.
const COUNTRY_CODES = ['AF','AL','DZ','AS','AD','AO','AI','AQ','AG','AR','AM','AW','AU','AT','AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BM','BT','BO','BA','BW','BR','IO','BN','BG','BF','BI','CV','KH','CM','CA','KY','CF','TD','CL','CN','CO','KM','CG','CD','CK','CR','CI','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','ET','FK','FO','FJ','FI','FR','GF','PF','GA','GM','GE','DE','GH','GI','GR','GL','GD','GP','GU','GT','GG','GN','GW','GY','HT','HN','HK','HU','IS','IN','ID','IR','IQ','IE','IM','IL','IT','JM','JP','JE','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MO','MG','MW','MY','MV','ML','MT','MH','MQ','MR','MU','YT','MX','FM','MD','MC','MN','ME','MS','MA','MZ','MM','NA','NR','NP','NL','NC','NZ','NI','NE','NG','NU','NF','MK','MP','NO','OM','PK','PW','PS','PA','PG','PY','PE','PH','PN','PL','PT','PR','QA','RE','RO','RU','RW','BL','SH','KN','LC','MF','PM','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SX','SK','SI','SB','SO','ZA','SS','ES','LK','SD','SR','SZ','SE','CH','SY','TW','TJ','TZ','TH','TL','TG','TK','TO','TT','TN','TR','TM','TC','TV','UG','UA','AE','GB','US','UY','UZ','VU','VE','VN','VG','VI','YE','ZM','ZW'];

(function populateCountries() {
  const opts = COUNTRY_CODES.map(code => {
    const flag = code.replace(/./g, c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65));
    return `<option value="${code}">${flag} ${code}</option>`;
  });
  profileCountrySel.innerHTML = opts.join('');
})();

// Pre-fill inputs from current profile data on panel open
function syncProfileInputs() {
  if (!userProfile) return;
  profileNameInput.value = userProfile.displayName || '';
  profileCountrySel.value = userProfile.country || (visitorCountry || 'US');
}
senseiBar.addEventListener('click', syncProfileInputs);
```

- [ ] **Step 2: Add the save handler**

Right after the populate block:

```js
profileSaveBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  profileErrLinked.textContent = '';
  const name = profileNameInput.value.trim();
  const country = profileCountrySel.value;
  if (name.length < 1 || name.length > 24) {
    profileErrLinked.textContent = I18N.t('profile.name_length_error');
    return;
  }
  const uid = currentUser.uid;
  try {
    await db.ref('users/' + uid + '/profile').update({ displayName: name, country });
    // Mirror to the leaderboard projection if a row already exists there
    const lbRef = db.ref('leaderboard/topClicks/' + uid);
    const exists = (await lbRef.once('value')).exists();
    if (exists) await lbRef.update({ name, country });
    profilePanel.classList.remove('open');
  } catch (err) {
    profileErrLinked.textContent = err.message || 'Save failed.';
  }
});
```

- [ ] **Step 3: Add the sign-out handler**

```js
profileSignoutBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  await auth.signOut();
  // signInAnonymously() fires automatically via the onAuthStateChanged loop
  profilePanel.classList.remove('open');
});
```

- [ ] **Step 4: Add the related i18n keys**

In the English block of `I18N`:
```js
'profile.name_length_error':'Display name must be 1–24 characters.',
```

- [ ] **Step 5: Verify**

Open the profile panel (signed in). Change the display name to "Mari-fan" and country to JP. Click Save. The sensei bar updates to show the new name and 🇯🇵 flag within ~500ms. Reload the page — values persist. Click "Sign out" — the bar reverts to anonymous "Trainer" with a fresh UID.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Profile editor: display name, country picker, sign out"
```

---

## Phase E — Leaderboard

### Task E1: Mirror writes to `leaderboard/topClicks` on each mouse click

**Files:**
- Modify: `index.html` (the `writeUserClick` helper from Task A4)

- [ ] **Step 1: Extend `writeUserClick` to update the leaderboard projection**

Replace the entire `writeUserClick` body with:

```js
function writeUserClick() {
  if (!currentUser || currentUser.isAnonymous) {
    // Anonymous users: write their own user-keyed stats, but skip leaderboard.
    // The leaderboard rule requires users/{uid}/profile to exist.
    if (!currentUser) return;
    const uid = currentUser.uid;
    const inc = firebase.database.ServerValue.increment(1);
    const ts  = firebase.database.ServerValue.TIMESTAMP;
    db.ref().update({
      [`users/${uid}/stats/totalClicks`]: inc,
      [`users/${uid}/stats/coinBalance`]: inc,
      [`users/${uid}/stats/lastClickAt`]: ts,
    }).catch(() => {});
    return;
  }
  const uid = currentUser.uid;
  const inc = firebase.database.ServerValue.increment(1);
  const ts  = firebase.database.ServerValue.TIMESTAMP;
  // Linked user: mirror to leaderboard projection in the same atomic update.
  // We need the *new* totalClicks for the leaderboard row, but increment is
  // computed server-side; so we update the user node first and rely on a
  // separate small write triggered by the stats listener (see below).
  db.ref().update({
    [`users/${uid}/stats/totalClicks`]: inc,
    [`users/${uid}/stats/coinBalance`]: inc,
    [`users/${uid}/stats/lastClickAt`]: ts,
  }).catch(() => {});
}
```

- [ ] **Step 2: Mirror totalClicks to the leaderboard via the existing stats listener**

Find the existing `subscribeUserData` function from Task C2. Inside the `statsCb` (which fires whenever the user's stats change), add a leaderboard mirror. Replace the existing `statsCb` definition with:

```js
const statsCb  = (snap) => {
  userStats = snap.val() || { totalClicks: 0, coinBalance: 0 };
  renderSenseiBar();
  // Mirror to leaderboard if user is linked. Cheap — only writes when the
  // value actually changes (the .on('value') listener already debounces by RTDB).
  if (currentUser && !currentUser.isAnonymous && userProfile) {
    const lv = levelOf(userStats.totalClicks || 0);
    db.ref('leaderboard/topClicks/' + uid).set({
      name:        userProfile.displayName || I18N.t('sensei.trainer'),
      country:     userProfile.country || 'XX',
      photoURL:    userProfile.photoURL || '',
      totalClicks: userStats.totalClicks || 0,
      level:       lv,
    }).catch(() => {});
  }
};
```

- [ ] **Step 3: Verify**

Signed in as a linked user, click the character ~20 times. Then in console:
```js
const snap = await firebase.database().ref('leaderboard/topClicks/' + currentUser.uid).once('value');
console.log(snap.val());
// Expected: { name, country, photoURL, totalClicks: 20, level: 1 }
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Mirror user stats to leaderboard/topClicks for linked users"
```

---

### Task E2: Leaderboard button + modal scaffold

**Files:**
- Modify: `index.html` (CSS, panel-btn area, and stats-modal-adjacent HTML)

- [ ] **Step 1: Add the leaderboard 🏆 button**

In the panel-buttons CSS area, after the `#stats-btn`:

```css
#leaderboard-btn { top: 16px; right: 70px; }
@media (max-width: 480px) {
  #leaderboard-btn { top: 12px; right: 56px; }
}
@media (max-height: 500px) and (orientation: landscape) {
  #leaderboard-btn { top: 8px; }
}
```

In the HTML, right before the stats button (so the new 🏆 sits to the left of 📊):

```html
<!-- Leaderboard -->
<button id="leaderboard-btn" class="panel-btn" aria-label="Leaderboard">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/>
    <path d="M17 4h3v3a3 3 0 0 1-3 3M7 4H4v3a3 3 0 0 0 3 3"/>
  </svg>
</button>
```

- [ ] **Step 2: Add the leaderboard modal CSS (reuse stats-modal patterns)**

After the `#stats-modal` block:

```css
#leaderboard-modal {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex; align-items: center; justify-content: center;
  background: rgba(20,40,70,0.45);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  opacity: 0; pointer-events: none;
  transition: opacity 0.25s ease;
}
#leaderboard-modal.open { opacity: 1; pointer-events: auto; }

.leaderboard-dialog {
  position: relative;
  width: min(640px, 92vw);
  max-height: 88vh;
  background: var(--ba-card-bg);
  border: var(--ba-card-border);
  border-radius: 18px;
  padding: 22px 24px;
  color: var(--ba-text);
  overflow-y: auto;
  transform: translateY(12px) scale(0.98);
  transition: transform 0.25s ease;
  box-shadow: 0 24px 80px rgba(0,30,60,0.35);
}
#leaderboard-modal.open .leaderboard-dialog { transform: translateY(0) scale(1); }

.lb-info-banner {
  background: var(--ba-accent-soft);
  border: 1px solid rgba(77,171,247,0.35);
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 0.78rem;
  color: var(--ba-accent-strong);
  margin-bottom: 14px;
  font-weight: 600;
}

.lb-row {
  display: grid;
  grid-template-columns: 32px 28px 1.5rem 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 10px;
  font-size: 0.85rem;
  transition: background 0.12s ease;
}
.lb-row:nth-child(even) { background: rgba(244,249,255,0.4); }
.lb-row.me { background: var(--ba-accent-soft); border: 1px solid rgba(77,171,247,0.5); }
.lb-rank   { font-weight: 800; color: var(--ba-accent-strong); font-variant-numeric: tabular-nums; text-align: right; }
.lb-flag   { font-size: 1.05rem; }
.lb-avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; background: var(--ba-accent-soft); }
.lb-name   { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-level  { font-size: 0.74rem; color: var(--ba-text-muted); font-weight: 700; }
.lb-clicks { font-weight: 800; color: var(--ba-accent-strong); font-variant-numeric: tabular-nums; }

.lb-yourrank {
  margin-top: 14px;
  padding: 10px;
  text-align: center;
  font-size: 0.85rem;
  color: var(--ba-text-muted);
  font-weight: 700;
}
.lb-signin-cta {
  margin-top: 14px;
  padding: 10px;
  text-align: center;
  background: var(--ba-accent-soft);
  border: 1px dashed rgba(77,171,247,0.45);
  border-radius: 10px;
  font-size: 0.85rem;
  color: var(--ba-accent-strong);
  font-weight: 700;
  cursor: pointer;
}
```

- [ ] **Step 3: Add the modal HTML alongside the stats modal**

After the `#stats-modal` element:

```html
<!-- Leaderboard -->
<div id="leaderboard-modal" aria-hidden="true">
  <div class="leaderboard-dialog" role="dialog" aria-label="Leaderboard" data-i18n-attr="aria-label:leaderboard.title">
    <div class="stats-header">
      <div class="stats-title"><span data-i18n="leaderboard.title">Leaderboard</span></div>
      <button class="stats-close" id="leaderboard-close" aria-label="Close" data-i18n-attr="aria-label:aria.close">&times;</button>
    </div>
    <div class="lb-info-banner" data-i18n="leaderboard.info_banner">Only mouse and tap clicks count toward your rank. Keyboard mashing is fun, but it's not on the board.</div>
    <div id="leaderboard-list"></div>
    <div id="leaderboard-yourrank" class="lb-yourrank"></div>
    <div id="leaderboard-signin" class="lb-signin-cta" data-i18n="leaderboard.sign_in_cta" hidden>Sign in to join the leaderboard →</div>
  </div>
</div>
```

- [ ] **Step 4: Add open/close handlers**

After the existing stats modal handlers:

```js
// --- Leaderboard modal ---
const leaderboardBtn   = document.getElementById('leaderboard-btn');
const leaderboardModal = document.getElementById('leaderboard-modal');
const leaderboardClose = document.getElementById('leaderboard-close');
const leaderboardList  = document.getElementById('leaderboard-list');
const leaderboardYourRank = document.getElementById('leaderboard-yourrank');
const leaderboardSignin = document.getElementById('leaderboard-signin');
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
leaderboardClose.addEventListener('click', closeLeaderboard);
leaderboardModal.addEventListener('click', (e) => { if (e.target === leaderboardModal) closeLeaderboard(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && leaderboardModal.classList.contains('open')) closeLeaderboard();
});
leaderboardSignin.addEventListener('click', () => {
  closeLeaderboard();
  senseiBar.click();   // opens profile panel which has the sign-in button
});

function loadLeaderboard() { /* implemented in Task E3 */ }
```

- [ ] **Step 5: Verify**

Click the 🏆 button — the modal opens. Click outside or press Esc — it closes. The body is empty for now (E3 adds the rows).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Add leaderboard button + modal scaffold"
```

---

### Task E3: Render leaderboard rows + own rank

**Files:**
- Modify: `index.html` (implement `loadLeaderboard`)

- [ ] **Step 1: Replace the stubbed `loadLeaderboard`**

Replace `function loadLeaderboard() { /* implemented in Task E3 */ }` with:

```js
function loadLeaderboard() {
  leaderboardList.innerHTML = '';
  leaderboardYourRank.textContent = '';
  leaderboardSignin.hidden = !!currentUser && !currentUser.isAnonymous;

  // Live top-100 query. .on('value') fires once on initial fetch and again
  // on every change while the modal is open. Detached on close.
  const q = db.ref('leaderboard/topClicks').orderByChild('totalClicks').limitToLast(100);
  const cb = (snap) => {
    const rows = [];
    snap.forEach(child => { rows.push({ uid: child.key, ...child.val() }); });
    rows.sort((a, b) => (b.totalClicks || 0) - (a.totalClicks || 0));

    leaderboardList.innerHTML = rows.map((r, i) => {
      const isMe = currentUser && r.uid === currentUser.uid;
      const flag = flagFromCountry(r.country);
      const avatar = r.photoURL
        ? `<img class="lb-avatar" src="${r.photoURL}" alt="">`
        : `<div class="lb-avatar" style="display:flex;align-items:center;justify-content:center;color:var(--ba-accent-strong);font-weight:800;">${(r.name || '?').slice(0,1)}</div>`;
      return `<div class="lb-row${isMe ? ' me' : ''}">
        <span class="lb-rank">#${i + 1}</span>
        ${avatar}
        <span class="lb-flag">${flag}</span>
        <span class="lb-name">${escapeHtml(r.name || I18N.t('sensei.trainer'))}</span>
        <span class="lb-level">Lv.${r.level || 0}</span>
        <span class="lb-clicks">${(r.totalClicks || 0).toLocaleString()}</span>
      </div>`;
    }).join('');

    // Your rank text — only if linked
    if (currentUser && !currentUser.isAnonymous) {
      const myRow = rows.findIndex(r => r.uid === currentUser.uid);
      if (myRow >= 0) {
        leaderboardYourRank.textContent = I18N.t('leaderboard.your_rank', { rank: myRow + 1, total: rows.length });
      } else if (userStats.totalClicks > 0) {
        // Outside top 100 — show count from a separate query
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
  // RTDB doesn't have native count. Approximate: query everyone with more
  // clicks than us. For boards under ~10k players this is acceptable.
  const myClicks = userStats.totalClicks || 0;
  const snap = await db.ref('leaderboard/topClicks').orderByChild('totalClicks').startAfter(myClicks).once('value');
  return snap.numChildren() + 1;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
```

- [ ] **Step 2: Add the related i18n keys**

In the English block:
```js
'leaderboard.title':'Leaderboard',
'leaderboard.info_banner':"Only mouse and tap clicks count toward your rank. Keyboard mashing is fun, but it's not on the board.",
'leaderboard.sign_in_cta':'Sign in to join the leaderboard →',
'leaderboard.your_rank':'Your rank: #{rank} of {total} players',
'leaderboard.your_rank_outside':'Your rank: #{rank} (not in top 100)',
'leaderboard.no_rank_yet':'Click to start climbing the board!',
```

- [ ] **Step 3: Verify**

With a linked account, click ~30 times. Open the leaderboard — your row appears (highlighted cyan). Your rank text shows below. Sign out — your row remains on the board (it's bound to the linked UID), but you no longer see the "me" highlight; the sign-in CTA appears at the bottom of the modal.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Render leaderboard rows with rank, level, and own-rank line"
```

---

## Phase F — i18n + final polish

### Task F1: Translate all new keys to JA / KO / zh-Hans / zh-Hant / TH / AR

**Files:**
- Modify: `index.html` (the I18N module's per-language blocks)

- [ ] **Step 1: Add the full key set to each non-English locale**

Below are the translations for all new keys introduced in this plan. Add each block under the matching locale within the `I18N.T` map. Keep the same key order as English for diffability.

**Japanese (ja):**
```js
'settings.keyboard_clicks':'キーボードクリック',
'sensei.trainer':'先生',
'auth.sign_in_google':'Googleでログイン',
'auth.sign_out':'ログアウト',
'auth.already_linked':'このGoogleアカウントは別のプレイヤーにすでに連携されています。そちらでログインします。',
'profile.title':'プロフィール',
'profile.anon_blurb':'ログインすると進行状況がデバイス間で保存され、リーダーボードに表示されます。',
'profile.display_name':'表示名',
'profile.country':'国',
'profile.save':'保存',
'profile.name_length_error':'表示名は1〜24文字で入力してください。',
'leaderboard.title':'リーダーボード',
'leaderboard.info_banner':'マウス/タップのクリックだけがランクに反映されます。キーボード連打は楽しいですが、ランキング対象外です。',
'leaderboard.sign_in_cta':'ログインしてリーダーボードに参加 →',
'leaderboard.your_rank':'あなたの順位: #{rank} / {total} 人',
'leaderboard.your_rank_outside':'あなたの順位: #{rank} (トップ100圏外)',
'leaderboard.no_rank_yet':'クリックしてランキングを駆け上がろう!',
```

**Korean (ko):**
```js
'settings.keyboard_clicks':'키보드 클릭',
'sensei.trainer':'선생',
'auth.sign_in_google':'Google로 로그인',
'auth.sign_out':'로그아웃',
'auth.already_linked':'이 Google 계정은 다른 플레이어에 이미 연결되어 있습니다. 해당 계정으로 로그인합니다.',
'profile.title':'프로필',
'profile.anon_blurb':'로그인하면 진행 상황이 기기 간 저장되고 리더보드에 표시됩니다.',
'profile.display_name':'표시 이름',
'profile.country':'국가',
'profile.save':'저장',
'profile.name_length_error':'표시 이름은 1~24자여야 합니다.',
'leaderboard.title':'리더보드',
'leaderboard.info_banner':'마우스/탭 클릭만 순위에 반영됩니다. 키보드 연타는 재미있지만 순위에는 들어가지 않습니다.',
'leaderboard.sign_in_cta':'로그인해서 리더보드에 참여하기 →',
'leaderboard.your_rank':'내 순위: #{rank} / 총 {total}명',
'leaderboard.your_rank_outside':'내 순위: #{rank} (TOP 100 밖)',
'leaderboard.no_rank_yet':'클릭해서 순위를 올려보세요!',
```

**Simplified Chinese (zh-Hans):**
```js
'settings.keyboard_clicks':'键盘点击',
'sensei.trainer':'老师',
'auth.sign_in_google':'使用 Google 登录',
'auth.sign_out':'退出登录',
'auth.already_linked':'此 Google 账号已与其他玩家关联。将使用该账号登录。',
'profile.title':'个人资料',
'profile.anon_blurb':'登录后可跨设备保存进度并出现在排行榜上。',
'profile.display_name':'显示名称',
'profile.country':'国家',
'profile.save':'保存',
'profile.name_length_error':'显示名称需为 1–24 个字符。',
'leaderboard.title':'排行榜',
'leaderboard.info_banner':'只有鼠标/点击计入排名。键盘连按很有趣,但不计入榜单。',
'leaderboard.sign_in_cta':'登录加入排行榜 →',
'leaderboard.your_rank':'你的排名: 第 {rank} / 共 {total} 位玩家',
'leaderboard.your_rank_outside':'你的排名: 第 {rank} (前 100 名外)',
'leaderboard.no_rank_yet':'点击开始攀登排行榜!',
```

**Traditional Chinese (zh-Hant):**
```js
'settings.keyboard_clicks':'鍵盤點擊',
'sensei.trainer':'老師',
'auth.sign_in_google':'使用 Google 登入',
'auth.sign_out':'登出',
'auth.already_linked':'此 Google 帳戶已與其他玩家連結。將使用該帳戶登入。',
'profile.title':'個人資料',
'profile.anon_blurb':'登入後可跨裝置保存進度並顯示在排行榜上。',
'profile.display_name':'顯示名稱',
'profile.country':'國家',
'profile.save':'儲存',
'profile.name_length_error':'顯示名稱需為 1–24 個字元。',
'leaderboard.title':'排行榜',
'leaderboard.info_banner':'只有滑鼠/點擊計入排名。鍵盤連按很有趣,但不計入榜單。',
'leaderboard.sign_in_cta':'登入加入排行榜 →',
'leaderboard.your_rank':'你的排名: 第 {rank} / 共 {total} 位玩家',
'leaderboard.your_rank_outside':'你的排名: 第 {rank} (前 100 名外)',
'leaderboard.no_rank_yet':'點擊開始攀登排行榜!',
```

**Thai (th):**
```js
'settings.keyboard_clicks':'การกดคีย์บอร์ด',
'sensei.trainer':'เซนเซย์',
'auth.sign_in_google':'เข้าสู่ระบบด้วย Google',
'auth.sign_out':'ออกจากระบบ',
'auth.already_linked':'บัญชี Google นี้เชื่อมโยงกับผู้เล่นคนอื่นแล้ว ระบบจะเข้าสู่ระบบด้วยบัญชีนั้น',
'profile.title':'โปรไฟล์',
'profile.anon_blurb':'เข้าสู่ระบบเพื่อบันทึกความคืบหน้าข้ามอุปกรณ์และปรากฏบนกระดานผู้นำ',
'profile.display_name':'ชื่อที่แสดง',
'profile.country':'ประเทศ',
'profile.save':'บันทึก',
'profile.name_length_error':'ชื่อที่แสดงต้องมี 1–24 ตัวอักษร',
'leaderboard.title':'กระดานผู้นำ',
'leaderboard.info_banner':'เฉพาะคลิกเมาส์/แตะเท่านั้นที่นับเข้าอันดับ การกดคีย์บอร์ดสนุกแต่ไม่อยู่บนกระดาน',
'leaderboard.sign_in_cta':'เข้าสู่ระบบเพื่อร่วมกระดานผู้นำ →',
'leaderboard.your_rank':'อันดับของคุณ: #{rank} จาก {total} คน',
'leaderboard.your_rank_outside':'อันดับของคุณ: #{rank} (นอก 100 อันดับแรก)',
'leaderboard.no_rank_yet':'คลิกเพื่อเริ่มไต่อันดับ!',
```

**Arabic (ar):**
```js
'settings.keyboard_clicks':'نقرات لوحة المفاتيح',
'sensei.trainer':'المعلم',
'auth.sign_in_google':'تسجيل الدخول بحساب Google',
'auth.sign_out':'تسجيل الخروج',
'auth.already_linked':'حساب Google هذا مرتبط بالفعل بلاعب آخر. سيتم تسجيل الدخول إلى ذلك الحساب.',
'profile.title':'الملف الشخصي',
'profile.anon_blurb':'سجّل الدخول لحفظ تقدمك عبر الأجهزة والظهور في لوحة المتصدرين.',
'profile.display_name':'اسم العرض',
'profile.country':'الدولة',
'profile.save':'حفظ',
'profile.name_length_error':'يجب أن يتكون اسم العرض من 1 إلى 24 حرفًا.',
'leaderboard.title':'لوحة المتصدرين',
'leaderboard.info_banner':'فقط نقرات الفأرة/اللمس تُحتسب في تصنيفك. لعب لوحة المفاتيح ممتع لكنه لا يدخل اللوحة.',
'leaderboard.sign_in_cta':'سجّل الدخول للانضمام إلى لوحة المتصدرين →',
'leaderboard.your_rank':'ترتيبك: #{rank} من {total} لاعبًا',
'leaderboard.your_rank_outside':'ترتيبك: #{rank} (خارج أفضل 100)',
'leaderboard.no_rank_yet':'انقر لتبدأ تسلق اللوحة!',
```

- [ ] **Step 2: Verify**

Cycle through every locale via the language dropdown. Open the settings panel (Keyboard clicks label translates), the profile panel (all labels translate), and the leaderboard (info banner, your-rank line translate).

```js
// Programmatic spot-check
for (const lang of I18N.SUPPORTED) {
  I18N.set(lang);
  console.log(lang, I18N.t('leaderboard.title'), I18N.t('profile.display_name'));
}
I18N.set('en');
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Translate auth/profile/leaderboard strings into all 6 non-English locales"
```

---

### Task F2: End-to-end verification + final push

**Files:** None (verification only)

- [ ] **Step 1: Cold-start as a new anonymous user**

Open an incognito browser window to the dev server. Confirm:
- The sensei bar shows "Trainer Lv.0" with no flag, no avatar, "0 / 20" XP, "💰 0".
- The leaderboard modal opens, shows existing linked players, sign-in CTA visible at the bottom.
- Click the character 25 times: sensei bar advances to Lv.1 (since `floor(sqrt(25/20)) = 1`), `+1` floaters appear on each click, XP fill pulses, coins tick up.
- Press keys: combo bar bumps, particles spawn, sensei bar does NOT advance.

- [ ] **Step 2: Link to Google**

Click the sensei bar → "Sign in with Google" → complete OAuth.
- The view flips to the linked profile editor.
- The sensei bar avatar swaps to your Google photo, name to your Google name, flag to your detected country.
- Your row appears on the leaderboard (highlighted in cyan), starting at the 25 clicks you accrued anonymously.

- [ ] **Step 3: Edit profile**

Change name to "Test-fan", country to JP. Save. Sensei bar updates within ~500ms. Reload the page — values persist.

- [ ] **Step 4: Sign out and re-sign-in**

Click sign out. Sensei bar reverts to anonymous "Trainer Lv.0" (fresh UID). Click again — your linked "Test-fan" row is still on the leaderboard but is no longer highlighted as "me". Click "Sign in" → reverts to the linked account with all stats intact.

- [ ] **Step 5: Verify anti-cheat from the console**

```js
// +1-only validation
const uid = currentUser.uid;
firebase.database().ref('users/' + uid + '/stats/totalClicks').set(99999)
  .catch(e => console.log('Expected:', e.code));
// → "Expected: PERMISSION_DENIED"

// Cross-UID write blocked
firebase.database().ref('users/other-uid/stats/totalClicks').set(1)
  .catch(e => console.log('Expected:', e.code));
// → "Expected: PERMISSION_DENIED"

// Throttle: rapid back-to-back attempts
for (let i = 0; i < 200; i++) document.getElementById('character').click();
await new Promise(r => setTimeout(r, 2000));
// totalClicks should grow by roughly (window_ms / 15ms) — not 200 — confirming throttle
console.log((await firebase.database().ref('users/' + uid + '/stats/totalClicks').once('value')).val());
```

- [ ] **Step 6: Push**

```bash
git push origin master
```

- [ ] **Step 7: Post-deploy smoke**

After GitHub Pages picks up the push (1-2 min), open `https://aobing.it` in a fresh browser. Repeat steps 1-2 against production to confirm Firebase Auth domain is whitelisted and the Google popup completes against the real domain. If "auth/unauthorized-domain" appears, return to Firebase Console → Authentication → Settings → Authorized domains and add `aobing.it`.

---

## Out of scope reminder

These were spec'd as Phase 2 and are intentionally not in this plan:

- Discord / X / GitHub sign-in
- Email link / password sign-in
- Cosmetics shop, coin spending UI
- Daily / weekly / per-character leaderboards
- Friend lists, profile pages
- Achievements / badges
- Server-side anti-cheat via Cloud Functions
- Animated XP-up effects beyond the brief glow pulse
