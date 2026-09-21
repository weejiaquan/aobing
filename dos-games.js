/* Add future DOS games here with their own licensed bundle, startup and save ID. */
window.DosGames = Object.freeze({
  doom: {
    id: 'doom', contentId: 'freedoom-0.13.0-phase1', saveVersion: 'fastdoom-1.3.0', filename: 'FREEDM1.WAD',
    engine: 'games/dos/doom-engine.zip?v=planes-1', content: 'games/dos/freedoom.zip',
    // Apply to existing saved configs too: Ctrl+W / Ctrl+Shift+W close Chrome.
    configMigrations: { 'DEFAULT.CFG': 'AOBING.CFG' },
    configOverrides: { 'AOBING.CFG': { key_fire: 57, key_use: 18 } },
    // Used when no saved CFG exists; host overrides are applied before boot.
    configDefaults: { 'AOBING.CFG': `snd_musicdevice 3
snd_sfxdevice 3
sfx_volume 10
music_volume 7
show_messages 1
screenblocks 10
use_mouse 1
mouse_sensitivity 5
key_up 17
key_down 31
key_strafeleft 30
key_straferight 32
key_fire 57
key_use 18
` },
    // Mode 13h + interpolation improve pacing. Fixed cycles prevent DOSBox's
    // speed estimator from dropping to a crawl after browser scheduling stalls.
    config: `[sdl]
autolock=false
[dosbox]
memsize=32
[render]
frameskip=0
[cpu]
core=auto
cycles=fixed 60000
[mixer]
rate=44100
blocksize=1024
prebuffer=20
[sblaster]
sbtype=sb16
sbbase=220
irq=7
dma=1
hdma=5
oplmode=auto
[autoexec]
@echo off
mount c .
c:
FDOOM13H.EXE -uncapped -iwad {iwad} -config AOBING.CFG
exit
`
  }
});
