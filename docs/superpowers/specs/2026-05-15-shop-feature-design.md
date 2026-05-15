---
name: shop-feature
description: Cookie-Clicker-style coin shop with separate permanent coin/click multipliers, a leveled auto-clicker with a side cursor animation, a one-shot leaderboard-auto unlock, and three stackable 60-second buffs.
status: backlog
created: 2026-05-15T05:42:34Z
updated: 2026-05-15T05:42:34Z
---

# Shop Feature

## Goal

Add a Cookie-Clicker-style shop where coins (already earned 1:1 with mouse clicks today) buy:

- **Permanent coin-per-click multiplier** — increases coin gain per mouse click; cosmetic to leaderboard.
- **Permanent click-per-click multiplier** — increases `totalClicks` gain per mouse click; lets the leaderboard be climbed by spending.
- **Auto-clicker** — leveled item that fires periodic auto-ticks with a side cursor animation poking the character. No SFX, no sprite swap, no bounce.
- **Leaderboard Auto** — one-shot unlock that lets auto-ticks contribute to `totalClicks` (subject to click multiplier). Until unlocked, auto-ticks produce coins only.
- **Three 60-second buffs** — ×2 coins / ×2 clicks / ×2 auto-rate. Same-type re-buy extends the timer. Different types stack in parallel.

## Scope

- `index.html` — new panel button, new panel markup, new script block for shop state/handlers, accounting changes in `recordClick`, batcher field rename.
- `database.rules.json` — raise per-write increment caps on `totalClicks` / `coinBalance`; new `users/{uid}/shop/*` subtree.
- No new asset files (cursor icon is inline SVG).

## Out of scope

- Decoration / cosmetic-only items (the panel reserves space for a future `Decorations` section, but no items ship in this PR).
- Random buff drops (golden cookie style).
- Achievement / quest systems.
- Refunding upgrades.
- Server-side payment verification — keeping the static-only constraint. See Anti-cheat below.

---

## Data Model

```
users/{uid}/
  shop/
    coinMulLevel             int    0..20  permanent coin-per-click multiplier level
    clickMulLevel            int    0..20  permanent click-per-click multiplier level
    autoLevel                int    0..20  auto-clicker level (0 = off)
    leaderboardAutoUnlocked  bool          one-shot, default false
    buffs/
      coins/    expiresAt    int           ms since epoch, server-stamped; 0/missing = inactive
      clicks/   expiresAt    int
      autoRate/ expiresAt    int
```

`coinBalance` and `totalClicks` stay where they are under `users/{uid}/stats/`. No new top-level paths.

`users/{uid}/decor/*` is **reserved** for the future cosmetics shop. Not written in this PR; rules leave it absent so a follow-up adds keys only.

### Access

Path is gated by the existing `users/{uid}` rule (`auth != null && auth.uid === $uid`). Anonymous users get full shop access. Clearing browser storage = losing the anon UID = losing shop state, identical to today's "I cleared cookies and lost my progress" case.

---

## Pricing & Multiplier Composition

### Cost curves

| Item | Level range | Cost at level L (to buy L+1) | Effect at level L |
|---|---|---|---|
| Coin Multiplier   | 0 → 20    | `100 × 2^L`        | `coinMul = 1 + 0.5 × L`  (Lv0=×1, Lv20=×11) |
| Click Multiplier  | 0 → 20    | `100 × 2^L`        | `clickMul = 1 + 0.5 × L` (Lv0=×1, Lv20=×11) |
| Auto-Clicker      | 0 → 20    | `200 × 1.6^L`      | `cps = 0.5 × L`          (Lv0=off, Lv20=10/s base) |
| Leaderboard Auto  | one-shot  | `50000`            | unlocks auto → totalClicks |
| Buff ×2 coins     | per-buy   | `500`              | 60s of ×2 coin gain |
| Buff ×2 clicks    | per-buy   | `500`              | 60s of ×2 click gain |
| Buff ×2 auto-rate | per-buy   | `500`              | 60s of ×2 auto cps |

Coin/Click Mul double every level: Lv0→1 = 100, Lv9→10 = 51,200, Lv19→20 ≈ 52M. Long grind, but first five levels are cheap. Auto-Clicker grows at 1.6× so it stays buyable in parallel with the multiplier track.

### Live multipliers (recomputed each click and each auto-tick)

```js
function shopMul(now) {
  const s = userShop;                                  // last seen from RTDB listener
  const b = s.buffs || {};
  const active = (key) => (b[key]?.expiresAt || 0) > now;
  return {
    coin:     (1 + 0.5 * (s.coinMulLevel  || 0)) * (active('coins')    ? 2 : 1),
    click:    (1 + 0.5 * (s.clickMulLevel || 0)) * (active('clicks')   ? 2 : 1),
    autoCps:  0.5 * (s.autoLevel || 0)           * (active('autoRate') ? 2 : 1),
    lbAuto:   !!s.leaderboardAutoUnlocked,
  };
}
```

### Per-mouse-click accounting

Replaces the current 1:1 `pending.user += 1` line:

```js
const m = shopMul(Date.now());
pending.userCoins  += Math.floor(m.coin);
pending.userClicks += Math.floor(m.click);
pending.global     += Math.floor(m.click);
pending.daily      += Math.floor(m.click);
// byCountry / bySkin / byCharacter / bySource['mouse'] / userBySource['mouse'] / allTimeSkin
// all bump by Math.floor(m.click) — same semantic as today, just scaled.
```

### Per-auto-tick accounting

```js
const m = shopMul(Date.now());
pending.userCoins += Math.floor(m.coin);
if (m.lbAuto) {
  pending.userClicks += Math.floor(m.click);
  pending.global     += Math.floor(m.click);
  pending.daily      += Math.floor(m.click);
  // bySource['auto'] / userBySource['auto'] bump by Math.floor(m.click).
}
// If lbAuto NOT unlocked: auto produces coins only. No bumps to totalClicks, global, daily, or bySource.
```

### Keyboard clicks

**Unchanged.** Keyboard input was explicitly excluded from leaderboard and coin economy in the prior auth-and-leaderboard spec. The shop doesn't change that. Keyboard clicks still contribute to global counters only, never to `userCoins` or `userClicks`.

---

## Auto-Clicker

### Visual

A small cursor SVG (inline pointer/hand icon, no new asset) anchored to the right edge of `#character`:

```html
<div id="character">
  <button id="idle-bubble" type="button" hidden> … </button>
  <div id="auto-cursor" hidden aria-hidden="true">
    <svg viewBox="0 0 24 24"> <!-- pointer icon path --> </svg>
  </div>
  <img id="aoba-img" … >
</div>
```

`#auto-cursor` is `position: absolute`, right-anchored just outside the sprite's shoulder, z-index above the character image. `hidden` while `autoLevel === 0`.

Poke animation: CSS keyframes triggered by toggling `data-poking="true"` for ~300ms:
- 0–100ms: translateX from `0` to `-40px` (slides toward the character)
- 100–300ms: translateX back to `0`

No bounce, no SFX, no sprite swap on the character — the cursor is the only feedback.

### Tick loop

A single `setInterval` re-armed whenever `autoCps` changes:

```js
let autoTimer = null;
function rearmAutoLoop() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  const cps = currentAutoCps();
  document.getElementById('auto-cursor').hidden = (cps === 0);
  if (cps <= 0) return;
  const periodMs = Math.max(80, 1000 / cps);   // hard floor at 80ms even if future tuning raises cps
  autoTimer = setInterval(autoTick, periodMs);
}

function autoTick() {
  if (introActive) return;
  recordAutoEarning();   // pending bumps per the "Per-auto-tick accounting" section
  pokeAutoCursor();      // toggle data-poking for 300ms
}
```

Re-arming triggers:
- `userShop` listener fires (level changed, buff timestamp changed).
- A buff expires (per-buff `setTimeout` calls `rearmAutoLoop()` + `renderShopPanel()`).
- `visibilitychange` → `visible` (buffs may have expired while hidden; recompute).

### Intro suppression

Auto-clicker is suppressed while `introActive === true`. `rearmAutoLoop()` is first invoked from `endIntro` (right after `scheduleIdleBubble()`), so the loop only starts after the curtain falls.

### Tab-hidden behavior

`setInterval` is browser-throttled to ~1 tick/sec in backgrounded tabs. We do not catch up missed ticks. Lossy by design — matches Cookie Clicker's no-offline-progress default and discourages running the tab in the background as a coin farm.

---

## Buffs

### Storage and purchase

Three slots under `users/{uid}/shop/buffs/{coins|clicks|autoRate}/expiresAt`. Each holds a single integer (ms since epoch). 0 or missing = inactive.

```js
async function buyBuff(kind) {                       // kind ∈ 'coins' | 'clicks' | 'autoRate'
  const cost = 500;
  const have = (userStats.coinBalance || 0) + pending.userCoins;
  if (have < cost) return showShopError(I18N.t('shop.error.notEnough'));

  const uid = currentUser.uid;
  const buffRef = db.ref(`users/${uid}/shop/buffs/${kind}/expiresAt`);
  await buffRef.transaction(current => {
    const baseFloor = Date.now();                    // client clock; server-side cap enforces sanity
    const base = (typeof current === 'number' && current > baseFloor) ? current : baseFloor;
    return base + 60_000;                            // extend or fresh-start
  });
  pending.userCoins -= cost;                         // optimistic debit
  scheduleFlush();
  renderSenseiBar(); renderShopPanel();
}
```

The transaction reads the server-side value via Firebase's optimistic-concurrency retry — safe across concurrent tabs. The base time uses `Date.now()` (client clock); the `expiresAt <= now + 3600000` rule (where `now` is server time) is what bounds attacker abuse to ≤1h regardless of client-clock manipulation. Honest clock skew of a few seconds is invisible to the user.

### Stacking rule

Same-type re-buy extends the current expiry by 60s. Different types run in parallel: ×2 coins + ×2 clicks both apply for the overlap window. Stacks are **not** multiplicative within a type — re-buying coins doesn't make it ×4.

### Wall-clock semantics

Closing the tab consumes the buff. Reopening with `expiresAt` in the past = inactive. No paused-while-away behavior.

### Client expiry timers

```js
const buffExpiryTimers = { coins: null, clicks: null, autoRate: null };

function syncBuffTimers() {
  for (const kind of ['coins','clicks','autoRate']) {
    if (buffExpiryTimers[kind]) { clearTimeout(buffExpiryTimers[kind]); buffExpiryTimers[kind] = null; }
    const exp = userShop?.buffs?.[kind]?.expiresAt || 0;
    if (exp > Date.now()) {
      buffExpiryTimers[kind] = setTimeout(() => {
        rearmAutoLoop();      // autoCps may change when 'autoRate' expires
        renderShopPanel();    // refresh countdown labels
      }, exp - Date.now() + 50);
    }
  }
}
```

Called from the `userShop` listener and from `visibilitychange` → `visible`.

### Countdown rendering

While any buff is active, a 1s `setInterval` re-renders the buff section labels (no full panel rebuild). The interval clears when all three buffs go inactive.

### Clock skew

We trust the server `expiresAt` value and compare against local `Date.now()`. Drift up to a few seconds is invisible; larger drift is a user-environment issue we don't try to repair.

---

## Shop Panel UI

### Trigger button

New `#shop-btn` in the top-right panel-btn stack, between Skins and Leaderboard. SVG cart icon inline. Same `<button class="panel-btn">` markup as siblings.

### Panel markup

`#shop-panel` mirrors `#skins-panel` positioning, fade, and dismiss-on-outside-click. Three static sections — no tabs in v1 (we have 5 functional rows; expansion comes when decor lands):

```html
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

### Row layout

Each `.shop-item` is a clickable button with two text lines:

```
Coin Multiplier            Lv 3 → Lv 4    💰 800
×1 per click → ×2.5
```

- Top line: name (left), level transition or status (middle), cost (right).
- Sub-line: current → next effect description.
- Buff rows replace the level line with countdown when active: `×2 coins • 0:43 left`. Cost line remains clickable to extend.

Disabled state (`aria-disabled="true"`, dimmed) when:
- `coinBalance + pending.userCoins < cost`
- level at cap (Lv20)
- one-shot already owned (Leaderboard Auto)

### Render

`renderShopPanel()` rewrites the panel innerHTML, mirroring `renderSkinList`. Triggers:
- Panel open.
- `userShop` listener fires (purchase confirmed by server).
- `userStats.coinBalance` listener fires (affordability changed).
- 1s interval while any buff is active (countdown label refresh).

### Purchase handler

Single delegated click listener on `#shop-panel`:

```js
shopPanel.addEventListener('click', (e) => {
  const item = e.target.closest('.shop-item');
  if (!item || item.getAttribute('aria-disabled') === 'true') return;
  const which = item.dataset.item;
  if (which === 'coinMul' || which === 'clickMul' || which === 'autoLevel') return buyLeveled(which);
  if (which === 'leaderboardAuto') return buyOneShot();
  if (which.startsWith('buff'))    return buyBuff(which.replace('buff','').toLowerCase());
});

async function buyLeveled(which) {
  const field = fieldFor(which);                     // 'coinMulLevel' | 'clickMulLevel' | 'autoLevel'
  const level = userShop[field] || 0;
  if (level >= 20) return;
  const cost = costFor(which, level);
  const have = (userStats.coinBalance || 0) + pending.userCoins;
  if (have < cost) return showShopError(I18N.t('shop.error.notEnough'));
  pending.userCoins -= cost;
  scheduleFlush();
  // Direct .set() — levels are monotonic and the prior-level read locks pricing.
  await db.ref(`users/${currentUser.uid}/shop/${field}`).set(level + 1);
  renderShopPanel(); renderSenseiBar();
}
```

To dampen rapid double-clicks: after a buy, set `aria-disabled="true"` on the row for 500ms or until the listener re-fires, whichever first.

### Error display

`showShopError(msg)` toasts the row with a 1.5s red flash + inline tooltip. No modal interruption.

### i18n

New keys for all 7 locales:
`shop.title`, `shop.permanent`, `shop.auto`, `shop.buffs`,
`shop.item.coinMul.name`, `shop.item.coinMul.desc`,
`shop.item.clickMul.name`, `shop.item.clickMul.desc`,
`shop.item.autoLevel.name`, `shop.item.autoLevel.desc`,
`shop.item.leaderboardAuto.name`, `shop.item.leaderboardAuto.desc`,
`shop.item.buffCoins.name`, `shop.item.buffClicks.name`, `shop.item.buffAutoRate.name`,
`shop.error.notEnough`, `shop.atMax`, `shop.owned`,
`shop.timeLeft` (format `{m}:{ss}`).

---

## Firebase Rules Changes

### Raise per-write increment caps

Current rule caps `totalClicks` and `coinBalance` increments at `+150` per flush. With ×11 click multiplier + 30 cps mouse + 5s flush window, a legitimate burst reaches ~1,650; with auto-clicker and buffs, higher. Raise both caps to `+10000` per flush. The `now - lastClickAt >= 1000` throttle stays.

```json
"totalClicks": {
  ".validate": "newData.isNumber() && newData.val() >= (data.exists() ? data.val() : 0) + 1 && newData.val() <= (data.exists() ? data.val() : 0) + 10000 && now - (data.parent().child('lastClickAt').exists() ? data.parent().child('lastClickAt').val() : 0) >= 1000 && newData.parent().child('lastClickAt').val() === now"
},
"coinBalance": {
  ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= (data.exists() ? data.val() : 0) + 10000"
},
"bySource": {
  "$source": {
    ".validate": "newData.isNumber() && ($source === 'mouse' || $source === 'keyboard' || $source === 'auto') && newData.val() >= (data.exists() ? data.val() : 0) + 1 && newData.val() <= (data.exists() ? data.val() : 0) + 10000 && now - (data.parent().parent().child('lastClickAt').exists() ? data.parent().parent().child('lastClickAt').val() : 0) >= 1000 && newData.parent().parent().child('lastClickAt').val() === now"
  }
}
```

`coinBalance` keeps its `>= 0` floor (already in place), which is what allows shop debits to flow through `firebase.database.ServerValue.increment(negative)`.

### New `shop` subtree

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
}
```

Per-field `.validate` on the levels enforces range. The 1-hour cap on buff `expiresAt` prevents an attacker writing a 100-year buff. Legit purchases extend by 60s at a time, so `now + 3,600,000` is generous slack.

### Anti-cheat (accepted risk)

Levels and `leaderboardAutoUnlocked` are not server-verified to have been paid for. Closing that loophole requires Cloud Functions or a multi-path transaction that decrements coins and increments a level atomically — both outside the static-only constraint. A determined cheater can already mash the dev console to fabricate `coinBalance` under their own UID.

The exposed cheat surface for the leaderboard is bounded by:
- The `+10000` per-write cap on `totalClicks`.
- The `>= 1000ms` per-write throttle.

⇒ max sustained leaderboard inflation = 10,000 / sec / cheater. Same honor-system model the project already runs on. Documenting as accepted risk.

---

## Click Batcher Changes

### `pending` shape

```js
var pending = {
  userCoins: 0,        // NEW — replaces `user` for coins (can be negative for shop debits)
  userClicks: 0,       // NEW — replaces `user` for totalClicks (always >= 0)
  global: 0, daily: 0,
  byCountry: {}, bySkin: {}, byCharacter: {},
  allTimeSkin: {},
  bySource: {}, userBySource: {},
};
```

### `flushPending` user-update

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
    update[`users/${uid}/stats/bySource/${src}`] = firebase.database.ServerValue.increment(batch.userBySource[src]);
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

The error rollback path in the existing `catch` block restores all batch fields back into `pending`. With negative `userCoins` deltas, re-adding a negative number to `pending.userCoins` correctly restores the debt. Verified by inspection of existing code.

### Optimistic UI (sensei bar)

```js
const pendingCoins  = (typeof pending !== 'undefined' && pending) ? (pending.userCoins  || 0) : 0;
const pendingClicks = (typeof pending !== 'undefined' && pending) ? (pending.userClicks || 0) : 0;
const clicks = (userStats.totalClicks || 0) + pendingClicks + inFlightUserClicks;
const coins  = (userStats.coinBalance || 0) + pendingCoins  + inFlightUserCoins;
```

Two `inFlight*` counters replace the single `inFlightUser`. The release condition needs to be sign-aware because `inFlightUserCoins` can be negative (a purchase debit in flight):

```js
// In the users/{uid}/stats listener, after computing the delta:
const coinDelta = (next.coinBalance || 0) - (userStats.coinBalance || 0);
if (inFlightUserCoins !== 0
    && Math.sign(coinDelta) === Math.sign(inFlightUserCoins)
    && Math.abs(coinDelta) >= Math.abs(inFlightUserCoins)) {
  inFlightUserCoins = 0;
}
// inFlightUserClicks uses the existing positive-only pattern:
if (inFlightUserClicks > 0 && (next.totalClicks || 0) >= (userStats.totalClicks || 0) + inFlightUserClicks) {
  inFlightUserClicks = 0;
}
```

### localStorage recovery

`loadPending` reads the new keys. If the old `user` key is present (pre-shop tab), migrate one-time:

```js
if (typeof saved.user === 'number' && saved.user > 0) {
  pending.userCoins  += saved.user;
  pending.userClicks += saved.user;
}
```

then drop the `user` key on the next `savePending`.

### Leaderboard projection

`mirrorToLeaderboard` reads `userStats.totalClicks` already — no change. With click multiplier, `totalClicks` grows faster; the leaderboard becomes pay-to-climb. This is the user-chosen design.

---

## Edge Cases

- **Refresh during an active buff** — `userShop` listener fires, `syncBuffTimers` re-arms, `rearmAutoLoop` recomputes multipliers. No special-case code.
- **Two tabs spending coins** — both debit `pending.userCoins`; flushes serialize on the server. The `>= 0` rule rejects the flush that would land balance negative; the existing rollback path returns those deltas to `pending` (negative deltas restore the debt). The user sees the optimistic balance drop briefly then snap back to the correct value when the listener re-fires.
- **Buying offline** — `set()` queues until reconnect. Local UI updates optimistically. On reconnect, the server may reject (e.g., level cap exceeded by a parallel tab); the listener resyncs local state.
- **Auto-clicker firing during intro** — guarded by `if (introActive) return` at top of `autoTick`.
- **Double-clicked level buy** — second click writes the same `level + 1` (idempotent server-side) but locally debits twice. Mitigated by `aria-disabled` for 500ms post-buy.
- **Buff transaction conflict** — the buff `expiresAt` write is a `transaction()`, which retries on conflict. Safe.
- **Reset Defaults (in Settings)** — does **not** wipe shop state. Settings reset only writes localStorage `settings` keys.
- **Sign in with Google during ownership** — `linkWithPopup` preserves UID; shop state intact. Leaderboard projection re-mirrors with the new profile name.
- **Sign out from a linked account** — fresh anon UID, shop resets to zero. Old shop state stays under the old UID and is reachable on re-link.
- **Shop opened before `userShop` listener has fired** — `userShop` defaults to `{}` so all levels read as 0 and all costs read as base. Initial render is functional; first listener fire updates it.

---

## Testing (manual)

1. Fresh anon user, click 200 times → coinBalance 200, totalClicks 200. Open shop. Only Coin/Click Mul Lv1 affordable (100 each). Buy Coin Mul. Balance drops to 100, row updates to `Lv 1 → Lv 2  💰 200`, sensei coin pill matches.
2. Buy Coin Mul again. Balance 0. Next click yields +2 coins, +1 click.
3. Buy Click Mul Lv1 (after earning 100). Each mouse click now bumps coins ×2 and clicks ×2.
4. Buy Auto-Clicker Lv1. Cursor SVG appears at right edge, pokes character every 2s. Character does NOT bounce. NO SFX. Sensei coin pill ticks up. `totalClicks` does NOT increase.
5. Save 50,000 and buy Leaderboard Auto. Auto-ticks now bump `totalClicks`. Open Leaderboard modal and watch rank move while AFK.
6. Buy ×2 coins buff. Row shows `0:59 → 0:58 → …`. Next mouse click coin gain doubles on top of permanent mul.
7. Re-buy ×2 coins while active → countdown jumps to `1:59`. Balance debits another 500.
8. Buy ×2 auto-rate. Cursor poke interval halves visibly.
9. Close tab during a buff, reopen after 10s. Countdown shows correct remaining time.
10. Close tab during a buff, reopen after expiry. Buff inactive. Auto-rate back to base. No leftover timer.
11. Open two tabs, mash-buy Coin Mul in both. Final level is one or two ahead in one tab; balance settles correctly. No infinite-coin exploit.
12. Reach Coin Mul Lv20 → row dims, shows `MAX`. No further buys.
13. Disable network, click 20 times, buy Coin Mul. Pending grows, debit shows locally. Re-enable. Flush succeeds, balance reflects net.
14. Auto Lv20 + ×2 auto buff (10 cps) running 60s → ~600 auto-clicks. No rule rejections. Firebase shows `totalClicks` and `coinBalance` grew correctly.
15. Reset Defaults in Settings does **not** wipe shop state.
16. Sign in with Google during shop ownership. UID preserved, shop intact, leaderboard mirrors with the new profile name.
17. Sign out → fresh anon UID, shop resets to zero state.

No automated tests (project has none currently — single static HTML page).
