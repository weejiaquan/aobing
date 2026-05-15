# Miyu Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Miyu as a third character with two variants (Default + Swimsuit) and introduce an optional `active2` sprite slot that any variant can declare; when set, the click handler uses it whenever `comboCount >= 20`.

**Architecture:** Single static HTML page (`index.html`). All logic lives in one script block. The change is data-only for the variant registry plus a tiny resolver function and two one-line swaps at the existing click sites. Six new PNG sprites get downloaded into `assets/`.

**Tech Stack:** Plain HTML/CSS/JS in `index.html`. No build tooling, no test suite. PowerShell available on this Windows host for asset download and MD5 computation. Bash available via Git Bash.

**Spec:** `docs/superpowers/specs/2026-05-15-miyu-character-design.md`

---

## File Structure

- **Modify:** `index.html` — three independent edits in the single script block:
  - Add `Miyu` entry to `CHARACTERS` array (around `:1964`).
  - Add `COMBO_TIER_THRESHOLD` constant + `resolveActiveSrc(variant)` helper (near `:4933`).
  - Swap two `aobaImg.src = v.active` lines to use the resolver (`:4838`, `:4884`).
  - Extend `applyVariant` preload to also preload `variant.active2` when present (around `:2710-2714`).
- **Create (assets):**
  - `assets/miyu-idle.png`
  - `assets/miyu-active.png`
  - `assets/miyu-active2.png`
  - `assets/miyuswim-idle.png`
  - `assets/miyuswim-active.png`
  - `assets/miyuswim-active2.png`

No new files of any other kind. No Firebase rule changes. No CSS changes.

---

## Task 1: Download Miyu sprite assets

**Files:**
- Create: `assets/miyu-idle.png`
- Create: `assets/miyu-active.png`
- Create: `assets/miyu-active2.png`
- Create: `assets/miyuswim-idle.png`
- Create: `assets/miyuswim-active.png`
- Create: `assets/miyuswim-active2.png`

- [ ] **Step 1: Download the five known URLs**

The five known sources from the spec table go straight into `assets/`. Run these from the repo root:

```powershell
$base = "C:\Users\Lychwee\Documents\GitHub\aobing\assets"
$pairs = @(
  @{ url = "https://static.wikia.nocookie.net/blue-archive/images/c/c5/Miyu_Portrait_Expression_1.png/revision/latest"; out = "$base\miyu-idle.png" },
  @{ url = "https://static.wikia.nocookie.net/blue-archive/images/7/7c/Miyu_Portrait_Expression_9.png/revision/latest"; out = "$base\miyu-active.png" },
  @{ url = "https://static.wikia.nocookie.net/blue-archive/images/4/4a/Miyu_Portrait_Expression_10.png/revision/latest"; out = "$base\miyu-active2.png" },
  @{ url = "https://static.wikia.nocookie.net/blue-archive/images/d/d7/Miyu_Swimsuit_Portrait_Expression_1.png/revision/latest"; out = "$base\miyuswim-idle.png" },
  @{ url = "https://static.wikia.nocookie.net/blue-archive/images/d/de/Miyu_Swimsuit_Portrait_Expression_9.png/revision/latest"; out = "$base\miyuswim-active.png" }
)
foreach ($p in $pairs) {
  Invoke-WebRequest -Uri $p.url -OutFile $p.out -UserAgent "Mozilla/5.0"
}
Get-ChildItem $base\miyu*.png, $base\miyuswim*.png | Select-Object Name, Length
```

Expected: five files with non-zero sizes (typically 200KB–2MB each).

- [ ] **Step 2: Derive the Swimsuit Expression_10 URL**

The user only provided the gallery URL for Swimsuit Expression_10. Compute the MD5 hash of the filename and build the CDN URL.

```powershell
$filename = "Miyu_Swimsuit_Portrait_Expression_10.png"
$md5 = [System.Security.Cryptography.MD5]::Create()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($filename)
$hash = ($md5.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
$h1 = $hash.Substring(0,1)
$h2 = $hash.Substring(0,2)
$url = "https://static.wikia.nocookie.net/blue-archive/images/$h1/$h2/$filename/revision/latest"
$url
try {
  $head = Invoke-WebRequest -Uri $url -Method Head -UserAgent "Mozilla/5.0"
  "HEAD status: $($head.StatusCode)"
} catch {
  "HEAD failed: $($_.Exception.Message)"
}
```

Expected: URL printed and `HEAD status: 200`. If HEAD fails, fall through to Step 3 fallback.

- [ ] **Step 3: Download Swimsuit Expression_10 (with fallback)**

If the HEAD succeeded in Step 2, download from the derived URL:

```powershell
$base = "C:\Users\Lychwee\Documents\GitHub\aobing\assets"
Invoke-WebRequest -Uri $url -OutFile "$base\miyuswim-active2.png" -UserAgent "Mozilla/5.0"
(Get-Item "$base\miyuswim-active2.png").Length
```

Expected: a non-zero file length (typically 200KB–2MB).

If HEAD failed in Step 2, fall back to scraping the gallery page for the direct image URL:

```powershell
$gallery = "https://bluearchive.fandom.com/wiki/Kasumizawa_Miyu_(Swimsuit_ver.)/Gallery?file=Miyu_Swimsuit_Portrait_Expression_10.png"
$html = (Invoke-WebRequest -Uri $gallery -UserAgent "Mozilla/5.0").Content
# The full-size URL appears in a data-src or href attribute on the file page.
# Find the static.wikia.nocookie.net URL ending in Expression_10.png:
$match = [regex]::Match($html, 'https://static\.wikia\.nocookie\.net/blue-archive/images/[^"\s]*Miyu_Swimsuit_Portrait_Expression_10\.png[^"\s]*')
$realUrl = $match.Value -replace "/scale-to-width-down/\d+", ""
$realUrl
Invoke-WebRequest -Uri $realUrl -OutFile "$base\miyuswim-active2.png" -UserAgent "Mozilla/5.0"
(Get-Item "$base\miyuswim-active2.png").Length
```

Expected: file written with non-zero size.

- [ ] **Step 4: Verify all six files are valid PNGs**

```powershell
$base = "C:\Users\Lychwee\Documents\GitHub\aobing\assets"
$files = @("miyu-idle.png","miyu-active.png","miyu-active2.png","miyuswim-idle.png","miyuswim-active.png","miyuswim-active2.png")
foreach ($f in $files) {
  $path = "$base\$f"
  if (-not (Test-Path $path)) { Write-Host "MISSING: $f"; continue }
  $bytes = [System.IO.File]::ReadAllBytes($path)[0..7]
  $isPng = $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47
  $size = (Get-Item $path).Length
  Write-Host ("{0,-28} {1,10} bytes  PNG={2}" -f $f, $size, $isPng)
}
```

Expected: all six lines show `PNG=True` and a non-zero byte count. If any line shows `PNG=False`, that file was corrupted in download — re-run the relevant step.

- [ ] **Step 5: Commit assets**

```bash
git add assets/miyu-idle.png assets/miyu-active.png assets/miyu-active2.png assets/miyuswim-idle.png assets/miyuswim-active.png assets/miyuswim-active2.png
git commit -m "Add Miyu sprite assets (idle, active, active2 for Default and Swimsuit)"
```

---

## Task 2: Add COMBO_TIER_THRESHOLD constant and resolveActiveSrc helper

**Files:**
- Modify: `index.html` near `:4933` (after the existing `const COMBO_CAP_TIER = 5;` line, before `const comboEl = ...`)

- [ ] **Step 1: Locate the insertion point**

Open `index.html` and find this region (around line 4928-4936):

```js
    const COMBO_CAP_TIER = 5; // no new effects past 100x; combo still climbs
    const comboEl = document.getElementById('combo-display');
```

The new constant and helper go between these two lines.

- [ ] **Step 2: Insert the constant and helper**

Replace the block:

```js
    const COMBO_CAP_TIER = 5; // no new effects past 100x; combo still climbs
    const comboEl = document.getElementById('combo-display');
```

With:

```js
    const COMBO_CAP_TIER = 5; // no new effects past 100x; combo still climbs

    // When a variant declares an optional `active2` sprite, it swaps in for
    // `active` on clicks where the running combo has reached this threshold.
    // Variants without `active2` are unaffected.
    const COMBO_TIER_THRESHOLD = 20;
    function resolveActiveSrc(variant) {
      if (variant.active2 && comboCount >= COMBO_TIER_THRESHOLD) return variant.active2;
      return variant.active;
    }

    const comboEl = document.getElementById('combo-display');
```

`comboCount` is hoisted into scope further down (`let comboCount = 0;` at the original `:4953`). Since `resolveActiveSrc` isn't called until after the page is fully loaded and a user click happens, the temporal-dead-zone is not a concern — `comboCount` is initialized by the time the function runs.

- [ ] **Step 3: Verify the edit applied cleanly**

```bash
grep -n "COMBO_TIER_THRESHOLD\|resolveActiveSrc" index.html
```

Expected output: three matches — the constant declaration, the function declaration, and (in a later task) the call sites. At this point you should see two matches:

```
4934:    const COMBO_TIER_THRESHOLD = 20;
4935:    function resolveActiveSrc(variant) {
4936:      if (variant.active2 && comboCount >= COMBO_TIER_THRESHOLD) return variant.active2;
```

(Line numbers will shift slightly due to inserted lines.)

- [ ] **Step 4: Sanity-check the page loads**

Open `index.html` in a browser (or start `serve.bat` and visit `http://localhost:8000`). Click the curtain to start. Verify no JavaScript console errors and the existing Aoba behavior is unchanged. The new constant and helper are dormant until a variant with `active2` is selected.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add COMBO_TIER_THRESHOLD constant and resolveActiveSrc helper"
```

---

## Task 3: Wire resolveActiveSrc into both click sites

**Files:**
- Modify: `index.html` `:4838` (intro-end first click) and `:4884` (post-intro `triggerClick`)

- [ ] **Step 1: Update intro-end click site**

Find this block (around `:4832-4838`):

```js
          // First click — full click effects
          const { character: ch, variant: v } = getVariant(settings.skin);
          recordClick(source);

          playsfx();
          bumpCombo();

          aobaImg.src = v.active;
```

Change the last line:

```js
          aobaImg.src = resolveActiveSrc(v);
```

- [ ] **Step 2: Update post-intro click site**

Find this block (around `:4877-4884`):

```js
      const { variant: v } = getVariant(settings.skin);

      // 1. Play SFX — each click spawns its own audio, oldest evicted at cap
      playsfx();
      bumpCombo();

      // 2. Swap to active image
      aobaImg.src = v.active;
```

Change the last line:

```js
      aobaImg.src = resolveActiveSrc(v);
```

- [ ] **Step 3: Verify both call sites changed**

```bash
grep -n "aobaImg.src = " index.html
```

Expected: you should see lines like:

```
2712:      aobaImg.src = variant.idle;
3447:      aobaImg.src = getVariant(settings.skin).variant.idle;
4838:          aobaImg.src = resolveActiveSrc(v);
4884:      aobaImg.src = resolveActiveSrc(v);
```

The two `v.active` references should both now read `resolveActiveSrc(v)`. The two `idle` references are unchanged (those are correct — idle return uses `variant.idle`, not the active sprite).

```bash
grep -n "aobaImg.src = v.active\|aobaImg.src = variant.active" index.html
```

Expected: zero matches.

- [ ] **Step 4: Smoke-test in browser**

Load the page, click the curtain, click Aoba a few times. Confirm:

1. Sprite swaps to `aoba-active.webp` on click (same as before).
2. Combo counter climbs.
3. No console errors.

Aoba has no `active2`, so `resolveActiveSrc` returns `variant.active` unconditionally — behavior is identical to pre-change.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Route active sprite through resolveActiveSrc"
```

---

## Task 4: Preload active2 in applyVariant

**Files:**
- Modify: `index.html` `:2710-2714`

- [ ] **Step 1: Find current preload code**

Around `:2710-2714` in `applyVariant`:

```js
      aobaImg.src = variant.idle;
      // Preload active sprite so the click-swap is instant.
      const preload = new Image();
      preload.src = variant.active;
```

(The exact comment text may differ; the structural pattern is `aobaImg.src = variant.idle` followed by `new Image()` preload of `variant.active`.)

- [ ] **Step 2: Add the active2 preload**

Replace with:

```js
      aobaImg.src = variant.idle;
      // Preload active sprite so the click-swap is instant.
      const preload = new Image();
      preload.src = variant.active;
      if (variant.active2) {
        const preload2 = new Image();
        preload2.src = variant.active2;
      }
```

- [ ] **Step 3: Verify**

```bash
grep -n "preload2\|variant.active2" index.html
```

Expected: at minimum the two new lines plus (later) the `CHARACTERS` declarations. At this point you should see:

```
2715:      if (variant.active2) {
2716:        const preload2 = new Image();
2717:        preload2.src = variant.active2;
```

(Line numbers shift with edits.)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Preload variant.active2 when present"
```

---

## Task 5: Add Miyu character entry to CHARACTERS

**Files:**
- Modify: `index.html` around `:1964` (just after the closing `},` of the Mari entry, before the closing `];` of the array)

- [ ] **Step 1: Find the insertion point**

Around `:1947-1965`:

```js
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
    ];
```

The new entry goes between the closing `},` of Mari and the `];` that closes the array.

- [ ] **Step 2: Insert Miyu entry**

Change:

```js
        ],
      },
    ];
```

To:

```js
        ],
      },
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
    ];
```

- [ ] **Step 3: Verify entry parses**

```bash
grep -n "id: 'miyu'\|active2:" index.html
```

Expected: `id: 'miyu'`, `id: 'miyuswim'`, and the two `active2:` lines all present.

Then load the page in a browser. Open the Skins panel. Confirm a new "Miyu" group appears with two variant tiles. Open browser console and run:

```js
JSON.stringify(CHARACTERS.map(c => ({id: c.id, variants: c.variants.length})))
```

Expected output:

```
[{"id":"aoba","variants":2},{"id":"mari","variants":3},{"id":"miyu","variants":2}]
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add Miyu character (Default + Swimsuit variants)"
```

---

## Task 6: Manual end-to-end testing

The project has no automated test suite. Run the full manual test checklist from the spec.

**Files:** None modified.

- [ ] **Step 1: Start the local server**

```bash
./serve.bat
```

Or equivalent: any static HTTP server on port 8000 serving the repo root. The page must be served via HTTP (not `file://`) because the audio/Firebase code expects it.

Open `http://localhost:8000` in a browser. Open DevTools (Network and Console tabs).

- [ ] **Step 2: Selection flow check**

Click the curtain to begin. Open the Skins panel. Verify:
- Aoba group is expanded (the default).
- Mari group is collapsed.
- Miyu group is collapsed with header reading "Miyu" and meta "2 variants".

Click Miyu's header to expand. Two tiles appear: "Miyu / Default" (using `miyu-idle.png` thumbnail) and "Miyu Swimsuit / Swimsuit" (using `miyuswim-idle.png`). Both thumbnails load (no broken-image icons).

- [ ] **Step 3: Slow-clicking on Miyu (no active2)**

Click the "Miyu" tile. Confirm:
- Sprite swaps to `miyu-idle.png`.
- Background goes to solid dark color (no bg image — Miyu has empty `bg`).
- BGM pauses (Miyu has empty `bgm`).

Click the character once. Sprite briefly shows `miyu-active.png` during bounce, returns to `miyu-idle.png`. No click sound (Miyu has empty `sfx`).

Wait 5+ seconds (combo expires). Click again. Same behavior. Combo counter stays low.

- [ ] **Step 4: Crossing combo 20 on Miyu**

Click rapidly (or use a keyboard mash) until combo reaches 20+. Watch the in-bounce sprite. Confirm:
- Clicks 1-19: sprite during bounce is `miyu-active.png`.
- Click 20: sprite during bounce switches to `miyu-active2.png`.
- Clicks 21+: continue using `miyu-active2.png`.
- Idle (between rapid clicks): still `miyu-idle.png`.

In DevTools Network tab, all three Miyu PNGs should have been requested at variant-select time (preload).

- [ ] **Step 5: Combo expiry resets sprite**

After a 30+ click run, stop clicking. Wait for the combo display to fade out (a few seconds — `expireCombo` runs). Click once more. Sprite shows `miyu-active.png` (not `active2`), since `comboCount` is now 1.

- [ ] **Step 6: Variant switch mid-run, Miyu → Miyu Swimsuit (with combo ≥ 20)**

Build combo to ≥ 25 on Miyu. Without letting it expire, open the Skins panel and click the "Miyu Swimsuit" tile. The next click on the character should show `miyuswim-active2.png` during bounce.

- [ ] **Step 7: Variant switch mid-run, Miyu → Aoba (with combo ≥ 20)**

Build combo to ≥ 25 on Miyu. Without letting it expire, switch to Aoba. The next click shows `aoba-active.webp` (plain `active`, because Aoba has no `active2`). No console errors.

- [ ] **Step 8: Variant switch mid-run, Aoba → Miyu (with combo ≥ 20)**

Build combo to ≥ 25 on Aoba (any Aoba variant). Without letting it expire, switch to Miyu. The next click shows `miyu-active2.png` (combo state persisted across the switch).

- [ ] **Step 9: Auto-clicker triggers active2**

Buy/upgrade the shop's auto-clicker to a rate ≥ 1 cps. Watch the combo climb passively. When it reaches 20, confirm the in-bounce sprite swaps to `active2`. Confirms auto-click flows through `triggerClick` → `resolveActiveSrc`.

- [ ] **Step 10: Persistence**

In DevTools Console:

```js
const s = JSON.parse(localStorage.getItem('aobing-settings'));
s.skin = 'miyuswim';
localStorage.setItem('aobing-settings', JSON.stringify(s));
location.reload();
```

After reload and clicking the curtain, confirm:
- Miyu group is auto-opened.
- Miyu Swimsuit tile is marked active.
- Sprite is `miyuswim-idle.png`.
- Background is the solid dark color.

- [ ] **Step 11: Firebase writes & analytics chart**

Click on Miyu and Miyu Swimsuit a few times. Open Firebase console (or run a query in the JS console using the existing `db` ref):

```js
db.ref('daily/' + todayKey() + '/skins/miyu').once('value').then(s => console.log('miyu:', s.val()));
db.ref('daily/' + todayKey() + '/skins/miyuswim').once('value').then(s => console.log('miyuswim:', s.val()));
db.ref('daily/' + todayKey() + '/characters/miyu').once('value').then(s => console.log('miyu char:', s.val()));
```

Expected: non-zero counts for each. Then open the Analytics modal: the Skins doughnut chart should include Miyu and Miyu Swimsuit slices.

- [ ] **Step 12: Regression — Aoba and Mari unchanged**

Switch back to Aoba. Confirm:
- BGM resumes (the bgm flag was true from earlier).
- `bg.png` background returns.
- Click sound returns.
- Sprite swap on click works as before.

Switch to each Mari variant. Confirm Mari's per-variant BGM and BG still apply correctly and click SFX cycles through Mari's four sound files.

- [ ] **Step 13: No console errors**

Throughout all the above, the browser console should show no errors. If any errors appear, investigate and fix before proceeding.

---

## Task 7: Final cleanup commit

**Files:** None new.

- [ ] **Step 1: Verify clean working tree**

```bash
git status
```

Expected: working tree clean. All changes should be committed in Tasks 1-5.

- [ ] **Step 2: Verify the diff summary**

```bash
git log --oneline -10
```

Expected: at least these new commits (most recent first):
- "Add Miyu character (Default + Swimsuit variants)"
- "Preload variant.active2 when present"
- "Route active sprite through resolveActiveSrc"
- "Add COMBO_TIER_THRESHOLD constant and resolveActiveSrc helper"
- "Add Miyu sprite assets (idle, active, active2 for Default and Swimsuit)"
- "Add Miyu character design spec" (already on master)

```bash
git diff master~5 --stat
```

Expected: 6 PNG files added under `assets/`, and `index.html` modified with a small net positive line count (~15-20 lines).

No further commits needed. Implementation complete.
