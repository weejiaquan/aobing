/* Serve the repo; use NODE_PATH for an installed Playwright. No real invites or
   analytics are used. Screenshots go to the OS temporary directory. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.join(require('node:os').tmpdir(), 'kei-quiz-usability');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.firebase={initializeApp(){},database(){const ref={child(){return ref},on(){},transaction(){}};return {ref(){return ref}}}};'
    }));
    await page.goto(process.env.KEI_TEST_URL || 'http://127.0.0.1:8765/discord/');
    await page.waitForFunction(() => window.keiSceneReady);
    await page.click('#kei-enter');
    const now = Date.now();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now + 1000);
    await page.evaluate(() => {
      window.completionCount = 0;
      trackCompletion = () => window.completionCount++;
      window.open = () => { throw Error('Test must not open a real invite'); };
    });
    assert.equal(await page.locator('#discord-link').isDisabled(), true);
    await page.click('.start-btn');
    await page.getByRole('button', { name: 'Key.exe', exact: true }).click();
    assert.equal(await page.evaluate(() => currentQ), 0);
    assert.match(await page.locator('#retry-hint').textContent(), /saved game/);
    await page.click('.retry-btn');
    const small = await page.getByRole('button', { name: 'Kei.sav', exact: true }).boundingBox();
    assert(small.width >= 44 && small.width <= 80 && small.height >= 44);
    assert.equal(await page.locator('.option-btn.tiny').evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 9);
    await page.getByRole('button', { name: 'Kei.sav', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'A hologram maid', exact: true }).click();
    await page.click('.retry-btn');
    assert.equal(await page.evaluate(() => currentQ), 1);
    assert.equal(await page.evaluate(() => completedQuestions.size), 1);
    await page.getByRole('button', { name: 'A one-wheeled robot', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Luminous Nova', exact: true }).press('Enter');
    assert.equal(await page.evaluate(() => currentQ), 3);

    // Stale answer callbacks and wrong-kind completions cannot skip timed steps.
    await page.evaluate(() => { handleAnswer(true, false, 2); startQuizVoiceline(); });
    assert.equal(await page.evaluate(() => currentQ), 3);
    assert.equal(await page.locator('#headpat-action').count(), 0);
    assert.equal(await page.locator('#interaction-actions').count(), 0);
    const headPosition = () => page.evaluate(() => ({
      x: (1650 - 1280) / spineTranspose + spineCanvas.width / 2,
      y: (400 - 800) / spineTranspose + spineCanvas.height / 2
    }));
    const head = await headPosition();
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.clock.runFor(180);
    assert(Number(await page.locator('#headpat-hud').getAttribute('aria-valuenow')) > 0);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => currentQ), 3);
    await page.clock.runFor(1600);
    await page.mouse.down();
    await page.clock.runFor(5650);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => currentQ), 4);
    assert.equal(await page.locator('#discord-link').isDisabled(), true);
    assert.equal(await page.locator('#voice-action').count(), 0);
    await page.screenshot({ path: path.join(output, 'desktop-voice-prompt.png') });
    const voice = await page.evaluate(() => ({
      x: (700 - 1280) / spineTranspose + spineCanvas.width / 2,
      y: (1000 - 800) / spineTranspose + spineCanvas.height / 2
    }));
    await page.touchscreen.tap(voice.x, voice.y);
    assert.equal(await page.evaluate(() => voiceCompletionTimer !== null), true);
    await page.evaluate(() => { startQuizVoiceline(); startQuizVoiceline(); });
    await page.clock.runFor(2990);
    assert.equal(await page.evaluate(() => welcomeReady), false);
    await page.clock.runFor(20);
    assert.equal(await page.evaluate(() => completedQuestions.size), 5);
    assert.equal(await page.evaluate(() => window.completionCount), 1);
    assert.equal(await page.locator('#discord-link').isEnabled(), true);
    await page.evaluate(() => { completeInteractionQuestion(); showQuizWelcome(); });
    assert.equal(await page.evaluate(() => window.completionCount), 1);
    for (let i = 0; i < 5; i++) await page.click('#discord-link');
    assert.equal(await page.locator('#victory-title').textContent(), 'You can stay.');
    // Local placeholder fails visibly, rather than throwing or opening a broken URL.
    await page.click('#discord-link');
    assert.match(await page.locator('#tsundere-protest').textContent(), /unavailable/);
    await page.screenshot({ path: path.join(output, 'desktop-welcome.png') });

    // The answer actually jumps five times and stays inside the answer area.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.mouse.move(10, 10);
    await page.evaluate(() => { currentQ = 2; showScreen('question-screen'); renderQuestion(); restorePanel(); });
    await page.clock.runFor(400);
    await page.evaluate(() => document.querySelector('#game').getAnimations({ subtree: true }).forEach(animation => animation.finish()));
    const answer = page.getByRole('button', { name: 'Luminous Nova', exact: true });
    await page.evaluate(() => {
      let seed = 24681;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    });
    const landings = [];
    let overlaysDecoy = false;
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(10, 10);
      const before = await answer.boundingBox();
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      assert.equal(await page.evaluate(() => runawayEvadeCount), i + 1);
      const after = await answer.boundingBox();
      const arena = await page.locator('#options-container').boundingBox();
      landings.push([after.x - arena.x, after.y - arena.y]);
      overlaysDecoy ||= await page.evaluate(() => {
        const jumper = document.querySelector('.runaway');
        const a = jumper.getBoundingClientRect();
        return [...document.querySelectorAll('.option-btn:not(.runaway)')].some(decoy => {
          const b = decoy.getBoundingClientRect();
          const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
          const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
          return right - left > 4 && bottom - top > 4
            && document.elementFromPoint((left + right) / 2, (top + bottom) / 2)?.closest('button') === jumper;
        });
      });
      assert(Math.hypot(before.x - after.x, before.y - after.y) > 60);
      assert(after.x >= arena.x - 1 && after.y >= arena.y - 1 && after.x + after.width <= arena.x + arena.width + 1 && after.y + after.height <= arena.y + arena.height + 1);
      assert.equal(await page.evaluate(() => currentQ), 2);
    }
    assert(new Set(landings.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`)).size > 2, 'Jumping must not alternate between two fixed spots');
    assert(landings.filter(([x, y]) => x > 4 && y > 4).length >= 3, 'Use the interior of the answer area');
    assert(overlaysDecoy, 'The floating answer must be able to cover and receive clicks above a decoy');
    await page.screenshot({ path: path.join(output, 'desktop-runaway.png') });
    await answer.click();
    assert.equal(await page.evaluate(() => currentQ), 3);

    for (const [name, width, height] of [['mobile', 390, 844], ['landscape', 844, 390]]) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize({ width, height });
      await page.mouse.move(10, 10);
      await page.evaluate(() => { currentQ = 2; showScreen('question-screen'); renderQuestion(); restorePanel(); });
      await page.clock.runFor(400);
      await page.evaluate(() => document.querySelector('#game').getAnimations({ subtree: true }).forEach(animation => animation.finish()));
      for (let i = 0; i < 5; i++) {
        await answer.scrollIntoViewIfNeeded();
        const target = await answer.boundingBox();
        await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
        assert.equal(await page.evaluate(() => runawayEvadeCount), i + 1);
        assert.equal(await page.evaluate(() => currentQ), 2);
        const moved = await answer.boundingBox();
        assert(moved.x >= 0 && moved.y >= 0 && moved.x + moved.width <= width + 1 && moved.y + moved.height <= height + 1);
      }
      await page.screenshot({ path: path.join(output, name + '-runaway.png') });
      await answer.click();
      assert.equal(await page.evaluate(() => currentQ), 3);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => { currentQ = 3; showScreen('question-screen'); renderQuestion(); });
      await page.clock.runFor(20);
      await page.screenshot({ path: path.join(output, name + '-headpat-prompt.png') });
      assert.equal(await page.locator('#interaction-actions').count(), 0);
      const head = await headPosition();
      assert(head.x >= 0 && head.y >= 0 && head.x < width && head.y < height);
      await page.mouse.move(head.x, head.y);
      await page.mouse.down();
      await page.clock.runFor(180);
      await page.screenshot({ path: path.join(output, name + '-holding.png') });
      await page.mouse.up();
      assert.equal(await page.evaluate(() => currentQ), 3);
      await page.clock.runFor(1600);
      await page.touchscreen.tap(head.x, head.y);
      assert.equal(await page.locator('#headpat-hud').getAttribute('data-phase'), 'released');
      assert.equal(await page.evaluate(() => currentQ), 3);
    }
    await page.evaluate(() => startGame());
    assert.equal(await page.locator('#discord-link').isDisabled(), true);
    assert.equal(await page.evaluate(() => completedQuestions.size), 0);

    // A deployed-style configuration opens the expected URL, without networking
    // to Discord. The measured full quiz flow above already verified the gate.
    await page.clock.resume();
    await page.route('**/discord/', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('REPLACE_WITH_BASE64_INVITE_CODE', Buffer.from('testinvite').toString('base64'));
      await route.fulfill({ response, body });
    });
    await page.reload();
    await page.waitForFunction(() => window.keiSceneReady);
    await page.click('#kei-enter');
    await page.evaluate(() => {
      window.openedInvites = [];
      window.open = (...args) => window.openedInvites.push(args);
      showQuizWelcome();
    });
    assert.equal(await page.evaluate(() => welcomeReady), false);
    await page.evaluate(() => {
      QUESTIONS.forEach((_, index) => completedQuestions.add(index));
      showQuizWelcome();
    });
    for (let i = 0; i < 5; i++) await page.click('#discord-link');
    assert.equal(await page.evaluate(() => window.openedInvites.length), 0);
    await page.click('#discord-link');
    await page.click('#discord-link');
    assert.deepEqual(await page.evaluate(() => window.openedInvites), [
      ['https://discord.gg/testinvite', '_blank', 'noopener'],
      ['https://discord.gg/testinvite', '_blank', 'noopener']
    ]);
    assert.deepEqual(errors, []);
    console.log('PASS: retries preserve progress, tiny answer, keyboard answers and direct headpat, all five steps, duplicate guards, invite error, five mouse/touch escapes, staged welcome, responsive character interaction. ' + output);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
