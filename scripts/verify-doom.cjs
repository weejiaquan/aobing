/* Optional browser smoke test. Install Playwright separately, serve the repo,
   then run with NODE_PATH pointing to that installation's node_modules. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DOS_TEST_URL || 'http://127.0.0.1:8765/';
const output = '_localmod/doom';
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference', hasTouch: true });
    const page = await context.newPage();
    const press = page.keyboard.press.bind(page.keyboard);
    page.keyboard.press = (key, options = {}) => press(key, { delay: 90, ...options });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let gameRequests = 0;
    page.on('request', req => { if (req.url().includes('/games/dos/')) gameRequests++; });
    const ready = async () => {
      await page.waitForFunction(() => window.__aobingAppReady && window.DoomGame);
      await page.click('#boot-start');
    };
    const state = () => page.locator('#dos-panel').getAttribute('data-state');
    const paused = () => page.waitForSelector('#dos-panel[data-state="paused"]');
    const inspect = () => page.evaluate(() => {
      const start = DosRuntime.Runtime.prototype.start;
      DosRuntime.Runtime.prototype.start = async function (...args) {
        window.testDos = this; return start.apply(this, args);
      };
    });
    await page.goto(base); await ready();
    assert.equal(gameRequests, 0, 'Hub must not preload DOS binaries/data');
    await page.click('#hub-launch');
    assert.equal(await page.locator('#library-games .game-card').count(), 7);
    await page.screenshot({ path: output + '/library.png' });
    await page.click('[data-launch-mode="doom"]'); await inspect();
    // Optional migration check: create a save with the previous Mode Y engine,
    // then restore it using the shipped renderer after the page reload below.
    if (process.env.DOS_OLD_ENGINE_URL || process.env.DOS_LEGACY_LAUNCHER) await page.evaluate(url => {
      DosGames.doom.engine = url;
      DosGames.doom.config = DosGames.doom.config.replace('FDOOM13H.EXE', 'FDOOM.EXE').replace(' -uncapped', '');
    }, process.env.DOS_OLD_ENGINE_URL || 'games/dos/doom-engine.zip');
    await page.screenshot({ path: output + '/setup.png' });

    // A failed backend download must be recoverable without reloading the site.
    await page.route('**/engine/wdosbox.wasm', route => route.abort());
    await page.click('#dos-play-free'); await page.waitForSelector('#dos-panel[data-state="error"]');
    await page.unroute('**/engine/wdosbox.wasm');
    await page.click('#dos-retry'); await paused();
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--sky-blend').trim()), '0s');
    await page.click('#dos-resume'); await page.waitForTimeout(12000);
    // New game, episode, difficulty.
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(300); }
    // Normal-motion boot/renderer work can delay the DOS screen-melt transition.
    // Let it finish before testing gameplay or entering the native save menu.
    await page.waitForTimeout(7000);
    await page.keyboard.down('w'); await page.waitForTimeout(250); await page.keyboard.up('w');
    // Moving, running and firing must not require Chrome's Ctrl+W shortcut.
    await page.keyboard.down('w'); await page.keyboard.down('Shift'); await page.keyboard.down('Space');
    assert.equal(await page.evaluate(() => testDos.held.size), 3);
    await page.waitForTimeout(250);
    await page.keyboard.up('Space'); await page.keyboard.up('Shift'); await page.keyboard.up('w');
    assert.equal(page.isClosed(), false);
    await page.screenshot({ path: output + '/gameplay.png' });
    await page.keyboard.press('F2'); await page.waitForTimeout(1000); await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.type('AOBING TEST', { delay: 100 }); await page.keyboard.press('Enter');
    await page.waitForTimeout(800); await page.keyboard.press('Escape');
    assert.equal(await state(), 'paused');
    await page.evaluate(() => testDos.save());
    const files = await page.evaluate(async () => {
      await testDos.saveQueue; return DosRuntime.savePaths(await testDos.ci.fsTree());
    });
    assert.ok(files.some(file => /\.dsg$/i.test(file)), 'Native save file should exist');
    const savedBytes = await page.evaluate(async () => {
      await testDos.saveQueue;
      const paths = DosRuntime.savePaths(await testDos.ci.fsTree());
      return Array.from(await testDos.ci.fsReadFile(paths.find(path => /\.dsg$/i.test(path))));
    });
    assert.ok(Buffer.from(savedBytes).includes(Buffer.from('AOBING TEST')), 'WASD letters must remain typable in save names');
    await page.click('#dos-end'); await page.waitForFunction(() => testDos.audio.state === 'closed');

    // Reload the page: normal boot returns to the lobby; saves restore on Play.
    await page.reload(); await ready(); await inspect();
    await page.click('#hub-launch'); await page.click('[data-launch-mode="doom"]');
    await page.click('#dos-play-free'); await paused();
    const restored = await page.evaluate(async () => {
      await testDos.saveQueue; return DosRuntime.savePaths(await testDos.ci.fsTree());
    });
    assert.ok(restored.some(file => /\.dsg$/i.test(file)));
    await page.click('#dos-resume'); await page.waitForTimeout(12000);
    await page.keyboard.press('F3'); await page.waitForTimeout(800);
    await page.screenshot({ path: output + '/load-menu.png' });
    await page.keyboard.press('Enter'); await page.waitForTimeout(1200);
    await page.screenshot({ path: output + '/restored.png' });

    for (const button of ['#dos-settings', '#mode-chip', '#dos-library']) {
      await page.click(button); assert.equal(await state(), 'paused');
      await page.keyboard.press('Escape'); assert.equal(await state(), 'paused');
      await page.click('#dos-resume');
    }
    // Native Quit must also close the host, audio and worker.
    await page.keyboard.press('F10'); await page.keyboard.press('y');
    await page.waitForSelector('#dos-panel[data-state="setup"]');
    await page.waitForFunction(() => testDos.audio.state === 'closed');
    assert.equal(page.workers().length, 0);
    // Reject malformed uploads; import the freely licensed bundled IWAD as a fixture.
    await page.setInputFiles('#dos-wad', { name: 'bad.wad', mimeType: 'application/octet-stream', buffer: Buffer.from('PWAD') });
    assert.equal(await page.locator('#dos-play-wad').isDisabled(), true);
    await page.setInputFiles('#dos-wad', output + '/import.wad');
    await page.waitForFunction(() => !document.getElementById('dos-play-wad').disabled);
    let bundled = false;
    const onRequest = req => { if (req.url().endsWith('/freedoom.zip')) bundled = true; };
    page.on('request', onRequest);
    await page.click('#dos-play-wad'); await paused();
    assert.equal(bundled, false, 'Owned WAD path must not download bundled campaign');
    assert.match(await page.evaluate(() => testDos.saveKey), /:[a-f0-9]{64}$/);
    await page.click('#dos-resume'); await page.waitForTimeout(6500);
    // Touch/pointer controls share held input, including release/cancel.
    const touchButton = await page.locator('[data-dos-key="87"]').boundingBox();
    await page.touchscreen.tap(touchButton.x + touchButton.width / 2, touchButton.y + touchButton.height / 2);
    assert.equal(await page.evaluate(() => testDos.held.size), 0);
    await page.click('#dos-end'); await page.waitForFunction(() => testDos.audio.state === 'closed');
    page.off('request', onRequest);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { GameShell.setSkyHour(23); I18N.set('ja'); });
    await page.screenshot({ path: output + '/mobile-night-ja.png' });
    await page.locator('#dos-panel').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.screenshot({ path: output + '/mobile-bottom.png' });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.locator('#dos-panel').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: output + '/landscape.png' });
    assert.equal(await page.locator('#dos-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true);

    // Cancellation during a slow download must not open a late session.
    await page.route('**/freedoom.zip', async route => { await new Promise(resolve => setTimeout(resolve, 700)); await route.continue().catch(() => {}); });
    await page.click('#dos-play-free'); await page.click('#dos-back'); await page.waitForTimeout(1800);
    assert.equal(await page.locator('body').getAttribute('data-game-mode'), 'clicker');
    assert.equal(await page.locator('#dos-panel').isVisible(), false);
    assert.equal(await page.evaluate(() => testDos.audio.state), 'closed');
    assert.equal(page.workers().length, 0, 'No abandoned DOS workers');
    // Switching between immersive modes keeps the shared background paused.
    for (const mode of ['fishing', 'doom', 'diva', 'doom', 'vsrg', 'doom', 'osu', 'doom', 'clicker']) {
      await page.evaluate(mode => window.dispatchEvent(new CustomEvent('aobinglaunch', { detail: mode })), mode);
      assert.equal(await page.locator('body').getAttribute('data-game-mode'), mode);
      assert.equal(await page.locator('body').evaluate(el => el.classList.contains('music-mode')), mode !== 'clicker');
    }
    assert.deepEqual(errors, [], 'No application JavaScript errors');
    console.log('PASS: lazy launch, retry, gameplay, native saves/reload, import isolation, modal pause, touch release, layouts, cancellation and cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
