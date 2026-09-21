/* Windows/Chrome memory regression check. Serve the repo, install Playwright
   separately and point NODE_PATH at its node_modules, as for verify-doom.cjs. */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const MiB = 1024 * 1024;

(async () => {
  if (process.platform !== 'win32') throw new Error('This check uses Windows process memory counters.');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' });
    const cdp = await browser.newBrowserCDPSession();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('crash', () => errors.push('Renderer crashed'));
    async function memoryMB() {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const ids = processInfo.filter(p => p.type === 'renderer').map(p => Number(p.id)).filter(Number.isInteger);
      assert.ok(ids.length, 'Test browser must have a renderer');
      // Only inspect renderer IDs belonging to this isolated test browser.
      const bytes = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-Process -Id ${ids.join(',')} -ErrorAction Stop | Measure-Object PrivateMemorySize64 -Sum | Select-Object -ExpandProperty Sum`
      ], { encoding: 'utf8', windowsHide: true });
      return Math.round(Number(bytes.trim()) / MiB);
    }
    await page.goto(process.env.DOS_TEST_URL || 'http://127.0.0.1:8765/');
    await page.waitForFunction(() => window.DoomGame && window.__aobingAppReady);
    await page.click('#boot-start'); await page.click('#hub-launch'); await page.click('[data-launch-mode=doom]');
    await page.evaluate(() => {
      const start = DosRuntime.Runtime.prototype.start;
      window.testFrameTimes = [];
      DosRuntime.Runtime.prototype.start = async function (...args) {
        window.testDos = this;
        const result = await start.apply(this, args);
        this.ci?.events().onFrame(() => {
          if (testFrameTimes.length === 512) testFrameTimes.shift();
          testFrameTimes.push(performance.now());
        });
        return result;
      };
    });
    await page.click('#dos-play-free'); await page.waitForSelector('#dos-panel[data-state=paused]');
    await page.click('#dos-resume'); await page.waitForTimeout(12000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter', { delay: 90 }); await page.waitForTimeout(300); }
    await page.keyboard.down('ArrowRight');
    // Exercise continuous sky updates in any timezone or time of day. This
    // previously retained gigabytes of renderer memory while Doom was playing.
    await page.evaluate(() => { GameShell.setSkyHour(18); GameShell.setSkyTour(true); });
    await page.waitForTimeout(15000);
    const samples = [await memoryMB()];
    console.log('Renderer memory MiB:', samples[0]);
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(15000);
      samples.push(await memoryMB());
      console.log('Renderer memory MiB:', samples.at(-1));
      assert.equal(await page.locator('#dos-panel').getAttribute('data-state'), 'playing');
      assert.ok(samples.at(-1) < samples[0] + 512, 'Renderer memory must not keep growing during sky updates');
    }
    assert.ok(samples.at(-1) < samples[0] + 256, 'Memory should settle rather than accumulate');
    const pacing = await page.evaluate(async () => {
      const times = testFrameTimes;
      const gaps = times.slice(1).map((time, i) => time - times[i]).sort((a, b) => a - b);
      const stats = await testDos.ci.asyncifyStats();
      return {
        updatesPerSecond: (times.length - 1) * 1000 / (times.at(-1) - times[0]),
        p95GapMs: gaps[Math.floor(gaps.length * .95)],
        autoCycles: stats.cpuMetrics.cpuAuto,
        cycles: stats.cpuMetrics.cpuMax,
      };
    });
    console.log('Pacing:', pacing);
    assert.equal(pacing.autoCycles, false, 'Game speed must not collapse through automatic cycle adjustment');
    assert.equal(pacing.cycles, 60000);
    assert.ok(pacing.updatesPerSecond >= 45 && pacing.p95GapMs < 50, 'Continuous-turn display delivery should be smooth on the test PC');
    await page.keyboard.up('ArrowRight');
    await page.click('#dos-end'); await page.waitForFunction(() => testDos.audio.state === 'closed');
    assert.equal(page.workers().length, 0);
    await page.evaluate(() => { GameShell.setSkyTour(false); GameShell.setSkyHour('auto'); });
    await page.click('#dos-back');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--sky-blend').trim()), '0s', 'Visible lobby sky must still animate');
    assert.deepEqual(errors, []);
    console.log('PASS: normal-motion gameplay, bounded renderer memory, cleanup and restored lobby sky');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
