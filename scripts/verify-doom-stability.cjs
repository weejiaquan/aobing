/* Gameplay/host regression, in one visible Chrome window. NODE_PATH as for
   verify-doom.cjs. God mode and map warps are test inputs, not product changes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const results = [];
  try {
    const p = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' });
    const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('crash', () => errors.push('Browser crashed'));
    await p.goto(process.env.DOS_TEST_URL || 'http://127.0.0.1:8765/');
    await p.waitForFunction(() => window.DoomGame && window.__aobingAppReady);
    await p.click('#boot-start'); await p.click('#hub-launch'); await p.click('[data-launch-mode=doom]');
    await p.evaluate(() => {
      window.nativeErrors = []; window.frameTimes = []; window.audioSamples = 0;
      const start = DosRuntime.Runtime.prototype.start;
      DosRuntime.Runtime.prototype.start = async function (...args) {
        window.rt = this; const result = await start.apply(this, args);
        this.ci.events().onFrame(() => { if (frameTimes.length === 1024) frameTimes.shift(); frameTimes.push(performance.now()); });
        this.ci.events().onSoundPush(samples => { audioSamples += samples.length; });
        this.ci.events().onStdout(s => { if (DosRuntime.isFatalOutput(s)) nativeErrors.push(s); });
        this.ci.events().onMessage((type, s) => { if (/Illegal call|\[panic\]/.test(s)) nativeErrors.push(s); });
        return result;
      };
    });
    await p.click('#dos-play-free'); await p.waitForSelector('#dos-panel[data-state=paused]');
    await p.click('#dos-resume'); await p.waitForTimeout(12000);
    for (let i=0;i<4;i++) { await p.keyboard.press('Enter', {delay:90}); await p.waitForTimeout(300); }
    await p.waitForTimeout(7000);
    const maps = process.env.DOS_STABILITY_MAPS === 'none' ? [] : ['11', '12', '13'];
    for (const map of maps) {
      if (map !== '11') { await p.keyboard.type('idclev' + map, {delay:90}); await p.waitForTimeout(8000); }
      await p.keyboard.type('iddqd', {delay:90}); await p.keyboard.type('idkfa', {delay:90});
      await p.click('#dos-canvas'); await p.waitForFunction(() => !!document.pointerLockElement);
      const began = Date.now(); const audioStart = await p.evaluate(() => audioSamples);
      await p.keyboard.down('Space');
      for (let i=0;i<9;i++) {
        // Walk, turn, strafe, shoot and use doors. Alternate smooth movement
        // with bursts of high-polling input through the actual mouse handler.
        const move = i % 3 === 2 ? 'd' : 'w';
        await p.keyboard.down(move); await p.waitForTimeout(1800); await p.keyboard.up(move);
        await p.keyboard.press('e', {delay:90});
        await p.evaluate(i => { window.turnTimer = setInterval(() => {
          for (let n=0;n<8;n++) document.dispatchEvent(new MouseEvent('mousemove', {movementX: (i % 2 ? -1 : 1)}));
        }, 4); }, i);
        await p.waitForTimeout(1800); await p.evaluate(() => clearInterval(turnTimer));
        assert.equal(await p.locator('#dos-panel').getAttribute('data-state'), 'playing');
        assert.deepEqual(await p.evaluate(() => nativeErrors), []);
      }
      await p.keyboard.up('Space');
      const elapsed = (Date.now() - began) / 1000;
      const audioDuration = (await p.evaluate(() => audioSamples) - audioStart) / 44100;
      assert.ok(Math.abs(audioDuration - elapsed) < 1, 'Audio and game wall time must stay aligned');
      await p.screenshot({path: `_localmod/doom/stability-${map}.png`});
      // Holding movement during lost capture must release it and show Pause.
      await p.keyboard.down('w'); await p.evaluate(() => document.exitPointerLock());
      await p.waitForSelector('#dos-panel[data-state=paused]');
      assert.equal(await p.locator('#dos-overlay').isVisible(), true);
      assert.equal(await p.evaluate(() => rt.held.size), 0);
      await p.keyboard.up('w'); await p.click('#dos-resume');
      await p.keyboard.down('ArrowRight'); await p.waitForTimeout(8000);
      const pacing = await p.evaluate(() => {
        const t=frameTimes.filter(t=>t>performance.now()-5000);
        const gaps=t.slice(1).map((v,i)=>v-t[i]).sort((a,b)=>a-b);
        return {fps:(t.length-1)*1000/(t.at(-1)-t[0]),p95:gaps[Math.floor(gaps.length*.95)]};
      });
      await p.keyboard.up('ArrowRight');
      assert.ok(pacing.fps > 40 && pacing.p95 < 60, 'Continuous-turn delivery must stay responsive');
      results.push({map,elapsed,audioDuration,pacing}); console.log('MAP PASS',results.at(-1));
    }
    // Failure is visible and recoverable rather than silently returning to setup.
    const closing = p.workers().map(worker => worker.waitForEvent('close', {timeout:5000}));
    await p.evaluate(() => rt.fail()); await p.waitForSelector('#dos-panel[data-state=error]');
    assert.ok((await p.locator('#dos-status').textContent()).includes('stopped unexpectedly'));
    await p.waitForFunction(() => rt.audio.state === 'closed');
    await Promise.all(closing);
    assert.equal(p.workers().length, 0);
    await p.click('#dos-retry'); await p.waitForSelector('#dos-panel[data-state=paused]');
    await p.click('#dos-end'); await p.waitForFunction(() => rt.audio.state === 'closed');
    assert.equal(p.workers().length, 0); assert.deepEqual(errors, []);
    console.log('PASS:', maps.length, 'maps; failure/retry and cleanup');
  } finally {
    fs.writeFileSync('_localmod/doom/' + (results.length ? 'stability-results.json' : 'stability-retry.json'), JSON.stringify(results, null, 2));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode=1; });
