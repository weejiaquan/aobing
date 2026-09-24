/* Serve the repo, then run with NODE_PATH pointing to an installed Playwright.
   Firebase is stubbed so these checks never write community statistics. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const output = path.join(os.tmpdir(), 'kei-headpat-review');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.firebase={initializeApp(){},database(){const ref={child(){return ref},on(){},transaction(){}};return {ref(){return ref}}}};'
    }));
    await page.goto(process.env.KEI_TEST_URL || 'http://127.0.0.1:8765/discord/');
    await page.waitForFunction(() => window.keiSceneReady);
    await page.click('#kei-enter');
    await page.locator('#kei-intro').waitFor({ state: 'hidden' });
    const testNow = Date.now();
    await page.clock.install({ time: testNow });
    await page.clock.pauseAt(testNow + 1000);
    await page.evaluate(() => {
      window.headpatAwards = [];
      trackHeadpat = seconds => window.headpatAwards.push(seconds);
    });
    const prepare = async () => page.evaluate(() => {
      currentQ = 3;
      showScreen('question-screen');
      renderQuestion();
      minimizePanel();
    });
    const state = () => page.evaluate(() => ({
      seconds: Number(document.getElementById('headpat-hud').getAttribute('aria-valuenow')),
      text: document.getElementById('hud-seconds').textContent,
      visible: document.getElementById('headpat-hud').classList.contains('visible'),
      phase: document.getElementById('headpat-hud').dataset.phase,
      fill: Number(document.querySelector('.hud-steps i').style.getPropertyValue('--fill')),
      active: document.querySelectorAll('.hud-steps i.active').length,
      question: currentQ,
      awards: window.headpatAwards.slice()
    }));

    // A real mouse press on the head must respond before the first timer tick.
    await prepare();
    const head = await page.evaluate(() => ({
      x: (1650 - 1280) / spineTranspose + spineCanvas.width / 2,
      y: (400 - 800) / spineTranspose + spineCanvas.height / 2
    }));
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    let s = await state();
    assert(s.visible && s.active === 1 && s.seconds === 0);
    await page.clock.runFor(180);
    await page.mouse.up();
    s = await state();
    assert(s.seconds > 0 && s.seconds < 1 && s.fill > 0 && s.fill < 1);
    assert.equal(s.phase, 'released');
    assert.equal(s.question, 3);
    await page.screenshot({ path: path.join(output, 'quick-tap.png') });

    // Restarting clears the receipt timeout and requires a fresh full hold.
    await page.clock.runFor(100);
    await page.evaluate(() => startQuizHeadpat());
    assert.equal((await state()).seconds, 0);
    await page.clock.runFor(2500);
    s = await state();
    assert(s.visible && s.seconds >= 2.4 && s.seconds <= 2.5);
    assert.equal(s.awards.length, 0);
    await page.screenshot({ path: path.join(output, 'mid-hold.png') });
    await page.clock.runFor(2490);
    assert.equal((await state()).question, 3);
    assert.equal((await state()).awards.length, 0);
    await page.clock.runFor(40);
    s = await state();
    assert.equal(s.text, '5.0');
    assert.equal(s.phase, 'complete');
    assert.deepEqual(s.awards, [5]);
    await page.evaluate(() => { startQuizHeadpat(); spineReleasedMouse(); });
    await page.clock.runFor(650);
    s = await state();
    assert.equal(s.question, 4);
    assert.equal(s.visible, false);
    assert.deepEqual(s.awards, [5]);

    // Early releases, focus loss, and touch cancellation cannot complete later.
    for (const event of ['mouseup', 'blur', 'touchcancel']) {
      await prepare();
      await page.evaluate(() => startQuizHeadpat());
      await page.clock.runFor(120);
      await page.evaluate(type => {
        (type === 'touchcancel' ? spineCanvas : window).dispatchEvent(new Event(type));
      }, event);
      assert.equal((await state()).phase, 'released');
      await page.clock.runFor(6000);
      s = await state();
      assert.equal(s.visible, false);
      assert.equal(s.question, 3);
      assert.deepEqual(s.awards, [5]);
    }
    await prepare();
    await page.evaluate(() => startQuizHeadpat());
    await page.clock.runFor(120);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
    });
    await page.clock.runFor(6000);
    assert.equal((await state()).question, 3);
    assert.deepEqual((await state()).awards, [5]);

    // Changing questions cancels the timer and any delayed advance.
    await prepare();
    await page.evaluate(() => startQuizHeadpat());
    await page.clock.runFor(150);
    await page.evaluate(() => startGame());
    await page.clock.runFor(6000);
    assert.equal((await state()).question, 0);

    // Essential fractional feedback stays visible in reduced motion at all sizes.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [name, width, height] of [['mobile', 390, 844], ['landscape', 844, 390]]) {
      await page.setViewportSize({ width, height });
      await prepare();
      await page.evaluate(() => startQuizHeadpat());
      await page.clock.runFor(180);
      assert((await state()).seconds > 0);
      const bounds = await page.locator('#headpat-hud').boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
      await page.screenshot({ path: path.join(output, name + '.png') });
      await page.evaluate(() => resetQuizHeadpat());
    }
    assert.deepEqual(errors, []);
    console.log('PASS: immediate press, short tap, fractional fill, restart, exact completion, interruption, duplicate guard, layout, reduced motion. Screenshots: ' + output);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
