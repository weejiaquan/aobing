# Aobing IT! design specification

Last updated: 2026-10-06. This is the current design contract for the game shell,
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
- The sky is a **player-facing setting**, not a hidden dev control. Settings →
  Sound & atmosphere carries a slider over the whole day (0–24h, 15-minute steps)
  so any mixture between stages is reachable, not just four fixed looks. The four
  art-directed stages are its **checkpoints**: tick marks and Sunrise / Day /
  Sunset / Night labels, positioned from `STAGE_HOURS` so marks and presets cannot
  drift apart. Below it sits a live readout of source, time, and phase, and a
  **Device time** switch that hands the sky back to the wall clock; turning it off
  keeps the sky that is on screen. Scrubbing follows the thumb immediately and
  saves on release. The choice persists as `skyHour` (`'auto'` or an hour) and
  resets to Device time with defaults. Developers can still preview `?hour=18.55`;
  that preview wins until the player moves the slider.
- **Sky tour** is a switch below the slider: it sweeps the slider continuously
  through a whole day, one minute per cycle, starting from the sky already showing
  and never hopping between stages. Scrubbing ends the tour, and stopping it keeps
  the sky the sweep reached (rounded to the slider's step so thumb and sky agree).
  The sweep is pure logic in `sky-time.js` (`getTourHour`, `STAGE_HOURS`,
  `TOUR_MS`), not timing buried in the shell; the shell only re-renders on a tick.
- The sky never cuts between looks. `--sky-daylight`, `--sky-stars`,
  `--sky-warmth`, `--sky-warm-color`, and the sun position are registered with
  `@property` so they can be transitioned, and `game-shell.js` picks the blend per
  change through `body[data-sky-blend]`: none on first paint and while scrubbing
  (the sky must track the thumb), the full clock tick (30s) for the wall clock so
  the sky drifts continuously instead of stepping, 2.5s for an hour the player
  set, and one sweep tick (0.25s) during the sky tour. Individual sky layers must
  not re-add their own opacity transitions on top of this.
- While an immersive game covers the lobby (`body.music-mode`), set the sky
  blend duration to zero. Keep clock/tour values and theme updates current, but
  avoid continuously interpolating inherited sky properties through gameplay
  canvases. Restore the normal blend on return to the visible lobby. Normal-motion
  Chrome testing exposed runaway renderer memory when these hidden transitions
  continued; reduced-motion-only tests do not cover this failure.
- Wall-clock sky state stays a continuous function of the local time across the
  art-directed windows (sunrise 05:00–08:00, sunset 17:00–20:00), so arriving
  mid-window lands mid-transition — 18:33 sits at roughly two thirds of the
  sunset. Do not compress those ramps into short staged switches.
- The day/night **UI theme** still flips at the phase boundary (20:00 / 05:00),
  crossfading its colors over 0.8s. Do not interpolate panel text and surface
  colors continuously: a light-on-dark and dark-on-light pair collapses to
  unreadable mid-blend.

See [assets/sky-sources.md](../assets/sky-sources.md) for the art inventory and
reference provenance.

## Boot and motion

The sequence is: train arrives from the left, idles behind the logo, accelerates
off the right when the player enters, then a camera push reveals the game.

Exception approved for Discord game commands: `/launch osu` and `/launch mania`
resolve their server-authenticated destination while loading, then reveal that
game's song selection directly, without showing Clicker or requiring ENTER GAME.
The normal web/default entry keeps the train sequence. A chart still requires
an explicit selection click to prepare/unlock audio. Commands received during an
active round wait until the results/menu before switching games.

Discord game launches also leave a persistent Kei channel card with current
Activity participants and a Join action. Ended sessions stay visible with joining
disabled. Score posts use a compact illustrated embed: mapset cover when available,
Aobing thumbnail, actual judgement counts, score, accuracy, combo and personal-best
comparison. Standard may show its existing result grade. Do not invent pp, star
difficulty, official ranking or other unavailable stats. Presence describes the
Activity roster; it must not imply that everyone has joined the same match.

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

## Kei Discord page

- The Discord quiz page at `discord/index.html` opens with a Kei-specific intro
  layered over its existing animated Spine scene. The intro shows **KEI** and
  **ケイ**, with a hand-drawn SVG of Kei's halo behind the title, echoing the
  homepage's crisp vector logo treatment. Use `discord/assets/kei-halo.svg`,
  referenced from the isolated [wiki halo image](https://bluearchive.fandom.com/wiki/File:Kei_Halo.png)
  and checked against the [character portrait](https://bluearchive.wikiru.jp/?%E3%82%B1%E3%82%A4).
  Preserve the overlapping square frames, small upper-left block, stepped crown,
  upright orientation, and pink color. Do not restore the atlas crop or substitute
  circular rings. The halo floats gently without rotating, with a static soft
  glow and a separate entrance reveal; reduced motion disables both animations.
- Use Kei's white, soft coral/pink, and warm plum palette. Keep the character
  visible through the intro, and echo the home page's word reveal, restrained
  idle float, and short camera-push departure. The quiz should feel playful and
  approachable: rounded controls, soft light panels, and simple friendly type.
  Avoid sharp asymmetric borders, heavy slanted display type, and interface
  labels that make the page feel too severe for a quiz.
- Enter reveals the existing interactive Kei scene and a restyled Start Quiz
  card. Keep the intro
  markup, styles, and transition in `discord/index.html`, `discord/kei-ui.css`,
  and `discord/kei-ui.js`, separate from the quiz logic.
- Honor reduced motion, keep the intro as the active keyboard surface until
  Enter, and review desktop, narrow mobile, and short landscape layouts.
- Carry one clean, slightly rounded font stack (`--kei-font`) through the timer,
  loading screen, minimized quiz bar, settings, stats, and results. Do not restore
  Gaegu / Patrick Hand or neon orange/green feedback. Use tabular numerals for
  counters; the headpat HUD is a small translucent card beside the character,
  with `0.0 / 5s` and five square markers. On press, show the HUD and highlight
  the active marker immediately. Use elapsed time and animation-frame updates to
  fill each square continuously; display tenths without rounding up to completion.
  A short release leaves its fractional progress visible for 700 ms, then clears;
  a new hold starts at zero. Completion still requires one uninterrupted five-second
  hold and keeps the full receipt visible for 600 ms before advancing once. Cancel
  active holds on release outside the canvas, touch cancellation, blur, or hiding
  the page. Reduced motion retains this essential progress feedback.
- Kei's voice is composed, precise, and a little prickly, with reluctant warmth.
  Prefer dry observations and brief affectionate moments over constant shouting,
  stuttering, insults, or repeated "baka". Questions retain their subjects and
  answers. All five steps remain required. A wrong answer gives a clue and retries
  the current step, keeping earlier progress. The owner explicitly wants the
  **impossible-game tricks preserved**: a genuinely small answer and a runaway
  button that jumps away five times, rather than cosmetic nudges. Tiny text and a
  small button are intentional; keep a 44px minimum touch height on coarse pointers
  and normal keyboard focus. The runaway floats above the other answers and jumps
  to random positions anywhere in the answer area, intentionally overlapping the
  decoys. Do not confine it to fixed landing spots, corners, or a separate lane.
  Keep its whole target within the card and avoid landing under the triggering
  pointer; preserve the original grid slot so decoys do not reflow. Touch taps
  trigger escapes; keyboard and reduced motion may answer without
  chasing. Usability improvements must preserve this mischievous game identity.
- The headpat step requires pressing and holding directly on Kei's head in the
  character scene. The owner explicitly rejected the hold-to-pat button because
  it removes the game interaction: do not restore a separate headpat button or
  generic hold shortcut. Preserve the smooth fractional timer, five-second hold,
  interruption handling, and mouse/touch support. The voice step requires tapping
  Kei directly, with a three-second listening step. The owner also rejected the
  Hear Kei button: do not add separate shortcut buttons for either character
  interaction. Shift focus to the new question or result.
- After all five steps, restore Kei's five-part reluctant invite exchange, gradually
  warming from "Hold on" to "You can stay". This is part of the playful game, not
  extra bot verification. A separate final Join click opens the invitation. Guard duplicate completions and stale
  answer callbacks, and keep Join disabled until all steps finish in the normal
  UI flow. Invite configuration failures display a readable message.
- The owner uses this page as the Discord entry point and a bot filter. The current
  GitHub Pages deployment injects a Base64 invite into public JavaScript, so the
  quiz is only a casual obstacle, not a security boundary. Client-side timing,
  answer state, and obfuscation cannot secure that invite. Effective enforcement
  requires server-side challenge verification and invite delivery; do not describe
  the usability pass as adding that protection or silently weaken required steps.
- Echo the halo in the loading artwork, small card ornament, segmented progress,
  and restrained square confetti. Pair white surfaces and plum text with charcoal
  utility panels and pink accents. Motion uses quick answer transitions, a small
  mistake nudge, and a softer success settle. Reduced motion removes these effects,
  confetti, and screen flashes without changing the quiz's interaction rules.
  In short landscape windows, place the quiz card on the left with internal
  scrolling so Kei remains visible on the right; narrow portrait keeps the card
  at the bottom and utility panels below their buttons.

## Lobby, game library, and settings

### Gameplay focus and shared UI motion

- Library and Shop must disappear from pointer hit testing and keyboard navigation
  during Standard, Mania and Diva rounds/calibration, including paused rounds.
  They return in song selection and results, using compact secondary buttons in
  immersive modes. Doom hides those global buttons while playing; its own pause
  and navigation controls remain available. Fishing retains its compact Library
  and Shop controls. This supersedes showing the Shop chip during active rhythm
  play; its identity and direct-to-shop behavior remain unchanged elsewhere.
- Treat transitions as part of the game presentation. Use short menu crossfades,
  staggered library/window content, responsive hover/press feedback, native-dialog
  entry and exit, and a longer result reveal with a grade settle and staged stats.
  Typing results and Doom overlays share the same motion language. Preserve the
  existing boot, sky and Fishing scene animation direction.
- Gameplay starts immediately with unchanged canvas geometry, input and audio
  timing. Never transform the live canvas or cover early notes with a transition.
  On departure, the frozen outgoing screen may fade for 240ms, but is hidden from
  accessibility and inert immediately. Guard incoming menu clicks during the short
  crossfade so the final gameplay tap cannot activate Retry. Results receive focus
  on the screen itself, rather than a button that held keys could activate.
- `ui-motion.js` owns cancellable screen transitions; adapters only call its
  presentation hook. Cancel old animations/timers on rapid navigation, mode exit,
  page hiding and reduced-motion changes. No perpetual decorative frame loop.
  Pause only hidden lobby animation in immersive modes, not all site animations.
- Reduced motion skips decorative motion without delaying game or menu access.
  Results scroll at short viewport heights; secondary navigation has reserved
  space below results on desktop and mobile.

The owner selected the **game library as the reference for every UI surface**.
Use its large italic headings, small cyan section labels, subtle SVG halo backdrop,
spacious cards, fine borders, asymmetric corners, and blurred modal backdrop for
shop, settings, characters, rankings, statistics, profile, and confirmation dialogs.
Carry the same colors and controls into typing, fishing/Fishdex, and rhythm menus,
imports, customization, and results. Preserve gameplay canvas geometry and timing
except for the accepted Fishing and rhythm changes specified below.

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
- Standard's Multiplayer entry lives in its song-selection header and opens a
  matching native dialog. Preserve this entry when changing library navigation.
- Multiplayer uses inline lobby-name, password, visibility and room-code fields
  inside that dialog; avoid browser prompts, which are unreliable in the Discord
  iframe. Closing the dialog preserves a joined room. Leaving the room or changing
  game mode disconnects it; closing an unjoined browser releases its connection.
- A selected chart must be downloaded, verified and its audio prepared before the
  player can become Ready. Players can sit out a round. The host starts only when
  everyone is ready or sitting out. The same Discord Activity instance has an
  unlisted shared-room action using the existing authenticated connection.
- Standard multiplayer schedules a common audio start and uses manual play.
  Skip and quick restart are unavailable during the race. Pause, blur, hiding the
  tab or leaving forfeits that player's network result; local pause behavior is
  retained. The small standings overlay passes gameplay pointer input through;
  its lobby button appears after results. Use the existing panel colors and eight
  language dictionaries for multiplayer controls and status.
- Round points are the sum of the engine's 300/100/50 object judgements, ordered
  by points, accuracy, then maximum combo; forfeits sort last. This is a casual
  score race, with client-reported scores, rather than native osu! score-v1 or a
  server-validated ranking. Gameplay and network controllers stay separate.
- Panel windows close with their close button, Escape, or backdrop. Trap focus,
  make the background inert, and restore focus to the opener. After closing the
  shop, return focus to the dropdown control. Nested confirmations keep the
  parent window intact.
- Every user-visible string is translated. Add new copy as an `i18n.js` key in all
  supported languages and reference it with `data-i18n` / `data-i18n-attr`, or with
  `I18N.t()` for JS-rendered text; never put display text in CSS `content`. `i18n.js`
  loads before `game-shell.js` so the boot screen is already translated, and
  `i18n.test.js` fails if a key is referenced but missing or untranslated.
- Keep `.lobby-feature` hidden until the owner is ready to build it.
- The character speech bubble lives outside the animated character element so
  text does not inherit its bounce or image filters. Reserve the full line's size
  during typewriter reveal, avoid preserved markup whitespace, support night
  colors, and keep the bubble inside the viewport. Reduced motion shows the full
  line immediately. Display speech only in the clicker view.

- Keep the character central, profile toward the lower left, game launcher and
  Shop toward the lower right, and labeled utility controls along the
  bottom: Settings, Characters, Rankings, Statistics.
- Preserve the native game-library dialog and seven choices: Clicker, Typing,
  Fishing, Standard, Mania, Diva, and Doom. Reuse existing mode switching and settings.
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

### Doom and DOS games

- The owner approved adding Doom and a reusable foundation for more DOS games.
  Use the self-hosted js-dos emulator core with FastDoom and Freedoom: Phase 1.
  Use the Mode 13h executable, interpolated uncapped rendering, and fixed 60,000
  DOSBox cycles. Ship the Aobing renderer patch: sky/interpolated plane lookup
  must match stored heights, with checked plane allocation. Upstream 1.3.0's
  mismatched heights create duplicate planes and can overwrite memory.
  The previous planar renderer/35 FPS cap and automatic cycle
  adjustment produced poor pacing; preserve the save namespace across this
  graphics-only executable variant change.
  Keep the existing library's styling and the persistent Shop control.
- Doom opens a campaign picker: play the included, clearly named Freedoom campaign
  or choose a locally owned Doom / Doom II IWAD. Do not label Freedoom's content
  as the original Doom campaign. Imported WADs stay on the device and are not uploaded.
- Load the emulator and game content only after Play. Provide loading/error/retry
  feedback, an explicit Play / Resume action, fullscreen, game-menu access and a
  return to the lobby. Pause on Escape, lost focus, hidden page or modal opening;
  release held keys and pointer lock, and require an explicit resume.
  Combine mouse motion once per display frame, bound capture jumps, and discard
  pending motion on pause. Native engine failures must show an explicit error
  and Retry, release the worker/audio, and retain existing saves.
- Keep keyboard, mouse and visible touch controls available. WASD moves, arrows
  turn/navigate menus, Space fires, E uses, Enter selects, 1–7 select weapons,
  and F2/F3 save/load. Use native game bindings so save names accept normal letters.
  Avoid Ctrl for gameplay: Ctrl+W closes Chrome's tab and Ctrl+Shift+W closes its
  window. Migrate old fire/use config bindings while preserving saved games.
- Provide a native modal **Remap controls** dialog before and during play. Pause
  gameplay on opening and keep focus contained. Let players assign unique letter,
  arrow, Space or Shift keys to movement, turning, fire, use and run, and assign
  left/middle/right mouse buttons to fire, use or nothing. Reserve menu, weapon
  and browser modifier keys. Escape cancels key capture, then closes the dialog.
  Save bindings locally; Cancel discards the draft and Reset requires Save.
  Clearly state that changes apply next session. Compile bindings to native Doom
  config so menus and save-name typing retain normal keys; mouse/touch controls
  use the active session's bindings. Translate labels and validation feedback.
- In-game saves are local to the browser, separate from account/economy data and
  isolated by IWAD identity and engine version. Ending a session retains in-game
  saves, not an automatic snapshot of unsaved play. State this in the picker.
- All Aobing launcher copy uses the eight-language translation table. The DOS
  engine's native menus and game assets retain their original language.
- Keep reusable hosting in `dos-runtime.js`, game definitions in `dos-games.js`,
  and presentation in `dos-ui.js` / `dos-ui.css`. Vendor runtime/content plus
  licenses and corresponding engine sources in `games/dos/`; maintain its README,
  checksums and `scripts/vendor-dos.py`. Additional DOS games need their own
  licensed bundles, controls, save patterns and verification.

### Standard and Mania gameplay

The owner approved the October 2026 gameplay audit and implementation, including
logic changes. **osu!stable is the compatibility target**, rather than mixing
classic, ScoreV2 and custom long-note rules. This supersedes the earlier v1
decisions to ignore Mania SV and break combo on a 50. This remains a browser
implementation, not a claim of bit-for-bit osu! emulation or equivalent ranked
scores. Retain no-fail play and the existing library, imports and Multiplayer entry.

- `rhythm-core.js` owns audible-output clock mapping, timestamped cursor/button
  history, sample metadata, and continuous BPM/SV scroll distance. Use
  `getOutputTimestamp()` when available, with a refreshed audio-clock fallback;
  do not subtract output latency twice. Judge key events at their event timestamps.
  Input calibration affects judgement; the separate **Visual offset** setting
  affects drawing only. Calibration uses the same audible clock as gameplay.
- `rhythm-standard.js` owns stacking (including negative slider-tail stacks),
  slider checkpoints, aggregate slider accuracy and spinner helpers. Slider heads,
  ticks, repeats and tails increment combo individually; missed heads/ticks/repeats
  break combo, missed tails do not. Final slider accuracy does not add another
  combo. Check the legacy tail slightly early (36ms, protected by the midpoint),
  using cursor/key history at checkpoint time. A long frame must not substitute
  the latest cursor for every intervening checkpoint. Spinners require held input,
  use timestamped pointer samples and reject centre jitter. Their angular-speed
  cap is a browser approximation; native spinner inertia is not fully emulated.
- Standard renders follow points inside combo sets and arrows at upcoming slider
  reversals. Stack offsets apply to both hit testing and slider paths. Both mouse
  buttons are independent; mouse releases outside the canvas clear only that
  button. Coalesced pointer events feed motion history. Use the actual canvas
  backing/CSS ratio for stroke and cursor sizes, not uncapped device pixel ratio.
- `rhythm-mania.js` owns note ordering, classic tap windows and hold state. Each
  long note receives one accuracy judgement combining head and release errors.
  Late releases have real penalties; overholding past the late window misses.
  A dropped/missed hold can be picked up again, with its grade capped at 50.
  A successful 50 tap keeps combo. A press targets the oldest eligible lane head.
  Keep key repeat suppression and multi-pointer lane input.
- Mania uses integrated chart BPM/SV scrolling by default. **Constant scroll
  speed** is an explicit option. Appearance includes saved lane width, judgement
  position, upward scrolling and visual offset. Centre notes on their receptors.
  Keep all geometry valid at narrow widths and high DPR.
- Decode custom and imported beatmap samples before the lead-in. Preserve normal,
  soft and drum sets, timing-point volume/index, additions, custom filenames and
  slider-edge overrides through folder/OSZ imports, cache and chart transfer.
  The existing **Use map hitsounds** preference controls playback; unavailable
  samples fall back to the configured/synthesised sound. Previously cached maps
  require reimport to acquire samples their old records did not contain.
- Escape, blur, hidden-page and modal opening pause play and clear input. Provide
  a native modal with Resume, Retry and Back to songs. Resume has a one-second
  preparation interval during which players can re-hold active note keys. Stop
  and recreate the music source at the frozen audible position; never auto-resume
  on focus. Keep modal focus containment and all new copy translated into eight
  languages. Honor reduced motion for decorative judgement effects.
- New personal bests use the `classic-v2:` namespace. Keep old records intact;
  never compare the new slider/hold combo and accuracy rules against legacy PBs.
- `osustd.js` / `vsrg.js` remain browser adapters; `rhythm-ui.js` owns shared
  gameplay options and pause controls; `hitsound.js` owns sample decoding/playback.
  Load the shared modules before the adapters. Keep shell and economy untouched.

References: [Standard judgement](https://osu.ppy.sh/wiki/en/Gameplay/Judgement/osu!),
[Mania judgement](https://osu.ppy.sh/wiki/en/Gameplay/Judgement/osu!mania),
[map format](https://osu.ppy.sh/wiki/en/Client/File_formats/osu_(file_format)), and
[osu! stacking implementation](https://github.com/ppy/osu/blob/master/osu.Game.Rulesets.Osu/Beatmaps/OsuBeatmapProcessor.cs).
Tests in `rhythm-gameplay.test.js` cover timing, holds, sliders, stacking and scroll
distance; `rhythm-runtime.test.js` exercises actual adapters with mocked audio/DOM
at desktop, portrait, landscape and multiple DPRs. These do **not** establish
visual smoothness or physical audio latency. Interactive browser QA remains
required before describing those as verified.

### Fishing

- Fishing now carries the game library's visual language throughout the play
  screen, catch results, Fishdex, inventory, and specimen inspection. Use the shared
  `--ui-*` and `--hub-*` palette, italic display headings, cyan section labels,
  fine borders, and asymmetric corners; preserve the night theme.
- Fishing is a connected, animated game scene. Use the full viewport for the
  waterfront, with a perspective pier, Miyu, a bending rod, an attached line,
  traveling float, moving water, ripples, splashes, and underwater silhouettes.
  Small header navigation replaces the large title/collection cards. Contextual
  instructions and a single action control leave the scene clear while waiting.
- Flow: **hold to prepare → release to cast → watch the float → hook the bite →
  track the fish → land → reveal**. Cast strength changes the visible cast distance,
  not encounter odds. A tap/assistive activation still casts. Cast travel lasts
  0.8 seconds, landing 0.85 seconds, and a missed bite has a 1.1-second feedback beat.
  Successful catches have a one-second input guard, then casting becomes available
  again. The catch card has an independent four-second presentation lifetime:
  after the guard it becomes a compact, noninteractive receipt below the header
  and stays visible during the next cast. It fades over its last 0.6 seconds,
  then hides automatically (reduced motion skips fading). Cast input never clears
  this receipt. Show a next-cast countdown only during the one-second guard and
  discard held input; the next cast requires a fresh press. Pause both timers
  while a modal is open or the page is hidden. Escape results can retry directly;
  a new result replaces the previous receipt. Exiting clears pending presentation.
- The reel interaction is a prominent horizontal lane near the float: hold moves
  the capture zone right, release moves it left. Show the fish silhouette, zone
  boundaries, tracking feedback, startup grace, and labeled landing progress.
  Retain the existing fish behaviors, rarity difficulty, reward calculation and
  saves. Pay once on capture; landing and reveal never issue another reward.
- Drive the rod, line, float and landing from session phase/timer values. Keep
  motion continuous across phase boundaries; water and idle motion use a paused
  presentation clock. Use distinct synthesized cast, splash, bite and catch cues
  at the saved SFX volume, with audio unlocked by the player's gesture.
- Reveal catches as an illustrated card with animated fish artwork, size, grade,
  reward and discovery status. Keep the primary action and collection access
  available, including small portrait and short landscape windows. Library and
  Shop remain compact secondary controls at the bottom; Shop stays bottom-right.
- The owner rejected the procedural fish shape construction and requested generated
  game sprites. The first painted set was too realistic; the current direction is
  bright anime mobile-game item artwork with thin navy linework, soft cel shading,
  luminous cyan accents, simplified markings and expressive proportions. Use
  `assets/fish/anime-atlas-v1.png`. Keep species-specific anatomy and flowing fins;
  avoid both photorealistic skin texture and generic geometric bodies.
  Do not restore the vector body paths.
  All landing, catch, Fishdex and inspection artwork shares `fish-sprite.js`.
- The atlas supplies 20 source illustrations across 19 families (two Tropical
  designs). All 151 species use these family sprites with subtle colorway and
  shiny finishes. Preserve detailed shading and markings; avoid flat tint fills.
  Source rectangles and contour windows are individually measured so fins and
  tentacles are intact without neighboring specimens. Preserve the original
  alpha, aspect ratio, and small margins. Keep pale finishes readable on white
  cards. Version the sprite script URL in both game and preview on asset changes.
  Keep species IDs, rarity, rewards and saved specimens unchanged.
- Preload the atlas and redraw queued canvases after it loads; keep the small
  texture cache bounded. The owner approved the anime artwork and requested
  tweening / morph animation. Deform the original texture with a small continuous
  mesh: pin the face, flex tails/fins, pulse jellyfish bells with trailing tentacle
  motion, flap ray wings, ripple eel/dragon bodies, and move crab extremities.
  Keep amplitudes gentle and preserve recognizable anatomy and alpha edges.
  Sample the full texture inside each mesh triangle to avoid visible tile seams.
- Use a shared 30fps sprite clock for preview, caught collection tiles, catch
  results and inspection. Only visible sprites advance; pause covered catch
  cards / collection tiles and the hidden page. Stop registrations on close,
  re-render or removal. Unknown silhouettes remain still. Landing uses the
  scene's paused clock. Catch/inspection sprites have a short eased settle.
  Reduced motion draws the undeformed time-zero pose with no recurring sprite
  frame loop, and live preference changes take effect immediately. The gallery
  `fish-sprite-preview.html` shows all species (`?shiny=1` for shiny finishes).
  See `assets/fish/README.md` for generation provenance and the final prompt.
- Fishdex and specimen inspection are native modal dialogs with blurred
  backdrops, Escape, keyboard focus containment, and focus restoration. Inventory
  tiles are keyboard-operable buttons. Empty inventories and filters have useful
  translated messages, and the Fishdex displays discovery progress.
- Pause the fishing session while a modal is open or the page is hidden. Clear
  held input on blur; cancel an unfinished charge when focus is lost. Do not let
  collection navigation trigger casts. Keyboard, pointer and touch share the
  same press/hold/release contract; pointer capture prevents stuck holds.
- `fishing-session.js` owns flow timing and `fishing-scene.js` owns scene drawing.
  Keep UI controls in `fishing-ui.js` and styling in `fishing-ui.css`; collection
  browsing stays in `fishing-dex-ui.js`. New interface copy belongs in `i18n.js`
  for all eight languages. Reduced motion disables decorative waves, bobbing,
  particles, rotation and CSS reveals while preserving readable gameplay motion.

| File | Responsibility |
| --- | --- |
| `index.html` | Boot markup and inline halo/train SVG, lobby, library, settings controls |
| `game-shell.css` | Shell layout, theme, sky layers, responsive rules, CSS motion |
| `game-shell.js` | Boot timeline, library navigation including the typing submode view, sky clock/tour/blend, greeting dismissal |
| `ui-panels.css` | Shared library-inspired panel, control, collection, and game-menu styling; loads after legacy inline styles |
| `ui-panels.js` | Existing-panel focus/inert management, close controls, keyboard card interaction, accessible switch state |
| `fishing-ui.css` / `fishing-ui.js` / `fishing-dex-ui.js` | Fishing scenery and responsive chrome, phase prompts, catch presentation, and native collection/inspection dialogs |
| `fishing-scene.js` / `assets/fishing-shore.svg` | Animated canvas waterfront, pier, rod/line, float, splash and landing presentation |
| `sky-time.js` / `sky-time.test.js` | Pure hour-to-sky interpolation and its tests |
| `i18n.js` / `i18n.test.js` | Translation table for the eight supported languages, `[data-i18n]` application, and its coverage tests |
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
