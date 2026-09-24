(() => {
  const hud = document.getElementById('headpat-hud');
  const hudNumber = document.getElementById('hud-seconds');
  const hudSteps = [...hud.querySelectorAll('.hud-steps i')];
  const hudNote = hud.querySelector('.hud-note');
  window.KeiUI = {
    setHeadpatProgress(seconds, visible = true, phase = 'holding') {
      const value = Math.max(0, Math.min(5, seconds));
      const display = (Math.floor(value * 10) / 10).toFixed(1);
      if (hudNumber.textContent !== display) hudNumber.textContent = display;
      hud.setAttribute('aria-valuenow', display);
      hud.setAttribute('aria-hidden', String(!visible));
      hud.classList.toggle('visible', visible);
      hud.dataset.phase = phase;
      hudNote.textContent = phase === 'complete' ? '...That was nice.'
        : phase === 'released' ? 'Hold a little longer.' : 'Keep holding...';
      hudSteps.forEach((step, index) => {
        step.style.setProperty('--fill', Math.max(0, Math.min(1, value - index)));
        step.classList.toggle('filled', value >= index + 1);
        step.classList.toggle('active', visible && phase === 'holding' && value >= index && value < index + 1);
      });
    }
  };

  const intro = document.getElementById('kei-intro');
  const enter = document.getElementById('kei-enter');
  const game = document.getElementById('game');
  const miniBar = document.getElementById('mini-bar');
  const settingsButton = document.getElementById('settings-btn');
  const statsButton = document.getElementById('stats-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const statsPanel = document.getElementById('stats-panel');
  const scene = document.getElementById('spine-canvas');
  const covered = [game, miniBar, settingsButton, statsButton, settingsPanel, statsPanel, scene];
  covered.forEach(element => { element.inert = true; });

  const sceneReady = () => {
    enter.disabled = false;
    enter.textContent = 'Meet Kei';
    enter.focus({ preventScroll: true });
  };
  window.addEventListener('keisceneready', sceneReady, { once: true });
  if (window.keiSceneReady) sceneReady();

  enter.addEventListener('click', () => {
    if (enter.disabled) return;
    startBGM();
    intro.classList.add('kei-intro-leaving');
    document.body.classList.remove('kei-intro-active');
    covered.forEach(element => { element.inert = false; });
    const finish = () => {
      intro.hidden = true;
      document.querySelector('.title-screen .start-btn').focus({ preventScroll: true });
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else window.setTimeout(finish, 700);
  });
})();
