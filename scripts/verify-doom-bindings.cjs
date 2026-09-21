/* Optional real-browser binding test; use the same Playwright setup as verify-doom.cjs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const output = '_localmod/doom';
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    async function boot() {
      await page.waitForFunction(() => window.__aobingAppReady && window.DoomGame);
      await page.click('#boot-start'); await page.click('#hub-launch'); await page.click('[data-launch-mode="doom"]');
      await page.evaluate(() => {
        const start = DosRuntime.Runtime.prototype.start;
        DosRuntime.Runtime.prototype.start = function (...args) { window.testDos = this; return start.apply(this, args); };
      });
    }
    const bind = async (action, key) => { await page.click('#dos-bind-key-' + action); await page.keyboard.press(key); };
    const paused = () => page.waitForSelector('#dos-panel[data-state="paused"]');
    const cfg = () => page.evaluate(async () => new TextDecoder().decode(await testDos.ci.fsReadFile('AOBING.CFG')));
    await page.goto(process.env.DOS_TEST_URL || 'http://127.0.0.1:8765/'); await boot();
    await page.click('#dos-remap');
    await bind('fire', 'w'); assert.match(await page.textContent('#dos-binding-status'), /already assigned/);
    await page.keyboard.press('Control'); assert.match(await page.textContent('#dos-binding-status'), /reserved/);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#dos-controls-dialog').evaluate(e => e.open), true);
    await bind('fire', 'f'); await bind('forward', 'i');
    await page.selectOption('[data-dos-mouse="2"]', 'use');
    await page.screenshot({ path: output + '/bindings-desktop.png' });
    await page.click('#dos-bindings-save');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dos-remap');
    await page.click('#dos-remap'); await page.click('#dos-bindings-reset'); await page.click('#dos-bindings-cancel');
    await page.click('#dos-play-free'); await paused();
    assert.match(await cfg(), /^key_fire 33$/m); assert.match(await cfg(), /^key_up 23$/m);
    await page.click('#dos-resume'); await page.waitForTimeout(12000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter', { delay: 100 }); await page.waitForTimeout(300); }
    await page.waitForTimeout(7000);
    await page.keyboard.down('i'); await page.keyboard.down('f');
    assert.deepEqual(await page.evaluate(() => [...testDos.held.values()].sort()), [70, 73]);
    await page.keyboard.up('f'); await page.keyboard.up('i');
    await page.click('#dos-canvas'); await page.waitForFunction(() => document.pointerLockElement?.id === 'dos-canvas');
    await page.mouse.down(); assert.equal(await page.evaluate(() => testDos.held.get('mouse:0')), 70);
    await page.mouse.down({ button: 'right' }); assert.equal(await page.evaluate(() => testDos.held.get('mouse:2')), 69);
    await page.mouse.up({ button: 'right' });
    assert.equal(await page.evaluate(() => testDos.held.has('mouse:2')), false);
    assert.equal(await page.evaluate(() => testDos.held.get('mouse:0')), 70);
    await page.mouse.up();
    await page.evaluate(() => document.exitPointerLock()); await paused();
    await page.click('#dos-resume');
    const touch = page.locator('[data-dos-key="87"]'); assert.equal(await touch.textContent(), 'I');
    await touch.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch' });
    assert.equal(await page.evaluate(() => testDos.held.get('touch:1')), 73);
    await touch.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch' });
    // Save-name letters are forwarded literally even when assigned to gameplay.
    await page.keyboard.press('F2', { delay: 100 }); await page.waitForTimeout(800);
    await page.keyboard.press('Enter', { delay: 100 }); await page.waitForTimeout(400);
    await page.keyboard.type('FIRE INPUT', { delay: 100 }); await page.keyboard.press('Enter', { delay: 100 });
    await page.waitForTimeout(800); await page.keyboard.press('Escape'); await paused();
    await page.evaluate(() => testDos.save());
    const saved = await page.evaluate(async () => {
      await testDos.saveQueue; const paths = DosRuntime.savePaths(await testDos.ci.fsTree());
      return Array.from(await testDos.ci.fsReadFile(paths.find(p => /\.dsg$/i.test(p))));
    });
    assert.ok(Buffer.from(saved).includes(Buffer.from('FIRE INPUT')));
    await page.click('#dos-resume'); await page.click('#dos-remap'); await paused();
    assert.equal(await page.evaluate(() => testDos.held.size), 0);
    await bind('fire', 'g'); await page.click('#dos-bindings-save');
    assert.match(await page.textContent('#dos-binding-summary'), /Fire: F/);
    await page.click('#dos-end'); await page.waitForFunction(() => testDos.audio.state === 'closed');
    // Emulate an earlier player with only DEFAULT.CFG; migrate it without
    // discarding the unrelated volume preference or the native save file.
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('aobing-dos', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('saves', 'readwrite'), store = tx.objectStore('saves');
        const r = store.get(testDos.saveKey);
        r.onsuccess = () => {
          const files = r.result.filter(f => !/\.cfg$/i.test(f.path));
          files.push({ path: 'DEFAULT.CFG', contents: new TextEncoder().encode('sfx_volume 7\nkey_fire 157\nkey_up 17\n') });
          store.put(files, testDos.saveKey);
        };
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      }); db.close();
    });
    await page.reload(); await boot(); await page.click('#dos-remap');
    assert.equal(await page.textContent('#dos-bind-key-fire'), 'G');
    for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size); await page.screenshot({ path: output + '/bindings-' + size.width + '.png' });
      assert.equal(await page.locator('#dos-controls-dialog').evaluate(e => e.scrollWidth <= e.clientWidth), true);
      await page.locator('#dos-bindings-save').scrollIntoViewIfNeeded();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('#dos-bindings-cancel'); await page.click('#dos-play-free'); await paused();
    assert.match(await cfg(), /^key_fire 34$/m); assert.match(await cfg(), /^key_up 23$/m);
    assert.match(await cfg(), /^sfx_volume 7$/m);
    await page.click('#dos-end'); await page.waitForFunction(() => testDos.audio.state === 'closed');
    assert.deepEqual(errors, []);
    console.log('PASS: remapping, validation, cancel/reset, mouse/touch, native save names, session isolation, persistence and responsive dialog');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
