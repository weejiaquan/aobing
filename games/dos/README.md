# DOS games

Doom is the first entry in a reusable, self-hosted DOS player. The library card
opens a native Aobing launcher with Freedoom: Phase 1 or local Doom IWAD import.
The runtime and campaign download only after Play (about 12 MB decimal total).
No game files or saves are uploaded. Save with the game's F2 menu and load with
F3. Browser IndexedDB stores only `.dsg` saves and `.cfg` configuration files,
separated by engine version and the SHA-256 identity of imported IWADs.
An imported IWAD must be selected again after leaving the mode/reloading.

## Pinned components and source

| Component | Version / revision | License | Local corresponding source |
| --- | --- | --- | --- |
| [js-dos emulators](https://github.com/js-dos/emulators) | 8.4.2, `5f4eea600b0623b4621800d64372d837e8680579` | [GPL-2.0](licenses/emulators-GPL-2.0.txt) | [emulators source](sources/emulators-8.4.2.tar.gz) |
| [js-dos DOSBox](https://github.com/js-dos/dosbox) | `528578d5a6f76afd4d5ef4e722b5670826f1183a` | GPL-2.0 | [DOSBox source](sources/dosbox-source.tar.gz) |
| [FastDoom](https://github.com/viti95/FastDoom/releases/tag/1.3.0) | 1.3.0-aobing1; patched `FDOOM13H.EXE` | [GPL-2.0](licenses/fastdoom-GPL-2.0.txt) | [Complete patched source and build files](sources/fastdoom-1.3.0-aobing1.tar.gz), [original source](sources/fastdoom-1.3.0.tar.gz) |
| [Freedoom](https://github.com/freedoom/freedoom/releases/tag/v0.13.0) | 0.13.0 Phase 1, distributed in FreeDOS package 20250409.9 | [BSD-3-Clause](licenses/freedoom-BSD.txt) | [Upstream source](https://github.com/freedoom/freedoom/tree/v0.13.0), [credits](licenses/freedoom-credits.txt) |

The WAD named `DOOM.WAD` **inside the FreeDOS package** is Freedoom 0.13.0,
not the proprietary id Software WAD. It is packaged here as `FREEDM1.WAD` for
FastDoom's game identification. No proprietary IWAD is distributed.

The Mode 13h renderer uses a RAM framebuffer instead of the original Mode Y
planar video path. `-uncapped` enables frame interpolation above the old 35 FPS
cap. Fixed 60,000 DOSBox cycles avoid automatic speed collapses after stalls.
A continuous-turn Chrome test on the development PC delivered about 66 canvas
updates/second, with its in-game FPS display above 35; this is not a guarantee
for every map, browser or device. The same 1.3.0 save namespace is retained.
The bundle also retains the unmodified `FDOOM.EXE` compatibility entry so an
already-open launcher from before the renderer update can still start a game.
Do not remove legacy executable paths while older pages may still request them.

`doom-engine.zip` contains the patched executable, its DATA/TEXT/LEVELS support
files and README, plus our `DEFAULT.CFG` and modification notice `AOBING.TXT`. Configuration selects Sound Blaster
music/SFX, a full-width status bar and native WASD movement. Native bindings
preserve normal letter entry in save names; the host does not remap letters.
Space fires and E uses. Ctrl is deliberately not a gameplay modifier: firing
while moving with the former Ctrl/W bindings can invoke Chrome's close-tab shortcut
(Ctrl+Shift+W closes the window when running). Existing saved `DEFAULT.CFG` files
receive the new fire/use bindings on launch without deleting saved games.
Freedoom contains different art, music, enemies and maps from original Doom.

## Reproduce or update

Run `python scripts/vendor-dos.py` from the repository. It downloads pinned
archives, checks release hashes, constructs deterministic ZIPs and writes
[SHA-256 checksums](checksums.json). The FreeDOS `latest` URL is guarded by its
exact archive checksum; if it changes, use the recorded package version rather
than silently accepting a replacement. No upstream archive is unpacked to disk.

The Aobing patch corrects `R_FindPlane`: upstream compares an un-interpolated
height against stored interpolated heights, including a nonzero sky height.
Repeated references to the same plane therefore allocate duplicates. Both
allocation paths previously wrote beyond a fixed 128-plane array without a
check. The patch normalizes sky height and interpolates ordinary heights before
lookup, raises capacity to 1024, and guards both allocation paths. Normal game
rules and save layout are unchanged. An exhausted limit now reports a fatal
error instead of corrupting memory. The recorded user's DOS/32A exception is
consistent with memory corruption; the exact original input sequence was not
recorded and has not been replayed.

`python scripts/build-fastdoom.py` performs a clean Docker build with a pinned
Open Watcom snapshot and checksummed toolchain, then packages the modified
binary and its full corresponding source. It needs about 150 MB of toolchain
downloads; all intermediate files stay in `_localmod/doom/fastdoom-rebuild`.
Use a fresh output directory for subsequent builds. `vendor-dos.py` verifies
the packaged executable's SHA-256 before including it in the runtime bundle.
The source archive's `NOTICE.txt` also documents a standalone build.

Run `python3 scripts/test-fastdoom-planes.py` under Linux/WSL with a C compiler.
It compiles the actual extracted upstream and patched lookup functions: the
original fails plane reuse, while the patch passes sky, moving-sector, distinct
surface, capped-rendering and both capacity-guard checks.

The emulator binaries are copied unchanged from npm, not rebuilt locally.
To rebuild them, unpack the emulators source and place the DOSBox source at
`native/dosbox`; see the included Dockerfile, CMakeLists and gulp build tasks.
Other upstream build targets require their own recorded submodules. Only the
DOSBox backend is shipped here. FastDoom's archive includes its OpenWatcom build
scripts and build documentation. Preserve notices, corresponding source and
build files when changing or redistributing these components.

## Application integration

**Remap controls** in the Doom header edits keyboard and mouse bindings. Save
applies them to the next game session and persists them in this browser. Opening
the dialog pauses gameplay. Reset changes the draft until Save; Cancel discards
it. Menu keys, weapon digits and Ctrl/Alt/Meta are reserved. Native config bindings
keep save-name typing intact; mouse and touch follow the active session's keys.
`dos-bindings.js` validates assignments and compiles native DOS scan codes.
The host supplies `AOBING.CFG`, migrating older saved `DEFAULT.CFG` settings.
This filename is absent from the bundled archive: js-dos extracts archives after
receiving loose startup files, so a bundled file would overwrite custom settings.
Run `node scripts/verify-doom-bindings.cjs` for native bindings, menu/save-name
typing, mouse/touch mapping, persistence, draft cancellation and responsive UI.

- `dos-games.js` declares bundle URLs, engine/save version, IWAD name and startup.
- `dos-runtime.js` owns the worker, canvas output, sound, input and local saves.
  js-dos `onSoundPush` supplies mono Float32 samples at `soundFrequency()`.
  Preserve every sample in a one-channel Web Audio buffer and schedule chunks
  contiguously, with 40 ms prebuffering at startup or after an underrun.
  Treating this stream as stereo halves each chunk's duration and produces
  pitched-up fragments separated by silence. `dos-audio.test.js` covers the
  sample layout, duration, scheduling and bounded queue.
  It uses js-dos's public `backend`/transport API with a same-origin worker and
  compiled WebAssembly, avoiding the stock factory's eval and blob URL loader.
  Sleep replies yield through a 1 ms timer instead of continuously exchanging
  messages until DOSBox's sleep deadline. Pending replies are cleared on exit.
  Mouse motion is merged once per display frame with bounded capture jumps;
  pausing discards pending movement. DOS/32A exception dumps, explicit native
  capacity failures and emulator panics show a translated Retry state and free
  the worker/audio instead of silently looking like a normal quit.
- `dos-ui.js` owns loading, retry, mode lifecycle, focus, pause, menus and controls.
- `dos-ui.css`, `index.html` and `i18n.js` provide the translated game shell.
- `app.js` routes the seventh mode and handles keyboard ownership/background BGM.

To add another DOS game, supply a licensed executable/content bundle and registry
entry. Generalize the current Doom launcher's content selection, declare that
game's controls and save-file patterns, add a library route, and test its startup,
pause, saves and exit. `.jsdos` uploads and additional games are not shipped yet.

## Verification and limits

Run `node --test dos-runtime.test.js i18n.test.js` and the existing repository
tests. For the optional browser smoke test, install Playwright outside this repo,
point `NODE_PATH` to its `node_modules`, serve the repository on port 8765, extract
`FREEDM1.WAD` from `freedoom.zip` to `_localmod/doom/import.wad`, and run
`node scripts/verify-doom.cjs` (or set `DOS_TEST_URL` for another address).
Optionally set `DOS_OLD_ENGINE_URL` to an archived Mode Y bundle URL to create
the initial save with the previous executable before restoring it with Mode 13h.
Set `DOS_LEGACY_LAUNCHER=1` instead to check an old launch command against the
currently shipped bundle, followed by the current launcher after reload.
Browser checks cover launching, keyboard movement and firing, native save
and load across sessions, local import using a Freedoom fixture, modal pause,
switching games, cancellation, failed download retry, and responsive layouts.
The smoke test uses normal motion. For the Windows/Chrome memory regression,
run `node scripts/verify-doom-performance.cjs` with the same setup. It runs
full-HD gameplay with continuous sky updates for over a minute and checks that
renderer private memory settles, then verifies cleanup and restored lobby motion.
It also checks continuous-turn frame delivery and the fixed emulator cycle rate.
`node scripts/verify-doom-stability.cjs` exercises three maps in visible Chrome,
with movement, firing, use, rapid mouse input, lost capture/resume, synchronized
audio duration, explicit failure/retry and cleanup. God mode and map warps are
test inputs only. Frame delivery is measured during continuous turning, since
unchanged views do not generate new canvas updates.
`body.music-mode` disables interpolation of the covered sky's inherited CSS
properties while keeping clock/tour values current. Without this, normal-motion
Chrome tests accumulated over 9 GB and DOSBox's adaptive cycles collapsed during
stalls; short tests with reduced motion masked the issue.
The DOS game's own menus/artwork retain the engine's original language; Aobing's
launcher, instructions and errors are translated into all eight site languages.

FastDoom documents experimental Freedoom support. Gameplay inputs on the first
three maps and the save/load path are tested; all four episodes and all original commercial IWAD editions
have not been exhaustively played. Desktop Chromium and emulated mobile layouts
are tested, not physical touch devices or every browser. Actual Discord Activity
CSP and platform permissions still need testing in Discord. Same-origin assets
and a single-threaded WASM build avoid additional CDN/proxy mappings and shared
memory requirements, but do not establish Discord compatibility by themselves.
