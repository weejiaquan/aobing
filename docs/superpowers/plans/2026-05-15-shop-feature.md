# Shop Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cookie-Clicker-style coin shop with permanent coin/click multipliers, a leveled auto-clicker with side cursor animation, a one-shot leaderboard-auto unlock, and three 60s buffs that extend on same-type re-buy and stack across types.

**Architecture:** All UI/state code lives in `index.html` (single-file project — no module system). New script block sits alongside the existing skin/leaderboard/sensei code. Shop state stored at `users/{uid}/shop/*` in Firebase RTDB, with rules added in `database.rules.json`. Multipliers are computed each click and each auto-tick from a single `shopMul()` helper, so adding new upgrade types later only requires extending one function.

**Tech Stack:** Vanilla JS, Firebase Auth + RTDB, anime.js (already in use for click animations). No build step. Browser is the test harness — no automated tests exist for this project.

**Spec:** `docs/superpowers/specs/2026-05-15-shop-feature-design.md`

---

## File Map

| File | Purpose | Sections touched |
|---|---|---|
| `database.rules.json` | Raise per-write caps; add `users/{uid}/shop/*` subtree rules | `stats.totalClicks`, `stats.coinBalance`, `stats.bySource`, new `shop` block |
| `index.html` | Single-file app — all UI, CSS, JS, i18n strings | New HTML markup for shop button + panel + auto-cursor; CSS for `.shop-section`/`.shop-item`/`#auto-cursor`; new JS for `userShop` state, `shopMul`, render, buy handlers, auto-clicker loop; refactor of `pending` batcher; i18n strings in all 7 locales |

The project is a single-page static site (no build, no test runner). Each task ends with a manual browser smoke check.

---

## Conventions Used in This Plan

- **Search-string anchors.** Because `index.html` is 4400+ lines and edits aren't applied to a fresh file, each modification cites an exact existing line/string to find before editing.
- **No automated tests.** Each task has a "Verify" step describing the manual browser check.
- **Commit at the end of each task** — the project favors small focused commits per the existing log.
- **Manual rule deploy.** After modifying `database.rules.json`, run `firebase deploy --only database` once at the end (Task 13). Local edits don't take effect on the live RTDB until deployed.

---

## Task 1: Update Firebase rules — raise increment caps and add `shop` subtree

**Files:**
- Modify: `database.rules.json`

- [ ] **Step 1: Raise the `totalClicks` cap from 150 to 10000**

Find the line containing `"totalClicks": {` in `database.rules.json`. Replace its `.validate` value:

```json
"totalClicks": {
  ".validate": "newData.isNumber() && newData.val() >= (data.exists() ? data.val() : 0) + 1 && newData.val() <= (data.exists() ? data.val() : 0) + 10000 && now - (data.parent().child('lastClickAt').exists() ? data.parent().child('lastClickAt').val() : 0) >= 1000 && newData.parent().child('lastClickAt').val() === now"
},
```

(Only the `+ 150` → `+ 10000` change. Everything else is identical to the current rule.)

- [ ] **Step 2: Raise the `coinBalance` cap from 150 to 10000**

Find `"coinBalance": {` and replace:

```json
"coinBalance": {
  ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= (data.exists() ? data.val() : 0) + 10000"
},
```

- [ ] **Step 3: Raise the `bySource` cap from 150 to 10000**

Find `"bySource": {` inside `users/$uid/stats/`. Replace the inner `$source` `.validate`:

```json
"bySource": {
  "$source": {
    ".validate": "newData.isNumber() && ($source === 'mouse' || $source === 'keyboard' || $source === 'auto') && newData.val() >= (data.exists() ? data.val() : 0) + 1 && newData.val() <= (data.exists() ? data.val() : 0) + 10000 && now - (data.parent().parent().child('lastClickAt').exists() ? data.parent().parent().child('lastClickAt').val() : 0) >= 1000 && newData.parent().parent().child('lastClickAt').val() === now"
  }
},
```

- [ ] **Step 4: Add the `shop` subtree under `users/$uid/`**

Inside `"$uid": { ... }` (which already contains `"profile"`, `"stats"`), add a sibling block:

```json
"shop": {
  "coinMulLevel":            { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 20" },
  "clickMulLevel":           { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 20" },
  "autoLevel":               { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 20" },
  "leaderboardAutoUnlocked": { ".validate": "newData.isBoolean()" },
  "buffs": {
    "$kind": {
      ".validate": "$kind === 'coins' || $kind === 'clicks' || $kind === 'autoRate'",
      "expiresAt": { ".validate": "newData.isNumber() && newData.val() <= now + 3600000" }
    }
  }
},
```

Place it after the `"stats"` block, before the closing `}` of `"$uid"`. Make sure the preceding `"stats"` block ends with a trailing comma.

- [ ] **Step 5: Verify the file parses as JSON**

Run:

```powershell
Get-Content database.rules.json -Raw | ConvertFrom-Json | Out-Null; if ($?) { Write-Output "OK" }
```

Expected output: `OK`. If you see a parse error, fix the trailing comma or brace issue and re-run.

- [ ] **Step 6: Commit**

```bash
git add database.rules.json
git commit -m "$(cat <<'EOF'
Shop: raise per-write caps to 10k and add users/{uid}/shop rules

Permanent multipliers make 5s flush batches grow well past the previous
+150 cap. Raise totalClicks/coinBalance/bySource caps to +10000 each;
the 1s throttle still bounds sustained leaderboard inflation.

Add shop subtree validation: levels capped at 20, buff expiresAt capped
at now + 1h (60s extensions + clock-skew slack).
EOF
)"
```

Deploy comes later in Task 13 (after all code changes are ready).

---

## Task 2: Refactor click batcher — split `pending.user` into `pending.userCoins` + `pending.userClicks`

This is a pure rename + duplication that keeps behavior 1:1. Shop multipliers come in Task 7.

**Files:**
- Modify: `index.html` (batcher block around lines 3688–3905, sensei bar around 3257–3300)

- [ ] **Step 1: Update the `pending` shape**

Find this block (around line 3705):

```js
var pending = {
  user: 0,           // mouse-only: users/{uid}/stats/{totalClicks,coinBalance}
  global: 0,         // any source: clicks
```

Replace the `user:` line with two fields and update the comment:

```js
var pending = {
  userCoins: 0,      // mouse-only coin gain (can be negative — shop debits)
  userClicks: 0,     // mouse-only click gain (always >= 0, goes to totalClicks)
  global: 0,         // any source: clicks
```

- [ ] **Step 2: Update `savePending` (no code change needed — `JSON.stringify(pending)` already covers new fields)**

Confirm `savePending` looks like this and leave it alone (around line 3720):

```js
function savePending() {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch {}
}
```

- [ ] **Step 3: Update `loadPending` to migrate old key + handle new fields**

Find `loadPending` (around line 3723). Replace its body with:

```js
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
    if (typeof saved.daily === 'number')  pending.daily  += saved.daily;
    for (const k in saved.byCountry || {})    pending.byCountry[k]    = (pending.byCountry[k]    || 0) + saved.byCountry[k];
    for (const k in saved.bySkin || {})       pending.bySkin[k]       = (pending.bySkin[k]       || 0) + saved.bySkin[k];
    for (const k in saved.byCharacter || {})  pending.byCharacter[k]  = (pending.byCharacter[k]  || 0) + saved.byCharacter[k];
    for (const k in saved.allTimeSkin || {})  pending.allTimeSkin[k]  = (pending.allTimeSkin[k]  || 0) + saved.allTimeSkin[k];
    for (const k in saved.bySource || {})     pending.bySource[k]     = (pending.bySource[k]     || 0) + saved.bySource[k];
    for (const k in saved.userBySource || {}) pending.userBySource[k] = (pending.userBySource[k] || 0) + saved.userBySource[k];
  } catch {}
}
```

- [ ] **Step 4: Update `recordClick` to write the two new fields**

Find `recordClick` (around line 3755). Replace this line:

```js
if (source === 'mouse') pending.user += 1;
```

with:

```js
// Pre-shop: still 1:1. Shop multipliers wire in via Task 7.
if (source === 'mouse') {
  pending.userCoins  += 1;
  pending.userClicks += 1;
}
```

- [ ] **Step 5: Update `flushPending`'s snapshot/zero block**

Find the snapshot block in `flushPending` (around line 3785). Replace these lines:

```js
const batch = {
  user: pending.user, global: pending.global, daily: pending.daily,
  byCountry:    { ...pending.byCountry },
```

with:

```js
const batch = {
  userCoins:  pending.userCoins,
  userClicks: pending.userClicks,
  global: pending.global, daily: pending.daily,
  byCountry:    { ...pending.byCountry },
```

And replace these lines (also in `flushPending`, around line 3794):

```js
pending.user = 0; pending.global = 0; pending.daily = 0;
```

with:

```js
pending.userCoins = 0; pending.userClicks = 0; pending.global = 0; pending.daily = 0;
```

- [ ] **Step 6: Update `flushPending`'s `inFlightUser` handoff to split**

Find this block (around line 3802):

```js
const wasInFlightGlobal = inFlightGlobal;
const wasInFlightSkin   = inFlightSkin;
const wasInFlightUser   = inFlightUser;
const skinDeltaInBatch  = batch.allTimeSkin[currentSkinVariant] || 0;
inFlightGlobal += batch.global;
inFlightSkin   += skinDeltaInBatch;
inFlightUser   += batch.user;
```

Replace with:

```js
const wasInFlightGlobal     = inFlightGlobal;
const wasInFlightSkin       = inFlightSkin;
const wasInFlightUserCoins  = inFlightUserCoins;
const wasInFlightUserClicks = inFlightUserClicks;
const skinDeltaInBatch      = batch.allTimeSkin[currentSkinVariant] || 0;
inFlightGlobal     += batch.global;
inFlightSkin       += skinDeltaInBatch;
inFlightUserCoins  += batch.userCoins;
inFlightUserClicks += batch.userClicks;
```

- [ ] **Step 7: Update the per-user multi-path update inside `flushPending`**

Find this block (around line 3820):

```js
if (currentUser && (batch.user > 0 || Object.keys(batch.userBySource).length > 0)) {
  const uid = currentUser.uid;
  const update = {};
  if (batch.user > 0) {
    const incU = firebase.database.ServerValue.increment(batch.user);
    update[`users/${uid}/stats/totalClicks`] = incU;
    update[`users/${uid}/stats/coinBalance`] = incU;
  }
  for (const src in batch.userBySource) {
    update[`users/${uid}/stats/bySource/${src}`] =
      firebase.database.ServerValue.increment(batch.userBySource[src]);
  }
  update[`users/${uid}/stats/lastClickAt`] = firebase.database.ServerValue.TIMESTAMP;
  tasks.push(db.ref().update(update));
}
```

Replace with:

```js
const hasClickActivity = batch.userClicks > 0 || Object.keys(batch.userBySource).length > 0;
const hasCoinChange    = batch.userCoins !== 0;
if (currentUser && (hasClickActivity || hasCoinChange)) {
  const uid = currentUser.uid;
  const update = {};
  if (batch.userClicks > 0) {
    update[`users/${uid}/stats/totalClicks`] = firebase.database.ServerValue.increment(batch.userClicks);
  }
  if (batch.userCoins !== 0) {
    update[`users/${uid}/stats/coinBalance`] = firebase.database.ServerValue.increment(batch.userCoins);
  }
  for (const src in batch.userBySource) {
    update[`users/${uid}/stats/bySource/${src}`] =
      firebase.database.ServerValue.increment(batch.userBySource[src]);
  }
  // Only update lastClickAt when there's actual click activity. A pure coin
  // debit (purchase) must NOT advance lastClickAt, or the next real click
  // would trip the 1s throttle on totalClicks/bySource validation.
  if (hasClickActivity) {
    update[`users/${uid}/stats/lastClickAt`] = firebase.database.ServerValue.TIMESTAMP;
  }
  tasks.push(db.ref().update(update));
}
```

- [ ] **Step 8: Update `flushPending`'s rollback block**

Find this block (around line 3869):

```js
pending.user       += batch.user;
pending.global     += batch.global;
pending.daily      += batch.daily;
```

Replace with:

```js
pending.userCoins  += batch.userCoins;
pending.userClicks += batch.userClicks;
pending.global     += batch.global;
pending.daily      += batch.daily;
```

And find the inFlight rollback below (around line 3880):

```js
inFlightGlobal = wasInFlightGlobal;
inFlightSkin   = wasInFlightSkin;
inFlightUser   = wasInFlightUser;
```

Replace with:

```js
inFlightGlobal     = wasInFlightGlobal;
inFlightSkin       = wasInFlightSkin;
inFlightUserCoins  = wasInFlightUserCoins;
inFlightUserClicks = wasInFlightUserClicks;
```

- [ ] **Step 9: Update flush trigger check (`scheduleFlush` heartbeat and start)**

Find these conditions (around line 3748 and 3902):

```js
if (pending.user > 0 || pending.global > 0) flushPending();
```

```js
authReady.then(() => {
  if (pending.user > 0 || pending.global > 0) scheduleFlush();
});
```

Replace each `pending.user > 0` with `pending.userCoins !== 0 || pending.userClicks > 0`. Final:

```js
if (pending.userCoins !== 0 || pending.userClicks > 0 || pending.global > 0) flushPending();
```

```js
authReady.then(() => {
  if (pending.userCoins !== 0 || pending.userClicks > 0 || pending.global > 0) scheduleFlush();
});
```

Also update the early-out at the top of `flushPending` (around line 3781):

```js
if (pending.user === 0 && pending.global === 0) return;
```

Replace with:

```js
if (pending.userCoins === 0 && pending.userClicks === 0 && pending.global === 0) return;
```

- [ ] **Step 10: Replace `inFlightUser` declaration with two new ones**

Find this line (around line 3266):

```js
let inFlightUser = 0;
```

Replace with:

```js
let inFlightUserCoins  = 0;
let inFlightUserClicks = 0;
```

- [ ] **Step 11: Update `renderSenseiBar` to use the new fields**

Find this block (around line 3279):

```js
const pendingUser = (typeof pending !== 'undefined' && pending) ? (pending.user || 0) : 0;
const clicks = (userStats.totalClicks || 0) + pendingUser + inFlightUser;
const coins  = (userStats.coinBalance || 0) + pendingUser + inFlightUser;
```

Replace with:

```js
const pendingCoins  = (typeof pending !== 'undefined' && pending) ? (pending.userCoins  || 0) : 0;
const pendingClicks = (typeof pending !== 'undefined' && pending) ? (pending.userClicks || 0) : 0;
const clicks = (userStats.totalClicks || 0) + pendingClicks + inFlightUserClicks;
const coins  = (userStats.coinBalance || 0) + pendingCoins  + inFlightUserCoins;
```

- [ ] **Step 12: Update the stats listener's `inFlightUser` release**

Find this block in `subscribeUserData` (around line 3325):

```js
const statsCb  = (snap) => {
  const next = snap.val() || { totalClicks: 0, coinBalance: 0 };
  if (inFlightUser > 0 && (next.totalClicks || 0) >= (userStats.totalClicks || 0) + inFlightUser) {
    inFlightUser = 0;
  }
  userStats = next;
```

Replace with:

```js
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
```

- [ ] **Step 13: Verify**

Open `index.html` in the browser (live-server, `serve.bat`, or whatever the project usually uses). Open DevTools Console. Run:

```js
pending
```

Expected: object with `userCoins: 0, userClicks: 0, ...` (no `user` key — unless localStorage still holds an old batch, in which case it gets migrated and disappears on next save).

Click the character 10 times. Run `pending` again — `userCoins` and `userClicks` should both equal 10. Sensei bar coin + click counts should both have ticked up by 10. Wait 5s, run `pending` again — both should be 0 (flushed).

Reload the page. Sensei bar should show the updated totals from server.

- [ ] **Step 14: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Shop: split pending.user into userCoins/userClicks

Preparatory refactor for shop multipliers: coin and click gains can now
differ per source (mouse vs auto) and per upgrade (coin-mul vs click-mul).

Behavior unchanged — both fields still bump by +1 per mouse click.
Migration in loadPending maps pre-existing pending.user to both fields 1:1.
EOF
)"
```

---

## Task 3: Subscribe to `users/{uid}/shop` and add shop state

**Files:**
- Modify: `index.html` (state declarations near user data subscription, ~line 3257; subscribeUserData ~line 3319)

- [ ] **Step 1: Add `userShop` state and unsubscribe handle**

Find these declarations (around line 3257):

```js
let userStats = { totalClicks: 0, coinBalance: 0 };
let userProfile = null;
let userStatsUnsub = null;
let userProfileUnsub = null;
```

Add below them:

```js
let userShop = {};                 // { coinMulLevel, clickMulLevel, autoLevel, leaderboardAutoUnlocked, buffs }
let userShopUnsub = null;
```

- [ ] **Step 2: Subscribe to `users/{uid}/shop` inside `subscribeUserData`**

Find this block (around line 3319):

```js
function subscribeUserData(uid) {
  if (userStatsUnsub)   { userStatsUnsub();   userStatsUnsub = null; }
  if (userProfileUnsub) { userProfileUnsub(); userProfileUnsub = null; }
  if (!uid) { userStats = { totalClicks: 0, coinBalance: 0 }; userProfile = null; renderSenseiBar(); return; }
```

Replace with:

```js
function subscribeUserData(uid) {
  if (userStatsUnsub)   { userStatsUnsub();   userStatsUnsub = null; }
  if (userProfileUnsub) { userProfileUnsub(); userProfileUnsub = null; }
  if (userShopUnsub)    { userShopUnsub();    userShopUnsub = null; }
  if (!uid) {
    userStats = { totalClicks: 0, coinBalance: 0 };
    userProfile = null;
    userShop = {};
    renderSenseiBar();
    if (typeof renderShopPanel === 'function') renderShopPanel();
    if (typeof rearmAutoLoop === 'function')   rearmAutoLoop();
    return;
  }
```

Then find the end of `subscribeUserData` (just before its closing brace, after the `profRef.on('value', profCb); userProfileUnsub = ...` line, around line 3362). Insert just before the function's closing `}`:

```js
  const shopRef = db.ref('users/' + uid + '/shop');
  const shopCb  = (snap) => {
    userShop = snap.val() || {};
    if (typeof renderShopPanel === 'function') renderShopPanel();
    if (typeof syncBuffTimers === 'function')  syncBuffTimers();
    if (typeof rearmAutoLoop === 'function')   rearmAutoLoop();
  };
  shopRef.on('value', shopCb);
  userShopUnsub = () => shopRef.off('value', shopCb);
```

(`renderShopPanel`, `syncBuffTimers`, and `rearmAutoLoop` are defined in later tasks. The `typeof === 'function'` guards keep this safe to ship before those exist.)

- [ ] **Step 3: Verify**

Reload the page. Open DevTools Console:

```js
userShop
```

Expected: `{}` (no shop data written yet). No errors in the console about `renderShopPanel is not defined` — the guards should kick in.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Shop: subscribe to users/{uid}/shop and add userShop state"
```

---

## Task 4: Add shop helper functions (`shopMul`, `costFor`, `effectFor`, `fieldFor`)

These are pure functions consumed by render and recordClick. Defining them up front means later tasks can reference them.

**Files:**
- Modify: `index.html` (add a new block just below the `userShop` declarations from Task 3, ~line 3270)

- [ ] **Step 1: Add the shop helper block**

Insert immediately after the `let userShopUnsub = null;` line added in Task 3:

```js
// --- Shop helpers -----------------------------------------------------------
const SHOP_MAX_LEVEL = 20;
const SHOP_BUFF_COST = 500;
const SHOP_BUFF_DURATION_MS = 60_000;
const SHOP_LBAUTO_COST = 50_000;

function shopFieldFor(which) {
  if (which === 'coinMul')    return 'coinMulLevel';
  if (which === 'clickMul')   return 'clickMulLevel';
  if (which === 'autoLevel')  return 'autoLevel';
  return null;
}

function shopCostFor(which, level) {
  if (which === 'coinMul' || which === 'clickMul') return Math.round(100 * Math.pow(2, level));
  if (which === 'autoLevel')                       return Math.round(200 * Math.pow(1.6, level));
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
  return {
    coin:     (1 + 0.5 * (s.coinMulLevel  || 0)) * (active('coins')    ? 2 : 1),
    click:    (1 + 0.5 * (s.clickMulLevel || 0)) * (active('clicks')   ? 2 : 1),
    autoCps:  0.5 * (s.autoLevel || 0)           * (active('autoRate') ? 2 : 1),
    lbAuto:   !!s.leaderboardAutoUnlocked,
  };
}
// ----------------------------------------------------------------------------
```

- [ ] **Step 2: Verify**

Reload the page. In DevTools Console:

```js
shopMul(Date.now())
```

Expected: `{ coin: 1, click: 1, autoCps: 0, lbAuto: false }` (defaults — no shop data yet).

```js
shopCostFor('coinMul', 0)
```

Expected: `100`.

```js
shopCostFor('autoLevel', 5)
```

Expected: `2097` (200 × 1.6^5 ≈ 2097.152 rounded).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Shop: add helper functions (shopMul, shopCostFor, shopEffectFor)"
```

---

## Task 5: Add shop panel button + empty panel markup + CSS

**Files:**
- Modify: `index.html` (CSS section ~line 478–925; HTML markup near line 1556)

- [ ] **Step 1: Add `#shop-btn` positioning CSS**

Find this line (around line 923):

```css
    #leaderboard-btn { top: 16px; right: 70px; }
```

Add an adjacent shop button. Replace that line and the mobile overrides below it. Find:

```css
    #stats-btn { top: 16px; right: 20px; }
```

Replace with:

```css
    #stats-btn { top: 16px; right: 20px; }
    #shop-btn  { top: 16px; right: 120px; }
```

Then find this block (around line 923–928):

```css
    #leaderboard-btn { top: 16px; right: 70px; }
    @media (max-width: 768px) {
      #leaderboard-btn { top: 12px; right: 56px; }
    }
    @media (max-width: 480px) {
      #leaderboard-btn { top: 8px; }
    }
```

Replace with:

```css
    #leaderboard-btn { top: 16px; right: 70px; }
    @media (max-width: 768px) {
      #leaderboard-btn { top: 12px; right: 56px; }
      #shop-btn        { top: 12px; right: 100px; }
    }
    @media (max-width: 480px) {
      #leaderboard-btn { top: 8px; }
      #shop-btn        { top: 8px; right: 88px; }
    }
```

Also find this block (around line 1407):

```css
      #settings-btn, #skins-btn, #stats-btn { top: 8px; }
```

Replace with:

```css
      #settings-btn, #skins-btn, #stats-btn, #shop-btn { top: 8px; }
```

- [ ] **Step 2: Add `#shop-panel` and shop-item CSS**

Find the existing `#skins-panel` CSS block (search for `#skins-panel {`). Just below the closing `}` of the `#skins-panel`-related rules, insert this block:

```css
    #shop-panel {
      position: fixed;
      top: 60px;
      right: 20px;
      width: 320px;
      max-height: 70vh;
      overflow-y: auto;
      background: rgba(20, 20, 36, 0.95);
      border: 1px solid var(--ba-border);
      border-radius: 8px;
      padding: 16px;
      backdrop-filter: blur(8px);
      opacity: 0;
      pointer-events: none;
      transform: translateY(-8px);
      transition: opacity 180ms ease, transform 180ms ease;
      z-index: 100;
      color: #fff;
    }
    #shop-panel.open {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    .shop-section { margin-bottom: 12px; }
    .shop-section-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.6;
      margin-bottom: 6px;
    }
    .shop-item {
      display: block;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      transition: background 120ms, border-color 120ms;
      font: inherit;
      color: inherit;
      text-align: left;
    }
    .shop-item:hover { background: rgba(255, 255, 255, 0.08); border-color: var(--ba-accent); }
    .shop-item[aria-disabled="true"] {
      opacity: 0.4;
      cursor: not-allowed;
      pointer-events: none;
    }
    .shop-item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .shop-item-sub {
      font-size: 0.8rem;
      opacity: 0.7;
      margin-top: 2px;
    }
    .shop-item-cost { color: var(--ba-accent-strong); white-space: nowrap; }
    .shop-item.flash-error {
      animation: shop-shake 0.4s ease;
      border-color: #ff5555;
    }
    @keyframes shop-shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-4px); }
      75% { transform: translateX(4px); }
    }
```

- [ ] **Step 3: Add the shop button HTML**

Find this line (around line 1557, the existing leaderboard button):

```html
  <!-- Leaderboard -->
  <button id="leaderboard-btn" class="panel-btn" aria-label="Leaderboard">
```

Insert immediately above the `<!-- Leaderboard -->` comment:

```html
  <!-- Shop -->
  <button id="shop-btn" class="panel-btn" aria-label="Shop">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="9" cy="20" r="1.5"/>
      <circle cx="17" cy="20" r="1.5"/>
      <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.2a2 2 0 0 0 2-1.4L21 7H6"/>
    </svg>
  </button>
  <div id="shop-panel">
    <div class="settings-title" data-i18n="shop.title">Shop</div>
    <div class="shop-section">
      <div class="shop-section-title" data-i18n="shop.permanent">Permanent</div>
      <div class="shop-item" data-item="coinMul"></div>
      <div class="shop-item" data-item="clickMul"></div>
    </div>
    <div class="shop-section">
      <div class="shop-section-title" data-i18n="shop.auto">Auto</div>
      <div class="shop-item" data-item="autoLevel"></div>
      <div class="shop-item" data-item="leaderboardAuto"></div>
    </div>
    <div class="shop-section">
      <div class="shop-section-title" data-i18n="shop.buffs">Buffs (60s)</div>
      <div class="shop-item" data-item="buffCoins"></div>
      <div class="shop-item" data-item="buffClicks"></div>
      <div class="shop-item" data-item="buffAutoRate"></div>
    </div>
  </div>
```

- [ ] **Step 4: Wire up button toggle + outside-click dismiss**

Find this block (around line 2511):

```js
skinsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  skinsPanel.classList.toggle('open');
});
```

Add immediately below it:

```js
const shopBtn   = document.getElementById('shop-btn');
const shopPanel = document.getElementById('shop-panel');
shopBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  shopPanel.classList.toggle('open');
  if (typeof renderShopPanel === 'function') renderShopPanel();   // refresh on open
});
shopPanel.addEventListener('click', (e) => e.stopPropagation());
```

Then find the outside-click dismiss block (around line 2517):

```js
document.addEventListener('click', (e) => {
  if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
    settingsPanel.classList.remove('open');
  }
  if (!skinsPanel.contains(e.target) && e.target !== skinsBtn) {
    skinsPanel.classList.remove('open');
  }
});
```

Replace with:

```js
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
```

- [ ] **Step 5: Verify**

Reload the page. Click the new cart icon in the top-right (next to Leaderboard). The shop panel slides in, showing three section headers (Permanent / Auto / Buffs) with empty `.shop-item` boxes. Click outside the panel — it closes. Click the cart icon again — it reopens.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Shop: add panel button, empty panel markup, and CSS"
```

---

## Task 6: Implement `renderShopPanel()` (read-only display)

**Files:**
- Modify: `index.html` (add a new block right after the shop helpers from Task 4, ~line 3310)

- [ ] **Step 1: Add the render function and helpers**

Insert immediately after the shop helpers block from Task 4 (after the `// ---` end marker):

```js
// --- Shop render ------------------------------------------------------------
const shopPanelEl = () => document.getElementById('shop-panel');

function shopAffordableCoins() {
  return (userStats.coinBalance || 0) + (pending.userCoins || 0);
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
  const panel = shopPanelEl();
  if (!panel) return;

  const now = Date.now();
  const s = userShop || {};
  const have = shopAffordableCoins();

  // -- Permanent: coin / click multipliers --
  const items = [
    {
      which: 'coinMul',
      name:  I18N.t('shop.item.coinMul.name'),
      level: s.coinMulLevel || 0,
    },
    {
      which: 'clickMul',
      name:  I18N.t('shop.item.clickMul.name'),
      level: s.clickMulLevel || 0,
    },
    {
      which: 'autoLevel',
      name:  I18N.t('shop.item.autoLevel.name'),
      level: s.autoLevel || 0,
    },
  ];

  for (const it of items) {
    const el = panel.querySelector(`.shop-item[data-item="${it.which}"]`);
    if (!el) continue;
    const atMax = it.level >= SHOP_MAX_LEVEL;
    const cost = atMax ? 0 : shopCostFor(it.which, it.level);
    const curEffect  = shopEffectFor(it.which, it.level);
    const nextEffect = shopEffectFor(it.which, it.level + 1);
    const effectFmt = (v) => it.which === 'autoLevel' ? `${v.toFixed(1)} c/s` : `×${v}`;
    const levelText = atMax ? I18N.t('shop.atMax') : `Lv ${it.level} → Lv ${it.level + 1}`;
    const costText  = atMax ? '' : `💰 ${shopFormatNum(cost)}`;
    const subText   = atMax
      ? effectFmt(curEffect)
      : `${effectFmt(curEffect)} → ${effectFmt(nextEffect)}`;
    el.innerHTML = `
      <div class="shop-item-row">
        <span>${escapeHtml(it.name)}</span>
        <span>${levelText}</span>
        <span class="shop-item-cost">${costText}</span>
      </div>
      <div class="shop-item-sub">${subText}</div>
    `;
    el.setAttribute('aria-disabled', (atMax || have < cost) ? 'true' : 'false');
  }

  // -- Leaderboard Auto (one-shot) --
  {
    const el = panel.querySelector('.shop-item[data-item="leaderboardAuto"]');
    if (el) {
      const owned = !!s.leaderboardAutoUnlocked;
      const cost  = SHOP_LBAUTO_COST;
      const levelText = owned ? I18N.t('shop.owned') : '';
      const costText  = owned ? '' : `💰 ${shopFormatNum(cost)}`;
      el.innerHTML = `
        <div class="shop-item-row">
          <span>${escapeHtml(I18N.t('shop.item.leaderboardAuto.name'))}</span>
          <span>${levelText}</span>
          <span class="shop-item-cost">${costText}</span>
        </div>
        <div class="shop-item-sub">${escapeHtml(I18N.t('shop.item.leaderboardAuto.desc'))}</div>
      `;
      el.setAttribute('aria-disabled', (owned || have < cost) ? 'true' : 'false');
    }
  }

  // -- Buffs --
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
    const remaining = active ? shopFormatTimeLeft(exp - now) : '';
    const levelText = active ? `${remaining} left` : '';
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
}
// ----------------------------------------------------------------------------
```

- [ ] **Step 2: Trigger renders from existing listeners**

In the stats listener inside `subscribeUserData`, add a call right after `renderSenseiBar();` (find this line — there are two, in `statsCb` around line 3333):

```js
userStats = next;
renderSenseiBar();
```

Replace with:

```js
userStats = next;
renderSenseiBar();
if (typeof renderShopPanel === 'function') renderShopPanel();
```

(The `shopCb` already calls `renderShopPanel` per Task 3.)

- [ ] **Step 3: Trigger an initial render**

After the existing `renderSenseiBar();` call at the bottom of the script (around line 3369), add:

```js
renderSenseiBar();
renderShopPanel();
```

(Find the standalone `renderSenseiBar();` line that's not inside a function, and add `renderShopPanel();` right after.)

- [ ] **Step 4: Verify**

Reload. Open the shop panel. Three Permanent / Auto / Buffs sections should now render with:
- Coin Multiplier `Lv 0 → Lv 1  💰 100`, sub: `×1 → ×1.5`
- Click Multiplier `Lv 0 → Lv 1  💰 100`, sub: `×1 → ×1.5`
- Auto-Clicker `Lv 0 → Lv 1  💰 200`, sub: `0.0 c/s → 0.5 c/s`
- Leaderboard Auto `💰 50,000`, sub: localized description (the i18n key fallbacks to the key itself if Task 11 hasn't run yet — that's OK, you'll see `shop.item.leaderboardAuto.desc` until then)
- Three buff rows showing `💰 500`

All rows except Buffs (if you have coins) should be disabled (dimmed) on a fresh account with 0 coins.

In DevTools Console, force-grant coins to see affordability:

```js
db.ref('users/' + currentUser.uid + '/stats/coinBalance').set(1000);
```

The panel should re-render and the Lv0→Lv1 rows become clickable (not dimmed).

Reset the balance to 0 after testing:

```js
db.ref('users/' + currentUser.uid + '/stats/coinBalance').set(0);
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Shop: render panel items with current level, cost, and affordability"
```

---

## Task 7: Implement buy handlers (`buyLeveled`, `buyOneShot`, `buyBuff`) + click delegation

**Files:**
- Modify: `index.html` (add below the render function from Task 6)

- [ ] **Step 1: Add the three buy functions**

Insert immediately after the `renderShopPanel` function block:

```js
// --- Shop buy handlers ------------------------------------------------------
function shopShowError(itemEl) {
  if (!itemEl) return;
  itemEl.classList.add('flash-error');
  setTimeout(() => itemEl.classList.remove('flash-error'), 500);
}

async function buyLeveled(which, itemEl) {
  if (!currentUser) return;
  const field = shopFieldFor(which);
  if (!field) return;
  const level = userShop[field] || 0;
  if (level >= SHOP_MAX_LEVEL) return;
  const cost = shopCostFor(which, level);
  if (shopAffordableCoins() < cost) { shopShowError(itemEl); return; }

  // Optimistic debit + temporary row disable to dampen double-clicks.
  pending.userCoins -= cost;
  if (itemEl) itemEl.setAttribute('aria-disabled', 'true');
  scheduleFlush();
  renderSenseiBar();
  renderShopPanel();

  try {
    await db.ref(`users/${currentUser.uid}/shop/${field}`).set(level + 1);
  } catch (err) {
    // Server rejected (likely level cap raced); refund optimistic debit.
    pending.userCoins += cost;
    scheduleFlush();
    renderSenseiBar();
    renderShopPanel();
    shopShowError(itemEl);
  }
}

async function buyOneShot(itemEl) {
  if (!currentUser) return;
  if (userShop.leaderboardAutoUnlocked) return;
  const cost = SHOP_LBAUTO_COST;
  if (shopAffordableCoins() < cost) { shopShowError(itemEl); return; }

  pending.userCoins -= cost;
  if (itemEl) itemEl.setAttribute('aria-disabled', 'true');
  scheduleFlush();
  renderSenseiBar();
  renderShopPanel();

  try {
    await db.ref(`users/${currentUser.uid}/shop/leaderboardAutoUnlocked`).set(true);
  } catch (err) {
    pending.userCoins += cost;
    scheduleFlush();
    renderSenseiBar();
    renderShopPanel();
    shopShowError(itemEl);
  }
}

async function buyBuff(kind, itemEl) {
  if (!currentUser) return;
  if (!['coins','clicks','autoRate'].includes(kind)) return;
  const cost = SHOP_BUFF_COST;
  if (shopAffordableCoins() < cost) { shopShowError(itemEl); return; }

  pending.userCoins -= cost;
  scheduleFlush();
  renderSenseiBar();
  renderShopPanel();

  try {
    const buffRef = db.ref(`users/${currentUser.uid}/shop/buffs/${kind}/expiresAt`);
    await buffRef.transaction(current => {
      const baseFloor = Date.now();
      const base = (typeof current === 'number' && current > baseFloor) ? current : baseFloor;
      return base + SHOP_BUFF_DURATION_MS;
    });
  } catch (err) {
    pending.userCoins += cost;
    scheduleFlush();
    renderSenseiBar();
    renderShopPanel();
    shopShowError(itemEl);
  }
}

// Click delegation for the whole shop panel.
document.getElementById('shop-panel').addEventListener('click', (e) => {
  const item = e.target.closest('.shop-item');
  if (!item || item.getAttribute('aria-disabled') === 'true') return;
  const which = item.dataset.item;
  if (which === 'coinMul' || which === 'clickMul' || which === 'autoLevel') return buyLeveled(which, item);
  if (which === 'leaderboardAuto') return buyOneShot(item);
  if (which === 'buffCoins')    return buyBuff('coins',    item);
  if (which === 'buffClicks')   return buyBuff('clicks',   item);
  if (which === 'buffAutoRate') return buyBuff('autoRate', item);
});
// ----------------------------------------------------------------------------
```

- [ ] **Step 2: Verify — buy Coin Multiplier**

Reload. Click the character ~150 times so coinBalance reaches ~150 (look at sensei bar). Wait 5s for flush. Open the shop. Coin Multiplier row should be clickable.

Click Coin Multiplier. Sensei bar coin count drops by 100. Within ~1s, the row updates to `Lv 1 → Lv 2  💰 200`, sub `×1.5 → ×2`. Verify in DevTools:

```js
userShop
```

Expected: `{ coinMulLevel: 1 }`.

- [ ] **Step 3: Verify — buy Leaderboard Auto (force coin grant)**

In DevTools:

```js
db.ref('users/' + currentUser.uid + '/stats/coinBalance').set(60000);
```

Wait for sensei bar to update. Open shop, click Leaderboard Auto row. Balance drops to 10,000. Row shows `Owned` (or your localized version), aria-disabled=true.

- [ ] **Step 4: Verify — buy a buff**

With remaining 10,000 coins, click `×2 coins` buff. Balance drops by 500. The row should immediately show `0:59 left` (or similar — note: the countdown won't auto-tick until Task 9, so it'll stay frozen at the same value until you reload). In DevTools:

```js
userShop.buffs
```

Expected: `{ coins: { expiresAt: <some ms timestamp> } }`.

- [ ] **Step 5: Verify — affordability gating**

Set coinBalance to 50:

```js
db.ref('users/' + currentUser.uid + '/stats/coinBalance').set(50);
```

All shop rows should re-render as dimmed (aria-disabled=true). Clicking any row should do nothing (no console errors).

- [ ] **Step 6: Clean up test data**

```js
db.ref('users/' + currentUser.uid + '/shop').remove();
db.ref('users/' + currentUser.uid + '/stats/coinBalance').set(0);
db.ref('users/' + currentUser.uid + '/stats/totalClicks').set(0);
```

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "Shop: implement buyLeveled, buyOneShot, buyBuff with optimistic debit"
```

---

## Task 8: Apply `shopMul` to mouse-click accounting

Currently `recordClick('mouse')` bumps `pending.userCoins/userClicks/global/daily/bySkin/etc` by 1. After this task, mouse clicks bump by `shopMul.coin` (coins) and `shopMul.click` (everything else clicks-related).

**Files:**
- Modify: `index.html` (`recordClick` ~line 3755)

- [ ] **Step 1: Replace `recordClick` body**

Find `recordClick` (around line 3755):

```js
function recordClick(source) {
  const { character: ch, variant: v } = getVariant(settings.skin);
  if (source === 'mouse') {
    pending.userCoins  += 1;
    pending.userClicks += 1;
  }
  pending.global += 1;
  pending.daily += 1;
  if (visitorCountry) {
    pending.byCountry[visitorCountry] = (pending.byCountry[visitorCountry] || 0) + 1;
  }
  pending.bySkin[v.id]        = (pending.bySkin[v.id]        || 0) + 1;
  pending.byCharacter[ch.id]  = (pending.byCharacter[ch.id]  || 0) + 1;
  pending.allTimeSkin[v.id]   = (pending.allTimeSkin[v.id]   || 0) + 1;
  pending.bySource[source]     = (pending.bySource[source]     || 0) + 1;
  pending.userBySource[source] = (pending.userBySource[source] || 0) + 1;
  savePending();
  scheduleFlush();
  if (typeof renderSenseiBar    === 'function') renderSenseiBar();
  if (typeof renderClickCounter === 'function') renderClickCounter();
}
```

Replace the entire function with:

```js
function recordClick(source) {
  const { character: ch, variant: v } = getVariant(settings.skin);
  const m = shopMul(Date.now());

  if (source === 'mouse') {
    // Mouse clicks scale by both multipliers (independent tracks per spec).
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
    // Keyboard: unchanged 1-per-key semantic. Doesn't earn coins, doesn't
    // touch userClicks (leaderboard stays mouse-only by design).
    pending.global += 1;
    pending.daily  += 1;
    if (visitorCountry) {
      pending.byCountry[visitorCountry] = (pending.byCountry[visitorCountry] || 0) + 1;
    }
    pending.bySkin[v.id]         = (pending.bySkin[v.id]         || 0) + 1;
    pending.byCharacter[ch.id]   = (pending.byCharacter[ch.id]   || 0) + 1;
    pending.allTimeSkin[v.id]    = (pending.allTimeSkin[v.id]    || 0) + 1;
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
  savePending();
  scheduleFlush();
  if (typeof renderSenseiBar    === 'function') renderSenseiBar();
  if (typeof renderClickCounter === 'function') renderClickCounter();
}
```

- [ ] **Step 2: Verify — no multipliers (default state)**

Reload (after running the cleanup from Task 7 Step 6). Click the character once. Sensei bar shows clicks +1, coins +1. No regression.

- [ ] **Step 3: Verify — coin multiplier applies**

Force a coin multiplier level via DevTools:

```js
db.ref('users/' + currentUser.uid + '/shop/coinMulLevel').set(2);  // ×2 coin
```

Click the character once. Sensei bar shows clicks +1, coins +2.

```js
db.ref('users/' + currentUser.uid + '/shop/clickMulLevel').set(2); // ×2 click
```

Click once. Clicks +2, coins +2.

- [ ] **Step 4: Verify — keyboard unchanged**

(If `settings.keyboardClicks` is on, pressing any key counts.) Press a key. Click count on the front-page pill goes up by 1 (no multiplier), sensei bar `clicks`/`coins` do NOT change (keyboard never touches userClicks/userCoins).

- [ ] **Step 5: Clean up**

```js
db.ref('users/' + currentUser.uid + '/shop').remove();
db.ref('users/' + currentUser.uid + '/stats').remove();
```

(Anonymous-only — don't run this on a linked account in production.)

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Shop: apply coin/click multipliers to recordClick"
```

---

## Task 9: Auto-clicker — loop, side cursor sprite, animation

**Files:**
- Modify: `index.html` (HTML markup inside `#character` ~line 1493; CSS section; new JS block after the shop buy handlers)

- [ ] **Step 1: Add the `#auto-cursor` markup inside `#character`**

Find this block (around line 1492 — search for `<div id="character">` and the `<button id="idle-bubble"` inside):

```html
<div id="character">
  <button id="idle-bubble" type="button" hidden>
    <span id="idle-bubble-text"></span>
  </button>
  <img id="aoba-img"
```

(Insert `#auto-cursor` between the `idle-bubble` button and the `img`.) Replace with:

```html
<div id="character">
  <button id="idle-bubble" type="button" hidden>
    <span id="idle-bubble-text"></span>
  </button>
  <div id="auto-cursor" hidden aria-hidden="true">
    <svg viewBox="0 0 24 24" width="48" height="48" fill="#fff" stroke="#222" stroke-width="1.5" stroke-linejoin="round">
      <path d="M5 3 L5 18 L9 14 L11 19 L13.5 18 L11.5 13 L17 13 Z"/>
    </svg>
  </div>
  <img id="aoba-img"
```

(The `<img id="aoba-img"` line continues from the existing markup — don't duplicate the existing attributes.)

- [ ] **Step 2: Add CSS for the auto cursor and its poke animation**

Find any spot in the `<style>` block — a good anchor is the existing `#idle-bubble` rules. Insert after them:

```css
    #auto-cursor {
      position: absolute;
      right: -20%;
      top: 35%;
      pointer-events: none;
      z-index: 30;
      transform: translateX(0);
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));
    }
    #auto-cursor[data-poking="true"] {
      animation: auto-cursor-poke 300ms ease-out;
    }
    @keyframes auto-cursor-poke {
      0%   { transform: translateX(0); }
      33%  { transform: translateX(-40px); }
      100% { transform: translateX(0); }
    }
    @media (max-width: 600px) {
      #auto-cursor { right: -12%; }
      #auto-cursor svg { width: 36px; height: 36px; }
    }
```

- [ ] **Step 3: Add the auto-clicker loop block**

Insert immediately after the shop buy handlers block from Task 7:

```js
// --- Auto-clicker -----------------------------------------------------------
let autoTimer = null;
const AUTO_PERIOD_MS_FLOOR = 80;   // never tick faster than 12.5/s regardless of future tuning

function currentAutoCps() {
  const m = shopMul(Date.now());
  return m.autoCps;                // 0 if autoLevel === 0 and no autoRate buff
}

function pokeAutoCursor() {
  const el = document.getElementById('auto-cursor');
  if (!el) return;
  // Re-trigger the CSS animation by toggling the attribute off and on.
  el.removeAttribute('data-poking');
  // Force reflow so the next setAttribute re-runs the animation.
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.setAttribute('data-poking', 'true');
}

function autoTick() {
  if (introActive) return;
  recordClick('auto');
  pokeAutoCursor();
}

function rearmAutoLoop() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  const el = document.getElementById('auto-cursor');
  if (!el) return;
  const cps = currentAutoCps();
  el.hidden = (cps <= 0);
  if (cps <= 0) return;
  const periodMs = Math.max(AUTO_PERIOD_MS_FLOOR, 1000 / cps);
  autoTimer = setInterval(autoTick, periodMs);
}

// Re-check on tab visibility resume — buffs may have expired while hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (typeof syncBuffTimers === 'function') syncBuffTimers();
    rearmAutoLoop();
  }
});
// ----------------------------------------------------------------------------
```

- [ ] **Step 4: Kick off the loop after intro ends**

Find `endIntro` (around line 3971) and the line `scheduleIdleBubble();` near its end (around line 4023). Insert below it:

```js
      // Arm the idle-text bubble timer now that intro is over
      scheduleIdleBubble();
      // Same trigger point for the auto-clicker — suppressed during intro.
      rearmAutoLoop();
```

- [ ] **Step 5: Verify — Lv0 (off)**

Reload. Click curtain to end intro. Check DevTools — no `auto-cursor` visible (it has `hidden` attribute). No errors.

- [ ] **Step 6: Verify — buy Auto-Clicker Lv1**

Force coins and buy:

```js
db.ref('users/' + currentUser.uid + '/stats/coinBalance').set(500);
```

Open shop. Click Auto-Clicker row. After ~1 sec, the cursor sprite appears at the right edge of the character. Every 2 sec it animates a poke (slides left then back). Sensei bar `coins` ticks up by 1 every 2 sec. `totalClicks` stays unchanged (Leaderboard Auto NOT unlocked). The character does NOT bounce. No SFX plays.

- [ ] **Step 7: Verify — level up + buff**

Force level 5 and the autoRate buff:

```js
db.ref('users/' + currentUser.uid + '/shop/autoLevel').set(5);
db.ref('users/' + currentUser.uid + '/shop/buffs/autoRate/expiresAt').set(Date.now() + 60000);
```

Cursor pokes much faster (5 cps × 2 = 10 cps → 100 ms per tick). Coin pill rises quickly.

- [ ] **Step 8: Verify — Leaderboard Auto unlocks click contribution**

```js
db.ref('users/' + currentUser.uid + '/shop/leaderboardAutoUnlocked').set(true);
```

`totalClicks` should now also increase with each auto-tick. Leaderboard rank moves while AFK.

- [ ] **Step 9: Clean up**

```js
db.ref('users/' + currentUser.uid + '/shop').remove();
db.ref('users/' + currentUser.uid + '/stats').remove();
```

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "Shop: auto-clicker loop + side cursor sprite + poke animation"
```

---

## Task 10: Buff countdown rendering + per-buff expiry timers

**Files:**
- Modify: `index.html` (add a new block right after the auto-clicker block from Task 9)

- [ ] **Step 1: Add the buff-timer block**

Insert immediately after the auto-clicker block:

```js
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
        // The buff has expired. autoCps may change (autoRate buff), so re-arm
        // the auto-loop. Re-render the panel for fresh labels.
        rearmAutoLoop();
        renderShopPanel();
        // Stop the countdown interval if no buffs remain.
        if (!anyBuffActive() && buffCountdownInterval) {
          clearInterval(buffCountdownInterval);
          buffCountdownInterval = null;
        }
      }, exp - now + 50);
    }
  }
  // Start a 1s countdown ticker if any buff is active and we don't have one.
  if (anyBuffActive() && !buffCountdownInterval) {
    buffCountdownInterval = setInterval(() => {
      // Only refresh if the panel is open — otherwise it's wasted work.
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
```

- [ ] **Step 2: Verify — countdown ticks down**

Reload. Force coins and buy a buff (or use direct DB write):

```js
db.ref('users/' + currentUser.uid + '/shop/buffs/coins/expiresAt').set(Date.now() + 60000);
```

Open the shop panel. The `×2 coins` row shows `0:59 left` and tick down: `0:58 → 0:57 → …`. When it reaches `0:00`, the timer fires and the row reverts to `×2 for 60s` (inactive).

- [ ] **Step 3: Verify — tab-close resume**

Buy another buff:

```js
db.ref('users/' + currentUser.uid + '/shop/buffs/coins/expiresAt').set(Date.now() + 60000);
```

Close the tab. Wait 10 sec. Reopen the page (same browser, same anon UID via Firebase Auth persistence). Open shop. Countdown should show approximately `0:49 left` and continue ticking.

- [ ] **Step 4: Verify — `autoRate` buff expiry re-arms auto loop**

```js
db.ref('users/' + currentUser.uid + '/shop/autoLevel').set(5);
db.ref('users/' + currentUser.uid + '/shop/buffs/autoRate/expiresAt').set(Date.now() + 5000); // 5 sec
```

The cursor should poke at ~10 cps (5 base × 2 buff). After 5 sec, the buff expires, `rearmAutoLoop` fires, and the cursor slows to 5 cps.

- [ ] **Step 5: Clean up**

```js
db.ref('users/' + currentUser.uid + '/shop').remove();
db.ref('users/' + currentUser.uid + '/stats').remove();
```

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Shop: buff countdown rendering + per-buff expiry timers"
```

---

## Task 11: i18n strings for all 7 locales

**Files:**
- Modify: `index.html` (translation table inside `const I18N = (() => { ... })()` around lines 1804–2110)

This adds the same set of keys to all 7 locale objects (`en`, `ja`, `ko`, `zh-Hans`, `zh-Hant`, `th`, `ar`). The English values are authoritative; localizations are best-effort.

- [ ] **Step 1: Add English keys**

Find the `en:` block (around line 1805). Find the line ending with:

```js
          'leaderboard.no_rank_yet':'Click to start climbing the board!',
```

Insert below it (before `'settings.admin_mode':` if you can find that anchor):

```js
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
```

- [ ] **Step 2: Add Japanese keys**

Find the `ja:` block. Find `'leaderboard.no_rank_yet':'クリックしてランキングを駆け上がろう!',` and insert below it:

```js
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
```

- [ ] **Step 3: Add Korean keys**

Find the `ko:` block. After `'leaderboard.no_rank_yet':'클릭해서 순위를 올려보세요!',`:

```js
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
```

- [ ] **Step 4: Add Simplified Chinese keys**

Find the `'zh-Hans':` block. After `'leaderboard.no_rank_yet':'点击开始攀登排行榜!',`:

```js
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
```

- [ ] **Step 5: Add Traditional Chinese keys**

Find the `'zh-Hant':` block. After `'leaderboard.no_rank_yet':'點擊開始攀登排行榜!',`:

```js
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
```

- [ ] **Step 6: Add Thai keys**

Find the `th:` block. After `'leaderboard.sign_in_cta':'เข้าสู่ระบบเพื่อร่วมกระดานผู้นำ →',` (or the next available `leaderboard.no_rank_yet` line — search the th block for that key):

```js
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
```

- [ ] **Step 7: Add Arabic keys**

Find the `ar:` block (after the `th:` block in the file). Add the same set of keys at the equivalent position:

```js
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
```

- [ ] **Step 8: Verify**

Reload. Open the shop panel — `Shop` / `Permanent` / `Auto` / `Buffs (60s)` should appear in English. Switch language to Japanese via Settings → Language → 日本語. Reopen shop. `ショップ` / `永続` / `オート` / `バフ (60秒)`. Cycle through Korean, Simplified, Traditional, Thai, Arabic — each should localize.

- [ ] **Step 9: Commit**

```bash
git add index.html
git commit -m "Shop: i18n strings for all 7 locales"
```

---

## Task 12: Wire `applySettings` so Reset Defaults doesn't touch shop state

**Files:**
- Modify: `index.html` (`applySettings` and reset handler around line 2341–2362)

Since shop state is server-side (under `users/{uid}/shop/`) and settings are client-side localStorage, Reset Defaults already doesn't touch shop state. This task confirms by verifying.

- [ ] **Step 1: Verify**

Force-set shop state:

```js
db.ref('users/' + currentUser.uid + '/shop/coinMulLevel').set(3);
db.ref('users/' + currentUser.uid + '/stats/coinBalance').set(5000);
```

Open Settings → Reset Defaults. Confirm the dialog. Shop should still show Coin Multiplier at Lv3, coinBalance still 5000. Pass.

If for any reason the reset does wipe shop, that's a bug — but the existing code only writes to localStorage in `saveSettings`, so this should pass without modification.

- [ ] **Step 2: Clean up**

```js
db.ref('users/' + currentUser.uid + '/shop').remove();
db.ref('users/' + currentUser.uid + '/stats').remove();
```

- [ ] **Step 3: No commit needed (verification-only task)**

---

## Task 13: Deploy Firebase rules and run final end-to-end test

**Files:**
- No edits — deploy and verify only.

- [ ] **Step 1: Deploy database rules**

```bash
firebase deploy --only database
```

Expected: `✔  Deploy complete!`

If you get an authentication error, run `firebase login` first.

- [ ] **Step 2: End-to-end test (full happy path)**

Reload the page. Use a fresh anonymous UID (DevTools → Application → Local Storage → clear `aobing-pending-clicks` and the Firebase Auth user; then reload). Run through this checklist:

1. Click curtain to start. Mouse-click 200 times. Sensei bar: `coins = 200`, `clicks = 200`.
2. Open shop. Buy Coin Multiplier (-100). Balance: 100. Row shows `Lv 1 → Lv 2  💰 200`.
3. Buy Coin Multiplier again (-200). Wait — balance is 100, not enough. Row should be dimmed.
4. Click character 100 more times. Now balance = 100 + 100 × 1.5 = 250. Buy Coin Mul Lv2. Balance: 50.
5. Click 50 more times: coins = 50 + 50 × 2 = 150. Buy Click Mul Lv1 (-100). Balance: 50. Now `clicks` jumps by 1.5 per mouse click (rounded down to 1) and `coins` by 2.
6. Force balance to 500 via DevTools. Buy ×2 coins buff. Row shows `0:59 left`. Click 10 times: coins = 0 + 10 × 4 = 40 (×2 coin mul × ×2 buff).
7. Force balance to 200. Buy Auto-Clicker Lv1. Cursor appears on right. Watch sensei bar `coins` tick up by 2 per tick (×2 coin mul × 1 auto coin) every 2 sec. `clicks` does NOT change.
8. Force balance to 50000. Buy Leaderboard Auto. Owned. Auto-ticks now also add to `clicks` (rounded down from ×1.5 = 1 per tick).
9. Open Leaderboard. AFK 30 sec. Rank should drift up.
10. Close tab. Reopen 10 sec later. Buff timer shows ~`0:20 left`. Auto-clicker resumes immediately.
11. Wait for buff to expire. Coin gain returns to ×2 (just the permanent), auto-rate returns to 1 cps.
12. Settings → Reset Defaults. Shop state preserved. Anon UID preserved. Sensei bar shows the totals.
13. Sign in with Google (if you have a test account). Shop state carries over with the UID. Leaderboard row mirrors with the new profile name.

- [ ] **Step 3: Commit (deployment confirmation)**

If the deploy succeeded without code changes, no commit is needed. If `firebase deploy` left any tracked files modified (e.g. `firebase-debug.log`), `git status` to verify, and skip committing those.

- [ ] **Step 4: Tag the rollout**

Optional but recommended:

```bash
git tag shop-v1.0
```

---

## Self-Review

After writing the plan, I walked through it against the spec.

**Spec coverage check:**
- Data model (users/{uid}/shop/*) — Task 1 (rules) + Task 3 (subscribe) + Task 4 (helpers)
- Pricing curves — Task 4 (`shopCostFor`)
- Coin/click multiplier per mouse click — Task 8
- Auto-clicker visual + scheduling + intro suppression — Task 9
- Per-auto-tick accounting (coin always, click only if lbAuto) — Task 8 (`recordClick` auto branch)
- Buff purchase via transaction with 60s extend — Task 7 (`buyBuff`)
- Buff stacking (different-type parallel, same-type extend) — `buyBuff` transaction reads existing and adds 60s
- Buff countdown render + expiry timers — Task 10
- Wall-clock buff semantics + tab-resume — Task 10 (`syncBuffTimers` + visibilitychange in Task 9)
- Shop panel UI + sections — Task 5 + Task 6
- Buy handlers + optimistic debit — Task 7
- Anti-double-click guard — Task 7 (Step 1 `setAttribute('aria-disabled')`)
- Error toast — Task 7 (`shopShowError`) + Task 5 CSS (`.flash-error`)
- i18n (7 locales) — Task 11
- Firebase rules: +10000 caps + new shop subtree — Task 1
- Batcher refactor (split userCoins/userClicks + sign-aware release) — Task 2
- Migration in loadPending — Task 2 Step 3
- lastClickAt only on click activity — Task 2 Step 7
- Reset Defaults doesn't wipe shop — Task 12

All spec sections mapped. Edge cases from the spec are exercised in Task 13 Step 2 (resume after tab close, two-tab concurrency, sign in, leaderboard auto). Two-tab concurrency isn't explicitly tested but the rule + rollback combination handles it.

**Placeholder scan:** No "TBD", "TODO", "similar to" references, or hand-waved error handling. Each step has the exact code or command.

**Type consistency:** Function names verified:
- `shopMul`, `shopFieldFor`, `shopCostFor`, `shopEffectFor`, `shopAffordableCoins`, `shopFormatNum`, `shopFormatTimeLeft`, `shopShowError` — consistent across tasks
- `renderShopPanel`, `buyLeveled`, `buyOneShot`, `buyBuff`, `rearmAutoLoop`, `autoTick`, `pokeAutoCursor`, `currentAutoCps`, `syncBuffTimers`, `anyBuffActive` — consistent
- State vars: `userShop`, `userShopUnsub`, `pending.userCoins`, `pending.userClicks`, `inFlightUserCoins`, `inFlightUserClicks`, `autoTimer`, `buffExpiryTimers`, `buffCountdownInterval` — consistent

Constants (`SHOP_MAX_LEVEL`, `SHOP_BUFF_COST`, `SHOP_BUFF_DURATION_MS`, `SHOP_LBAUTO_COST`, `AUTO_PERIOD_MS_FLOOR`) — defined in Task 4, referenced in Tasks 6/7/9.

No mismatches found.
