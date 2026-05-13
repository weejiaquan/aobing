---
name: character-variant-skins
description: Restructure the flat skins registry into a two-level character → variant hierarchy with per-character SFX, BGM, and background, plus a new Mari character with three variants.
status: backlog
created: 2026-05-13T00:00:00Z
updated: 2026-05-13T00:00:00Z
---

# Character / Variant Skins

## Goal

Replace the current flat `SKINS` registry with a two-level **character → variant** hierarchy so each character bundles a shared SFX, BGM, and background image, with variants able to override the BGM individually. Add **Mari** as a second character with three variants (Mari, Track Mari, Idol Mari) using sprites from `static.wikia.nocookie.net`.

## Scope

- `index.html` only — registry, panel rendering, skin-apply logic, asset preload, stats writes.
- `database.rules.json` — one new write rule path.
- `assets/` — six new Mari sprite files.

Out of scope: redesigning the analytics modal, adding a character switcher outside the skins panel, migrating existing Firebase data.

## Non-Goals

- Keeping unused fallbacks for Mari. If a Mari asset slot is blank, the corresponding behavior is **suppressed** (silent click, no BGM, solid-color body bg), not papered over with an Aoba asset.
- Per-variant SFX. SFX is character-level only.

---

## Data Model

Replace `const SKINS = [...]` with `const CHARACTERS = [...]`:

```js
const CHARACTERS = [
  {
    id: 'aoba',
    name: 'Aoba',
    sfx: 'assets/aobing.mp3',
    bgm: 'assets/bgm.mp3',
    bg:  'assets/bg.png',
    variants: [
      { id: 'aoba',      name: 'Aoba',       tag: 'Default', idle: 'assets/aoba-idle.webp',     active: 'assets/aoba-active.webp' },
      { id: 'aobaplush', name: 'Aoba Plush', tag: 'Plushie', idle: 'assets/aobaplush-idle.png', active: 'assets/aobaplush-active.png' },
    ],
  },
  {
    id: 'mari',
    name: 'Mari',
    sfx: '',  // populate later
    bgm: '',  // populate later
    bg:  '',  // populate later
    variants: [
      { id: 'mari',      name: 'Mari',       tag: 'Default', idle: 'assets/mari-idle.png',      active: 'assets/mari-active.png' },
      { id: 'maritrack', name: 'Track Mari', tag: 'Track',   idle: 'assets/maritrack-idle.png', active: 'assets/maritrack-active.png' },
      { id: 'mariidol',  name: 'Idol Mari',  tag: 'Idol',    idle: 'assets/mariidol-idle.png',  active: 'assets/mariidol-active.png' },
    ],
  },
];
```

### Field semantics

- **Character.sfx / bgm / bg** — strings. Empty string = suppressed.
- **Variant.bgm** (optional override) — if present and non-empty, takes precedence over character bgm for that variant. Not declared on any current variant; reserved so Track Mari / Idol Mari can hold their own song later without a code change.
- **Variant.id** — globally unique. Used for `settings.skin` and the existing `daily/{date}/skins/{variantId}` stats path.

### Lookup helpers (replace existing `getSkin`)

```js
function getVariant(variantId) {
  for (const c of CHARACTERS) {
    const v = c.variants.find(v => v.id === variantId);
    if (v) return { character: c, variant: v };
  }
  return { character: CHARACTERS[0], variant: CHARACTERS[0].variants[0] };
}
```

Used everywhere the old `getSkin(id)` was called. Returns both `character` (for sfx/bgm/bg) and `variant` (for idle/active sprites and name).

---

## UI: Skins Panel — Collapsible Groups

Replace the current flat tile list with character group headers that toggle open/closed.

### Markup (rendered into `#skin-list`)

```html
<div class="skin-group" data-character="aoba" data-open="true">
  <button class="skin-group-header" type="button">
    <span class="skin-group-caret">▼</span>
    <span class="skin-group-name">Aoba</span>
    <span class="skin-group-meta">Default</span>
  </button>
  <div class="skin-group-body">
    <div class="skin-item active" data-variant="aoba"> … </div>
    <div class="skin-item"       data-variant="aobaplush"> … </div>
  </div>
</div>
<div class="skin-group" data-character="mari" data-open="false">
  <button class="skin-group-header" type="button">
    <span class="skin-group-caret">▶</span>
    <span class="skin-group-name">Mari</span>
    <span class="skin-group-meta">3 variants</span>
  </button>
  <div class="skin-group-body" hidden>…</div>
</div>
```

### Header meta-text rule

- Character containing the currently-active variant → meta shows that variant's `tag` (e.g. "Default", "Plushie").
- Other characters → meta shows `"{count} variants"` (or `"1 variant"`).

### Interactions

- Click header → toggle `data-open` attribute; CSS shows/hides `.skin-group-body` and rotates caret (▶ ↔ ▼).
- Click variant tile → existing selection flow (see below).
- On panel render: character containing active variant is auto-opened, others closed.
- Re-render is full innerHTML rewrite (matches current `renderSkinList`). Group open state is derived from active variant, so the render rule is deterministic — no need to persist open state across renders.

### CSS additions (no rewrites)

- `.skin-group` — wrapper with bottom margin.
- `.skin-group-header` — flex row, transparent button, small uppercase name, dimmed meta text.
- `.skin-group-caret` — fixed-width, transitions transform when toggling.
- `.skin-group-body[hidden]` — collapsed (use `hidden` attribute, no animation).
- `.skin-group-body` — indented (~10px left padding) so variants visually nest under the header.

Existing `.skin-item`, `.skin-thumb`, `.skin-name`, `.skin-tag`, `.skin-item.active` are unchanged.

---

## Asset-Swap Behavior

When `applyVariant(variantId)` runs (replaces existing `applySkin`):

1. Resolve `{ character, variant } = getVariant(variantId)`.
2. **Sprite**: `aobaImg.src = variant.idle`; preload `variant.active` via `new Image()`.
3. **SFX pool**: rebuild from `character.sfx`. If empty string → set pool to empty; `playsfx()` becomes a no-op for the session until variant change.
4. **Background**: set `document.body.style.backgroundImage = character.bg ? \`url('${character.bg}')\` : 'none'`. The fallback `background-color: #1a1a2e` already on body handles the empty case.
5. **BGM**: resolve `bgmSrc = variant.bgm || character.bgm`. Then:
   - If `bgmSrc === ''` → `bgm.pause(); bgm.removeAttribute('src'); bgm.load(); bgmPlaying = false`.
   - Else if `bgmSrc !== bgm.currentSrc` (or no src set) → `bgm.pause(); bgm.src = bgmSrc; bgm.load()`. Replay only if music was already playing (intro completed and `settings.musicVol > 0`).

### SFX pool changes

`buildSoundPool()` currently always pre-creates `POOL_SIZE = 50` Audio elements bound to one src. New behavior:

```js
function buildSoundPool() {
  const { character } = getVariant(settings.skin);
  soundPool.length = 0;
  slotActive.fill(false);
  poolIndex = 0;
  activeSounds = 0;
  if (!character.sfx) return;          // silent character → empty pool
  for (let i = 0; i < POOL_SIZE; i++) { /* unchanged */ }
}
```

`playsfx()` adds an early-out: `if (soundPool.length === 0) return;`. The `goIdle()` call chain still fires through the bounce-animation `onComplete`, so silent characters still animate and return to idle — they just don't squeak.

### Silent character: idle return

`goIdle()` today runs via the SFX `ended` event. For silent characters, we instead trigger `goIdle()` after the bounce animation completes:

```js
bounceAnimation = animate(character, {
  translateY: [ /* … */ ],
  onComplete: () => { if (soundPool.length === 0) goIdle(); },
});
```

This keeps the idle return reliable for both cases.

---

## Stats Schema

Keep the existing per-variant write and **add** a per-character write. This adds one more write to the existing per-click set (`clicksRef`, `dailyTotalRef`, `countries`, `skins`):

```js
const { character } = getVariant(settings.skin);
db.ref('daily/' + todayKey() + '/skins/' + settings.skin).transaction(c => (c || 0) + 1);
db.ref('daily/' + todayKey() + '/characters/' + character.id).transaction(c => (c || 0) + 1);
```

### Firebase rules

`database.rules.json` needs an `.write` rule on `daily/$date/characters/$charId` mirroring the existing `skins` rule.

### Charts

Doughnut chart for skins keeps reading `day.skins` as today. No chart change in this PR — the new `characters` data starts accumulating for future use. (A character vs. variant toggle is a follow-up.)

---

## Mari Sprite Acquisition

Six files, all downloaded from `static.wikia.nocookie.net/blue-archive/` and saved into `assets/`:

| Variant     | Slot   | Filename                    | Source URL |
|-------------|--------|-----------------------------|------------|
| Mari        | idle   | `assets/mari-idle.png`      | `https://static.wikia.nocookie.net/blue-archive/images/5/55/Mari_Portrait_Expression_1.png/revision/latest` |
| Mari        | active | `assets/mari-active.png`    | `https://static.wikia.nocookie.net/blue-archive/images/8/8e/Mari_Portrait_Expression_9.png/revision/latest` |
| Track Mari  | idle   | `assets/maritrack-idle.png` | `https://static.wikia.nocookie.net/blue-archive/images/8/81/Mari_Gym_Portrait_Expression_1.png/revision/latest` |
| Track Mari  | active | `assets/maritrack-active.png` | `https://static.wikia.nocookie.net/blue-archive/images/3/38/Mari_Gym_Portrait_Expression_9.png/revision/latest` |
| Idol Mari   | idle   | `assets/mariidol-idle.png`  | `https://static.wikia.nocookie.net/blue-archive/images/3/37/Mari_Idol_Portrait_Expression_1.png/revision/latest` |
| Idol Mari   | active | `assets/mariidol-active.png` | `https://static.wikia.nocookie.net/blue-archive/images/9/99/Mari_Idol_Portrait_Expression_9.png/revision/latest` |

Convention: `Expression_1` = idle, `Expression_9` = active. URLs use `/revision/latest` (no `scale-to-width-down` so we get the original resolution). Idol Mari idle URL was derived by MD5-hashing the filename per MediaWiki's convention; HEAD request confirmed `200 OK`.

---

## Backward Compatibility

- **localStorage** `settings.skin = 'aoba' | 'aobaplush'` — variant IDs unchanged, resolves correctly.
- **Firebase** `daily/{date}/skins/{variantId}` — still written, chart still reads it.
- **Settings reset** — `DEFAULT_SETTINGS.skin` stays `'aoba'`.

No data migration needed.

---

## Edge Cases & Decisions

- **Selecting a Mari variant before any assets exist** — design assumes sprite files are committed in the same change. If a sprite 404s, the `<img>` simply fails to load; we don't add `onerror` fallback (YAGNI: assets are local-committed).
- **Intro walk + silent Mari** — if the user reset to a Mari variant somehow before clicking the curtain, the intro click triggers the silent SFX path. Intro still ends, bg still swaps, no audio plays. Acceptable.
- **BGM source flipping during playback** — if user toggles between Aoba variants, `bgmSrc` doesn't change → no reload, no pop. Switching characters reloads.
- **`bgmPlaying` flag** — current code sets this true after the first successful play. The variant-change BGM logic should *not* call `bgm.play()` unconditionally; it should respect the current "intro not yet completed" state. Concretely: don't call `play()` from `applyVariant`; let the next click's intro-end / music slider / variant select retrigger it via existing handlers. Simplest rule: `applyVariant` only sets `src`. Playback resumes naturally on next user interaction that touches `bgm.play()` (intro end, slider drag, or — added — first interaction after a variant change if `bgmPlaying` was already true).
  - Concrete: in `applyVariant`, if `bgmPlaying === true` AND new src is non-empty, call `bgm.play().catch(() => {})` after setting src. If new src is empty, set `bgmPlaying = false`.

---

## Implementation Notes

- The skin-related logic is currently in one big script block at the bottom of `index.html`. Keep it there. Don't extract to a separate file in this change.
- Naming: rename `applySkin` → `applyVariant`, `getSkin` → `getVariant` everywhere they're called (`applySettings`, the click handlers, `goIdle`, `playsfx`-adjacent code, `renderSkinList`, intro flow, stats writes, chart label lookup). The chart label lookup currently uses `getSkin(id).name` for the doughnut — needs to use `getVariant(id).variant.name`.
- `renderSkinList` becomes group-aware. Extend the existing `skinListEl.addEventListener('click', …)` to first check `e.target.closest('.skin-group-header')` (toggle that group's `data-open`) and otherwise fall through to the existing `.skin-item` variant-select branch.

---

## Testing

Manual checks against the running page:
1. Reload — Aoba group is open, Aoba variant active, bg.png shows, bgm plays after first click, click sfx plays.
2. Click Aoba Plush — sprite swaps, sfx unchanged, bgm unchanged, bg unchanged.
3. Click Mari group header → expands. Click Mari → sprite swaps to Mari idle, click on character now silent, bgm pauses, body bg becomes solid color.
4. Click Track Mari, then Idol Mari — sprite swaps each time, all silent.
5. Click back to Aoba → bgm resumes (since `bgmPlaying` was true), bg returns, sfx returns.
6. Reset Defaults → returns to Aoba variant with bgm/bg/sfx restored.
7. Open Analytics modal — Skins chart still renders with variant breakdown. Inspect Firebase: `daily/{today}/characters/aoba` and `.../characters/mari` increment correctly.
8. Refresh with `localStorage.aobing-settings.skin = 'mariidol'` set — page loads with Idol Mari selected and Mari group open.

No automated tests (the project has none currently — single static HTML page).
