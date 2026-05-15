---
name: miyu-character
description: Add Miyu as a third character with two variants (Default + Swimsuit) and introduce an optional `active2` sprite slot on any variant that swaps in while combo ≥ 20.
status: backlog
created: 2026-05-15T08:36:28Z
updated: 2026-05-15T08:36:28Z
---

# Miyu Character + Combo-Tier Sprite

## Goal

Add **Miyu** as a third character to the existing two-level character → variant registry, with two variants:

- Miyu (Default)
- Miyu (Swimsuit)

At the same time, introduce an **optional `active2` sprite slot** that any variant can declare. When set, the click handler uses `active2` instead of `active` whenever `comboCount >= 20`. Both Miyu variants declare an `active2` sprite; other characters can opt in later with no code change.

## Scope

- `index.html` only — add Miyu to `CHARACTERS`, add `resolveActiveSrc` helper, swap two call sites, extend preload, add `COMBO_TIER_THRESHOLD` constant.
- `assets/` — six new Miyu sprite files.

No changes to: Firebase rules, stats schema, skins-panel rendering code, idle-bubble system, audio/BGM logic.

## Non-Goals

- Per-variant threshold override. Threshold is a single module-level constant. Easy to lift to per-variant later.
- A visual cue (flash, glow, particle burst) when crossing combo 20. Just a snappy sprite swap on the crossing click.
- Audio or background for Miyu. Both fields are empty strings; the existing silent-character path handles it (matches how Mari shipped initially).
- Resetting the combo on variant change. Existing behavior unchanged: combo counter persists across variant switches.

---

## Data Model

### New variant field

```js
{
  id: 'miyu',
  name: 'Miyu',
  tag: 'Default',
  idle:    'assets/miyu-idle.png',
  active:  'assets/miyu-active.png',
  active2: 'assets/miyu-active2.png',  // NEW — optional
}
```

Semantics:

- **`active2`** — optional string. Path to a sprite shown on click when `comboCount >= COMBO_TIER_THRESHOLD`. If absent or empty string, the variant behaves exactly as today: `active` is used for every click.

### New module-level constant

```js
const COMBO_TIER_THRESHOLD = 20;
```

Placed in the same script block, near `COMBO_CAP_TIER` and the combo state variables (around `index.html:4933`).

### New `CHARACTERS` entry

Appended to the existing `CHARACTERS` array (after the Mari entry, around `index.html:1964`):

```js
{
  id: 'miyu',
  name: 'Miyu',
  sfx: [],          // silent for now
  bgm: '',          // silent for now
  bg:  '',          // body falls back to its solid color
  idleTexts: ['hi'],
  variants: [
    { id: 'miyu',     name: 'Miyu',          tag: 'Default',  idle: 'assets/miyu-idle.png',     active: 'assets/miyu-active.png',     active2: 'assets/miyu-active2.png' },
    { id: 'miyuswim', name: 'Miyu Swimsuit', tag: 'Swimsuit', idle: 'assets/miyuswim-idle.png', active: 'assets/miyuswim-active.png', active2: 'assets/miyuswim-active2.png' },
  ],
},
```

Empty `sfx`/`bgm`/`bg` triggers the already-implemented "silent character" path:

- `playsfx()` early-returns on empty pool — no click sound.
- `bgm` source clears — no music.
- Body `background-image` set to `'none'` — falls back to the body's `#1a1a2e` color.
- `goIdle()` is driven by the bounce-animation `onComplete` rather than the SFX `ended` event, so idle return still works.

---

## Click-Handler Sprite Swap

### New resolver

Add near the existing combo state (immediately after `COMBO_TIER_THRESHOLD`):

```js
function resolveActiveSrc(variant) {
  if (variant.active2 && comboCount >= COMBO_TIER_THRESHOLD) return variant.active2;
  return variant.active;
}
```

### Call sites

Two existing lines do `aobaImg.src = v.active`. Replace both with `aobaImg.src = resolveActiveSrc(v);`.

1. **Intro-end first click** (`index.html:4838`):
   ```js
   aobaImg.src = v.active;     // → resolveActiveSrc(v)
   ```
2. **`triggerClick` post-intro path** (`index.html:4884`):
   ```js
   aobaImg.src = v.active;     // → resolveActiveSrc(v)
   ```

### Timing

`bumpCombo()` runs **before** the sprite assignment on both sites (see `index.html:4836` and `:4881`). So the click that increments `comboCount` from 19 → 20 is the first click that resolves to `active2`. This matches "while comboCount ≥ 20 in current run".

When `expireCombo()` fires (`index.html:4966`), it sets `comboCount = 0`. The next click runs `bumpCombo()` → `comboCount` becomes 1 → `resolveActiveSrc` returns plain `active`. No extra reset code needed for the sprite.

### Idle return

`goIdle()` swaps the sprite back to `variant.idle`. `active2` is only ever the in-bounce sprite, never the resting state. So between clicks the character looks normal; the "powered-up" expression appears only on each click after combo crosses 20.

---

## Preloading

Today `applyVariant` does (`index.html:2710-2714`):

```js
aobaImg.src = variant.idle;
const preload = new Image();
preload.src = variant.active;
```

Extend with a sibling preload for `active2` when present:

```js
aobaImg.src = variant.idle;
const preload = new Image();
preload.src = variant.active;
if (variant.active2) {
  const preload2 = new Image();
  preload2.src = variant.active2;
}
```

Asset is in the browser cache well before the user can stack 20 clicks. No flash-of-broken-image on the crossing click.

---

## UI: Skins Panel

No code change. `renderSkinList` already walks `CHARACTERS` and emits one collapsible group per character. Adding Miyu produces a new "Miyu" group with two tiles ("Miyu" tagged `Default`, "Miyu Swimsuit" tagged `Swimsuit`). The header meta-text rule from the existing `character-variant-skins` spec handles `"2 variants"` for the inactive Miyu group; if a Miyu variant is the active selection, the meta shows that variant's tag.

Default behavior on render: only the group containing the active variant is open; others closed. Selecting a Miyu variant from the panel opens the Miyu group.

---

## Stats Schema

No change. Each click writes:

- `daily/{date}/skins/{variantId}` — new IDs `miyu` and `miyuswim` accumulate under the existing rule.
- `daily/{date}/characters/{characterId}` — new ID `miyu` accumulates under the existing rule.

Both write paths already exist with `.write` rules in `database.rules.json`. No rules update.

The analytics doughnut chart for skins keeps reading `day.skins` and will include `miyu`/`miyuswim` slices automatically once data exists.

---

## Sprite Acquisition

Six files, all downloaded from `static.wikia.nocookie.net/blue-archive/` and saved into `assets/`. Convention matches the existing Mari spec: `Expression_1` = idle, `Expression_9` = active (onclick), `Expression_10` = active2 (onclick after combo 20). URLs use `/revision/latest` for the original resolution (no `scale-to-width-down`).

| Variant         | Slot     | Filename                     | Source URL |
|-----------------|----------|------------------------------|------------|
| Miyu            | idle     | `assets/miyu-idle.png`       | `https://static.wikia.nocookie.net/blue-archive/images/c/c5/Miyu_Portrait_Expression_1.png/revision/latest` |
| Miyu            | active   | `assets/miyu-active.png`     | `https://static.wikia.nocookie.net/blue-archive/images/7/7c/Miyu_Portrait_Expression_9.png/revision/latest` |
| Miyu            | active2  | `assets/miyu-active2.png`    | `https://static.wikia.nocookie.net/blue-archive/images/4/4a/Miyu_Portrait_Expression_10.png/revision/latest` |
| Miyu Swimsuit   | idle     | `assets/miyuswim-idle.png`   | `https://static.wikia.nocookie.net/blue-archive/images/d/d7/Miyu_Swimsuit_Portrait_Expression_1.png/revision/latest` |
| Miyu Swimsuit   | active   | `assets/miyuswim-active.png` | `https://static.wikia.nocookie.net/blue-archive/images/d/de/Miyu_Swimsuit_Portrait_Expression_9.png/revision/latest` |
| Miyu Swimsuit   | active2  | `assets/miyuswim-active2.png` | derive at download time — see below |

### Resolving the Swimsuit Expression_10 URL

The user-provided source for Swimsuit Expression_10 was the gallery page (`https://bluearchive.fandom.com/wiki/Kasumizawa_Miyu_(Swimsuit_ver.)/Gallery?file=Miyu_Swimsuit_Portrait_Expression_10.png`), not the direct CDN URL. The CDN path uses a two-segment hash prefix derived from `MD5(filename)`:

1. Compute `MD5("Miyu_Swimsuit_Portrait_Expression_10.png")`.
2. Build URL: `https://static.wikia.nocookie.net/blue-archive/images/{hash[0]}/{hash[0:2]}/Miyu_Swimsuit_Portrait_Expression_10.png/revision/latest`.
3. HEAD-check for `200 OK`.
4. If the HEAD fails, fall back to fetching the gallery page HTML and extracting the direct `src` from the `<img>` element. The existing `character-variant-skins` spec confirmed the MD5 trick works for Idol Mari's idle URL.

---

## Backward Compatibility

- **localStorage** `settings.skin` — existing IDs (`aoba`, `aobaplush`, `mari`, `maritrack`, `mariidol`) keep resolving. New IDs (`miyu`, `miyuswim`) become valid additions.
- **Firebase** — no rule changes; new variant/character IDs flow into existing paths.
- **Settings reset** — `DEFAULT_SETTINGS.skin` stays `'aoba'`. Unchanged.

No data migration.

---

## Edge Cases & Decisions

- **Combo crosses 20 from auto-click vs mouse vs keyboard**: All three funnel through `triggerClick`. Sprite resolution is identical regardless of source. Auto-clicks during a combo run still flip the sprite to `active2` at threshold.
- **Variant change mid-run while combo ≥ 20**: `applyVariant` does not touch `comboCount`. The next click on the new variant resolves to `active2` if the new variant has one, else plain `active`. Switching from Miyu to Aoba mid-run silently downgrades the sprite back to Aoba's plain `active`. Switching Miyu → Miyu Swimsuit mid-run keeps the powered-up state visible on Swimsuit's `active2`.
- **Variant has `active2` set to empty string**: Treated the same as absent. The `if (variant.active2 && ...)` guard in `resolveActiveSrc` handles both `undefined` and `""`.
- **First click on Miyu during intro-end**: The intro-end path also uses `resolveActiveSrc` (call site #1). `comboCount` is 0 → 1 at that point, so the first click shows plain `active`. Correct.
- **Combo expires while sprite is still showing active2**: The bounce animation's `onComplete` runs `goIdle()` which swaps to `idle`. The active2 sprite was only on screen for the duration of the bounce. No stale state.
- **Combo cap tier 5 at 100 clicks**: Irrelevant to `active2`. The tier system controls visual effects on the combo display; `active2` is a binary on/off on the character sprite based solely on `comboCount >= 20`.
- **Silent character + auto-click**: Existing silent-character behavior (`playsfx()` no-op, `goIdle()` triggered from bounce `onComplete`) applies. Auto-clicker still works fine; click is silent.

---

## Implementation Notes

- Code lives in the single script block at the bottom of `index.html`. Keep it there. No new files.
- The new constant, resolver, and `CHARACTERS` entry are independent edits — no naming collisions, no refactor of existing functions.
- Variant tile thumbnails in the skins panel use `variant.idle` (unchanged). Miyu tiles will show the idle sprite as their thumbnail.
- Total edit budget: ~15 lines added, 2 lines changed in `index.html`. Plus 6 new sprite files in `assets/`.

---

## Testing (manual)

The project has no automated test suite — single static HTML page. All checks against the running page.

1. **Selection flow**: Reload. Open skins panel. Expand the Miyu group. Tiles for "Miyu" and "Miyu Swimsuit" render with their idle sprites as thumbnails.
2. **Slow clicking on Miyu**: Switch to Miyu. Click once, wait for combo to expire, click again, etc. Sprite alternates between `miyu-idle.png` (rest) and `miyu-active.png` (during bounce) only. Never shows `active2`.
3. **Crossing combo 20**: On Miyu, click rapidly past 20. The 20th click swaps the in-bounce sprite to `miyu-active2.png`. Clicks 21+ continue using `miyu-active2.png`. Idle state between rapid clicks is still `miyu-idle.png`.
4. **Combo expiry resets sprite**: After a 30+ click run, stop clicking. After combo expires (a few seconds), click once. Sprite is back on `miyu-active.png`.
5. **Variant switch mid-run, Miyu → Miyu Swimsuit (≥ 20)**: Build combo to 25 on Miyu, switch to Swimsuit. Next click shows `miyuswim-active2.png`.
6. **Variant switch mid-run, Miyu → Aoba (≥ 20)**: Build combo to 25 on Miyu, switch to Aoba. Next click shows `aoba-active.webp` (Aoba has no `active2`).
7. **Variant switch mid-run, Aoba → Miyu (≥ 20)**: Build combo to 25 on Aoba, switch to Miyu. Next click shows `miyu-active2.png` (combo state persisted across switch).
8. **Silent Miyu**: On Miyu, clicking produces no sound. BGM is paused (or never started). Body background is the dark `#1a1a2e` color (no `bg.png`).
9. **Auto-click → active2**: Buy an auto-clicker in the shop, set a high rate. Watch the combo count climb. When `comboCount` hits 20, sprite swaps to `active2` on auto-click bounce. Confirms auto-click flows through `triggerClick` → `resolveActiveSrc`.
10. **Network/preload**: Open DevTools Network tab. Select Miyu. Confirm three files fetched: `miyu-idle.png`, `miyu-active.png`, `miyu-active2.png`. Repeat for Miyu Swimsuit.
11. **Persistence**: Set `localStorage.aobing-settings.skin = 'miyuswim'` manually and reload. Page loads with Miyu group expanded, Swimsuit tile active, sprite is `miyuswim-idle.png`, body background falls back to solid color.
12. **Firebase writes**: After a Miyu click session, inspect Firebase: `daily/{today}/skins/miyu` and `daily/{today}/characters/miyu` (and `.../skins/miyuswim` if Swimsuit was used) have non-zero counts.
13. **Analytics chart**: Open the analytics modal after step 12. The Skins doughnut chart includes Miyu/Miyu Swimsuit slices.
14. **Backward compatibility**: Confirm Aoba and Mari behavior is unchanged — no `active2`, sprite swap on click is identical to before.
