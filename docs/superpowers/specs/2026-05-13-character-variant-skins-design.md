---
name: character-variant-skins
description: Restructure the flat skins registry into a two-level character → variant hierarchy with per-character SFX, BGM, background, and idle-text bubble, plus a new Mari character with three variants.
status: backlog
created: 2026-05-13T00:00:00Z
updated: 2026-05-13T00:00:00Z
---

# Character / Variant Skins

## Goal

Replace the current flat `SKINS` registry with a two-level **character → variant** hierarchy so each character bundles a shared SFX, BGM, and background image, with variants able to override the BGM individually. Add **Mari** as a second character with three variants (Mari, Track Mari, Idol Mari) using sprites from `static.wikia.nocookie.net`. Also add a per-character **idle-text bubble** that surfaces a random line when the user has been idle 15 s.

## Scope

- `index.html` only — registry, panel rendering, skin-apply logic, asset preload, stats writes, idle-bubble markup + CSS + JS.
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
    idleTexts: ['hi'],
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
    idleTexts: ['hi'],  // populate later
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
- **Character.idleTexts** — array of strings. Empty array = no idle bubble for that character. Random pick on each idle trigger (uniform; same line may repeat across cycles).
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

## Idle Text Bubble

A small speech-bubble UI anchored to the top-right of the character sprite. Surfaces a random line from the active character's `idleTexts` after 15 s of inactivity, auto-hides after 5 s, and is dismissable by click.

### Markup

Added inside `#character`, above the `<img>`:

```html
<div id="character">
  <button id="idle-bubble" type="button" hidden>
    <span id="idle-bubble-text"></span>
  </button>
  <img id="aoba-img" …>
</div>
```

Using a `<button>` so it's keyboard-focusable and inherits click semantics. `hidden` attribute is the default off-state.

### Position & style

- `position: absolute` inside `#character` (which is `position: relative`).
- Anchored top-right of the sprite: `top: 4%; right: -8%;` (the sprite is `height: 90vh` centered, so right-of-sprite negative offset reads as "just outside the sprite's shoulder"). Specific values to be tuned during implementation; goal is "looks like a chat bubble emerging from the upper-right of the character".
- Visual: rounded rect with a small triangular tail pointing down-left toward the character. White-ish bg (`rgba(255,255,255,0.92)`), dark text, soft drop-shadow, max-width ~220px, padding ~10px 14px, font ~0.95rem. Reset browser button defaults (border:none, font:inherit, cursor:pointer).
- `pointer-events: auto` on the bubble (whole `#character` is clickable; the bubble click is intercepted — see below).
- Animated entrance/exit: fade + slight upward translate (CSS transition on `opacity` + `transform`, ~180 ms).

### Behavior

State carried in module-scoped variables:

```js
let idleTimer = null;          // setTimeout id for the 15s wait
let bubbleHideTimer = null;    // setTimeout id for the 5s auto-hide
let bubbleVisible = false;
```

Lifecycle:

1. **Schedule**: `scheduleIdleBubble()` clears `idleTimer` and starts a fresh 15 s timeout. Called whenever idle should restart (see "Activity reset" below).
2. **Show**: After 15 s, if the active character has a non-empty `idleTexts`, pick a random entry, set `#idle-bubble-text` textContent, remove `hidden`, set `bubbleVisible = true`, start 5 s `bubbleHideTimer`. If the character has no idle texts (e.g. empty array), skip showing and **don't reschedule** — wait for the next activity event to start a fresh 15 s wait.
3. **Auto-hide**: After 5 s, `hideBubble()` (see below) runs. Then call `scheduleIdleBubble()` so the next 15 s idle period begins immediately.
4. **Click-dismiss**: Clicking the bubble runs `hideBubble()` and calls `scheduleIdleBubble()` (the click itself counts as activity, so it resets the timer to 15 s from now).
5. **Variant change**: `applyVariant()` calls `hideBubble()` (if visible) then `scheduleIdleBubble()` so the new character's bubble can fire 15 s from now.

`hideBubble()`:
```js
function hideBubble() {
  if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
  document.getElementById('idle-bubble').hidden = true;
  bubbleVisible = false;
}
```

### Activity reset

Any of the following resets the idle timer (calls `scheduleIdleBubble()` after first running its own logic):

- `triggerClick` (character click / keypress).
- `mousemove` on `document` — throttled to once per 500 ms (to avoid timer churn).
- `keydown` on `document` (already triggers click, so handled).
- Touch / click events on `settings-btn`, `skins-btn`, `stats-btn`, `curtain`, panel sliders/toggles.
- The bubble's own click.

Concrete wiring:
- `document.addEventListener('pointerdown', scheduleIdleBubble)` — covers character click, panel buttons, curtain, bubble click (all bubble to document).
- `document.addEventListener('mousemove', scheduleIdleBubble)` — throttled to once per 500 ms.
- `document.addEventListener('keydown', scheduleIdleBubble)` — keypress doesn't fire pointer events, so explicit listener needed. (The existing `keydown → triggerClick` listener stays; both fire.)

Pointerdown bubbles through panel buttons too, so we don't need per-button hooks.

### Bubble click handler

```js
idleBubbleEl.addEventListener('click', (e) => {
  e.stopPropagation();   // don't trigger character click
  hideBubble();
  scheduleIdleBubble();
});
```

`stopPropagation` is important because the bubble lives inside `#character`, which has its own `click` handler that fires `triggerClick`. Without it, clicking the bubble would also squeak.

### Intro interaction

`scheduleIdleBubble()` is started for the first time after `endIntro()` finishes (right after the first BGM `play()`). Before that, no idle timer runs. While the curtain is up, no bubble can appear.

### Edge cases

- **Tab hidden** — `setTimeout` is throttled by browsers when the tab is backgrounded; we accept the resulting drift (bubble might appear right after refocus). Acceptable.
- **User dismisses, then immediately interacts** — bubble's `click` schedules 15 s, then the activity listener also schedules 15 s. Both call `scheduleIdleBubble()` which clears and resets — idempotent.
- **Settings panel open during idle** — the panel's transparent overlay doesn't block bubble visibility; bubble still appears. Acceptable (mirrors the existing behavior where the character is always visible behind panels).
- **Variant has no `idleTexts` field** — treat as empty array. No bubble.

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
9. After clicking the curtain to start, leave the page alone for ~15 s. Bubble fades in at top-right of Aoba with text "hi". After 5 s it fades out. After another 15 s of inactivity, it reappears.
10. While bubble is visible, click it. It disappears immediately; clicking the bubble does **not** cause a character squeak. After 15 s of inactivity, it reappears with a fresh random pick.
11. Move the mouse around continuously — bubble never appears. Stop moving for 15 s — bubble appears.
12. Switch to Mari (which has `idleTexts: ['hi']`) — wait 15 s — bubble appears over Mari. Switch to a character whose `idleTexts` is empty (manually test by editing the array) — wait 15 s — no bubble appears.

No automated tests (the project has none currently — single static HTML page).
