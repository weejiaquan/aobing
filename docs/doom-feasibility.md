# Doom in the game library: feasibility

Investigated 2026-09-20. The owner subsequently approved implementation and a
foundation for additional DOS games. The implementation uses js-dos + FastDoom
with Freedoom and local IWAD import. See [the shipped integration](../games/dos/README.md)
and [current design contract](design-spec.md#doom-and-dos-games). The original
feasibility assessment below is retained as research, not the final engine choice.

## Recommendation

Add a seventh library entry using a self-hosted Doom engine compiled to
WebAssembly, loaded only after the player selects it. Prototype with
[Cloudflare's Chocolate Doom port](https://github.com/cloudflare/doom-wasm).
It already has browser canvas and WAD loading code and supports local play;
multiplayer infrastructure is unnecessary for the initial single-player mode.
Treat it as a source starting point, not a verified drop-in dependency.

Offer a clearly labeled Freedoom campaign plus local import of an owned Doom
IWAD. Freedoom uses different levels, monsters, art, and music; it must not be
presented as the original Doom campaign. If authentic Doom is the priority,
the initial release can instead require the player's own IWAD.

## Engine and game data

- [id Software's engine](https://github.com/id-Software/DOOM) is GPL-2.0.
  Its release does not include the commercial game data.
- [Freedoom](https://freedoom.github.io/about.html) provides independently made,
  freely redistributable game content. Retain its copyright, conditions,
  disclaimer, and credits as required by its
  [license](https://raw.githubusercontent.com/freedoom/freedoom/master/COPYING.adoc).
  Validate the selected release against the selected engine before bundling it.
- Do not bundle commercial DOOM.WAD or DOOM2.WAD. Local imports should stay on
  the player's device. Shareware has separate distribution terms; do not assume
  that a WAD copied from an online demo is freely licensed by the engine's GPL.
- Ship the engine's notices and corresponding source/build materials under its
  GPL terms. Pin upstream revisions and retain the exact build recipe and patches.

## Browser options

| Option | Fit for this project | Work still required |
| --- | --- | --- |
| [Chocolate Doom / doom-wasm](https://github.com/cloudflare/doom-wasm) | Preferred prototype: direct browser engine, local play, canvas and filesystem setup already demonstrated | Reproduce the Emscripten build; implement lifecycle, persistence, controls, and audio integration |
| [js-dos](https://js-dos.com/overview.html) | Alternative if the hub is likely to add several DOS games; supplies emulator/player infrastructure | Package a suitable executable and game data, adapt its player UI, verify cleanup and the chosen version's mobile behavior |

The inspected doom-wasm [startup example](https://github.com/cloudflare/doom-wasm/blob/main/src/index.html)
loads an IWAD and configuration into Emscripten's filesystem before starting.
It explicitly disables music with `-nomusic`; music support must be verified,
not inferred from the demo. Its build uses Emscripten and autotools.
The inspected js-dos [package metadata](https://github.com/caiiiycuk/js-dos/blob/8.xx/package.json)
declares GPL-2.0, not MIT. Neither option licenses the original game assets.

## Integration map

| Existing file | Proposed change |
| --- | --- |
| `index.html` | Add `data-launch-mode="doom"` card, seventh-game count, and a dedicated game host |
| `game-shell.js` | Reuse the existing `aobinglaunch` dispatch; connect library opening/closing to game pause/resume |
| `app.js` | Extend both mode allowlists and `applyMode`; wire `DoomGame.init/open/close`, keyboard ownership, settings, BGM, and background performance handling |
| New `doom-ui.js` / `doom-ui.css` | Own loading, retry, controls, local WAD selection, focus, fullscreen, and runtime lifecycle; reuse shell colors and panel styling |
| New `games/doom/` | Keep pinned engine files, build/source materials, and notices separate from application logic; consider a same-origin frame to isolate engine globals and input |
| `i18n.js` / `i18n.test.js` | Translate all new shell copy in eight languages; add the new UI file to the test's explicit source scan |
| `docs/design-spec.md` | Record the seventh game and final presentation decisions when implementation direction is accepted |

The library is already data-driven at the button/event layer, but `app.js`
explicitly allows only six modes. Adding a card alone will not launch Doom.
Keep the persistent Shop control and existing games' navigation intact.

## Prototype acceptance checks

1. Build and boot a pinned engine with a pinned Freedoom release; test movement,
   firing, doors, map transitions, sound, and any advertised music support.
2. Serve runtime and data locally from the site's origin. Confirm that initial
   hub loading makes no Doom downloads and that failure offers a usable retry.
3. Pause simulation and audio on library/settings/shop opening, focus loss, and
   page hiding. Clear held keys, release pointer lock, and require deliberate
   input to resume. Keep Escape and the return-to-library control accessible.
4. Switch repeatedly between Doom and existing games, including switching during
   loading. Verify no orphaned audio, workers, input handlers, or late launches.
5. Persist saves/config locally and isolate saves by IWAD identity; verify reload
   and storage failure behavior. Do not promise cloud saves in the initial scope.
6. Check desktop, narrow mobile, short landscape, keyboard access, day/night
   styling, reduced motion, and existing mode regressions. Mobile controls need
   an explicit implementation and test, not merely a responsive canvas.
7. Test the actual Discord Activity separately. The repository's
   [Activity guide](discord-activity.md) documents proxy and CSP restrictions;
   same-origin assets avoid new third-party mappings but do not prove WASM,
   pointer lock, fullscreen, storage, or nested-frame permissions will work.
   Prefer a single-threaded build without a cross-origin-isolation requirement.

The first engineering milestone is a standalone local engine prototype with
working lifecycle and save handling. Integrate the library card after that
prototype passes. Download size, runtime performance, build reproducibility,
and Discord compatibility remain unmeasured.
