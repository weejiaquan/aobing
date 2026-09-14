# Aobing IT! design specification

Last updated: 2026-09-14. This is the current design contract for the game shell,
based on the owner's requests. Follow it for future UI work; newer explicit user
instructions take precedence. Update this document when the direction changes.
Timings and colors below describe the current baseline and may be tuned while
preserving the intended behavior.

## Identity and tone

- Brand: **AOBING IT!**. The small boot masthead may use **AOBING.IT**.
- This is a character-led game hub with a clicker at its center. Give it the
  atmosphere, animated opening, and clear controls of a game menu.
- Use an airy cyan, ice blue, white, and navy interface, gold for Aoba's logo
  halo, and darker blue surfaces at night. Keep character art prominent.
- The earlier `../yonaka-radar` project inspired the ambition of the motion.
  Aobing must have its own scenery and identity; do not copy its repeating
  background pattern.
- Do not reintroduce these removed public-facing names or slogans, including
  case variants: “Blue Archive”, “Kivotos Arcade”, “Aobing Arcade”,
  “Your daily playground”, “Your daily dose of Aobing”,
  “Let's play something.”, or “Ready when you are.”
- The owner requested the atmosphere of Kivotos through the city and enormous
  sky halo. This is an art-direction reference, not a public-facing brand label.
- Keep copy brief and useful. Loading, retry, and departure messages may remain;
  the ready-state status is blank beside the **ENTER GAME** action.

## Visual language

| Role | Current baseline |
| --- | --- |
| Main ink | `--hub-ink: #183653` |
| Primary action / accent | `--hub-blue: #009fe8` |
| Fine borders | `--hub-line: #beddec` |
| Light page base | `#dff3fa` |
| Wordmark highlight | `#a5efff` |
| Aoba logo halo | `#f5bd67`, subtle static gold glow |
| Night panels | Deep navy, approximately `#112b46`, with pale blue text |

Use bold italic display type for the wordmark and major headings, with the
existing Arial Black / Segoe UI / sans-serif stack. Small uppercase labels may
use tracking, but body text and controls must stay readable. Panels use fine
borders, restrained shadows, and selective asymmetric corners. Primary actions
can use a slight diagonal slant. Reuse the existing CSS variables rather than
creating a competing theme; some inherited variables still have a `--ba-` prefix.

Keep the full **AOBING IT!** wordmark visible, including italic overhang and glow.
Retain its padding, responsive sizing, and single-line layout. A reveal mask
must not keep clipping the finished logo.

## Original sky and city artwork

- Draw the environment in original SVG, CSS gradients, and lightweight DOM
  layers. The owner's linked images are inspiration only; never place those
  pictures into the background. Existing character and skin artwork can remain
  raster assets.
- The home page and boot scene need a large aerial halo: concentric elliptical
  rings and a vertical light column over clouds and a distant city.
- The city must remain visible in **daytime as well as nighttime**. During the
  day, brighten it and add atmospheric haze; at night, show windows, reflections,
  and the tower beacon. Stars appear as darkness increases.
- Keep this environmental sky halo distinct from Aoba Utsumi's gold logo halo.
  The latter has a railway-like broken outer ring, inner ring, connectors, and
  crossbar; preserve the established inline SVG geometry.
- Default to the user's device-local time. Blend daylight, warmth, and stars
  continuously through sunrise and sunset rather than snapping the whole sky
  between presets. Sunrise is art-directed for 05:00–08:00 and sunset for
  17:00–20:00; these are not geographic sunrise/sunset calculations.
- Current blending uses smoothstep between stops in `sky-time.js`, pink morning
  warmth, orange evening warmth, and stars weighted by darkness squared. The
  clock refreshes every 30 seconds while visible and resynchronizes on return.
- Keep `#sky-picker` **hidden**, including its legend, buttons, and time output.
  Its retained markup supports previews; it is not part of the public layout.
  Preserve the `[hidden]` display override so the flex rule cannot reveal it.
  Developers can preview `?hour=6`, `?hour=12`, `?hour=18`, and `?hour=23`.
  Remove the query parameter to return to device time.

See [assets/sky-sources.md](../assets/sky-sources.md) for the art inventory and
reference provenance.

## Boot and motion

The sequence is: train arrives from the left, idles behind the logo, accelerates
off the right when the player enters, then a camera push reveals the game.

- The train is a **large monotone silhouette**, centered behind the Aobing logo
  and atmospheric overlay, above the sky layer. It is part of the scenery, not
  a foreground illustration. Use `currentColor` and cutout windows, subdued navy
  by day and pale blue by night. Current width is `clamp(680px, 140vw, 1800px)`.
- Arrival takes about 2.1 seconds and settles in the middle. While idling, cars
  have tiny staggered suspension movements, rotating wheels, and scrolling
  railway scenery. The bounce should suggest weight, not exaggerated hopping.
- On **ENTER GAME**, finish arrival if needed, accelerate the entire train
  beyond the right edge in about 1.25 seconds, and begin a small camera push.
  Follow with a roughly 650 ms zoom/fade to reveal the game (current scale
  progression: 1 → 1.035 → 1.16 → 1.9). Keep the train fully offscreen before
  removing the curtain. Calculate departure distance from the viewport.
- The logo stays animated for the entire idle screen. The halo rotates once
  every 32 seconds with **linear timing from the start and no delay**. Its outer
  wrapper fades in independently; SVG strokes can trace in independently.
- The wordmark floats gently through a 4 px vertical range on an 8 second loop.
  Its motion wrapper handles the continuous transform; the child handles the
  one-time reveal. Keep the glow static during the float.
- Do not hand off between an eased intro rotation and a second idle rotation,
  restart loops at readiness, or animate text filters during the float. Those
  approaches produced the jarring slowdown and jagged motion the owner rejected.
- Honor `prefers-reduced-motion` in both CSS and JavaScript: skip decorative
  loops, train travel, and camera movement while keeping entry functional.

## Lobby, game library, and settings

The owner selected the **game library as the reference for every UI surface**.
Use its large italic headings, small cyan section labels, subtle SVG halo backdrop,
spacious cards, fine borders, asymmetric corners, and blurred modal backdrop for
shop, settings, characters, rankings, statistics, profile, and confirmation dialogs.
Carry the same colors and controls into typing, fishing/Fishdex, and rhythm menus,
imports, customization, and results. Preserve gameplay canvas geometry and timing.

- Settings is a centered window with Sound & atmosphere, Play & display, and
  General sections; keep controls aligned, labeled, and comfortably spaced.
- Characters uses illustrated variant cards with large portraits, active selection
  marks, level/tag details, and the existing bond actions. Keep character groups
  expandable and support keyboard selection without dismissing the collection.
- Shop is a full window with an available-coins balance, grouped upgrade cards,
  prices, levels, effects, affordability states, and prestige styling. Its contents
  adapt to the current game: typing modifier purchases and combo upgrades in
  Typing; clicker upgrades otherwise. Keep the coin balance shared and live.
- In Typing, show a separate **Modifiers** button beside Shop. Its window contains
  owned modifier switches and feedback/display controls. Purchases belong in Shop;
  ranked assist restrictions remain enforced, with saved Casual preferences kept.
- **The bottom-right chip is always Shop, in every game, and opens the shop
  directly.** No intermediate dropdown, “OPTIONS /” prefix, or dropdown caret.
  Do not add a fifth Shop button to the bottom utility row.
- Remove the old `.mp-modes` row (Clicker / Typing / Rhythm / Fishing) from the
  dropdown. The game library handles game selection, including the three rhythm
  games. Clicking Typing opens a second library view with Casual and Ranked cards,
  an All games back button, and expandable run-duration settings. Selecting
  a submode launches it. Modifier purchases and switches live in their own windows.
  The typing countdown belongs beside the play controls, not inside Shop.
- Typing Restart is a compact icon-and-text action with a quiet border. Do not
  wrap it in another visible box; live metrics have their own surface. The word
  box must accommodate three complete lines plus its padding and border, without
  clipping the final line.
- Rankings uses clear player rows and highlighted personal rank; statistics uses
  large metric cards and matching chart panels. Chart labels/tooltips must be
  readable in the night theme as well as daytime.
- Panel windows close with their close button, Escape, or backdrop. Trap focus,
  make the background inert, and restore focus to the opener. After closing the
  shop, return focus to the dropdown control. Nested confirmations keep the
  parent window intact.
- Keep `.lobby-feature` hidden until the owner is ready to build it.
- The character speech bubble lives outside the animated character element so
  text does not inherit its bounce or image filters. Reserve the full line's size
  during typewriter reveal, avoid preserved markup whitespace, support night
  colors, and keep the bubble inside the viewport. Reduced motion shows the full
  line immediately. Display speech only in the clicker view.

- Keep the character central, profile toward the lower left, game launcher and
  Shop toward the lower right, and labeled utility controls along the
  bottom: Settings, Characters, Rankings, Statistics.
- Preserve the native game-library dialog and six choices: Clicker, Typing,
  Fishing, Standard, Mania, and Diva. Reuse existing mode switching and settings.
- Replace permanent marketing copy with the temporary greeting:
  **Welcome back, [username].** / **Hope you enjoy your stay.** Use the profile
  display name safely through `textContent`, with “Sensei” as the fallback.
  Show it after entry, hold about 4.5 seconds, slide it off the left over 600 ms,
  then hide it. It should not reappear every time a mode is switched.
- Preserve the **Character background** settings switch. Off uses the dynamic
  sky; on reveals the original selected character/skin background in clicker
  mode. Persist through the existing settings system and reset to off with
  defaults. Boot and game-library scenery retain their own presentation.
- On narrow screens, prioritize the character and usable navigation. The
  desktop feature card can disappear. Support short windows without clipping
  the wordmark or making the entry button unreachable.

## Implementation map and interaction requirements

| File | Responsibility |
| --- | --- |
| `index.html` | Boot markup and inline halo/train SVG, lobby, library, settings controls |
| `game-shell.css` | Shell layout, theme, sky layers, responsive rules, CSS motion |
| `game-shell.js` | Boot timeline, library navigation including the typing submode view, sky clock/previews, greeting dismissal |
| `ui-panels.css` | Shared library-inspired panel, control, collection, and game-menu styling; loads after legacy inline styles |
| `ui-panels.js` | Existing-panel focus/inert management, close controls, keyboard card interaction, accessible switch state |
| `sky-time.js` / `sky-time.test.js` | Pure hour-to-sky interpolation and its tests |
| `assets/sky-*.svg` | Original clouds, city, city lights, and aerial halo |
| `assets/railway-scenery.svg` | Moving background railway scenery |
| `app.js` | Existing game modes, profile, settings, character variants, audio integration |

Keep the shell separate from clicker economy and game engines. Reuse
`aobingready`, `aobingstart`, `aobinglaunch`, and the existing mode application
path. Initialize audio inside the entry click gesture, before awaiting motion.
Entering the hub must not count as a gameplay click. Keep gameplay inert and
keyboard input blocked until the curtain is removed; restore focus on entry.
The library must retain native dialog keyboard behavior without sending those
keys to a running game. Decorative art must not intercept clicks or enter the
accessibility tree. Hidden controls must stay out of keyboard navigation.

## Review checklist

For UI or motion changes, review the affected behavior at desktop, narrow mobile,
and short landscape sizes. Use a local preview; do not treat parsing or source
inspection as proof of visual smoothness.

- Inspect the four sky previews and intermediate hours such as 7.5 and 18.5.
  Confirm daytime city visibility, night lights/stars, and a readable sky halo.
- Watch the initial reveal, idle for at least one full halo revolution, then
  enter. Look for clipped lettering, motion jitter, rotation speed changes,
  train arrival/departure jumps, and a premature game reveal.
- Check reduced motion, keyboard entry, library focus/Escape, and that hidden
  sky controls do not interfere with Tab navigation.
- Check the temporary greeting, character-background switch, and mode launch
  paths when those surfaces change. Keep removed copy removed.
- Run checks appropriate to the edit, such as `node --check game-shell.js` and
  `node --test sky-time.test.js` for sky logic. Documentation-only changes need
  link/content review, not gameplay tests. Report what was actually checked and
  any unavailable visual verification.
