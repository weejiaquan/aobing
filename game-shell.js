/* Game chrome stays separate from the clicker economy and game engines. */
(() => {
  const library = document.getElementById('game-library');
  const curtain = document.getElementById('curtain');
  const start = document.getElementById('boot-start');
  const status = document.getElementById('boot-status');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const skyChoices = document.querySelectorAll('[data-sky-hour]');
  const skyLabel = document.getElementById('sky-time-label');
  const requestedHour = new URLSearchParams(location.search).get('hour');
  let previewHour = requestedHour !== null && requestedHour.trim() !== '' && Number.isFinite(Number(requestedHour)) ? ((Number(requestedHour) % 24) + 24) % 24 : null;
  let skyTimer;
  document.querySelectorAll('[data-sky-scene]').forEach((scene) => {
    for (const name of ['day', 'night', 'stars', 'clouds', 'city', 'city-lights', 'halos', 'warmth']) {
      const layer = document.createElement('div');
      layer.className = `sky-layer sky-${name}`;
      if (name === 'stars') {
        for (let i = 0; i < 65; i++) {
          const star = document.createElement('i');
          star.style.cssText = `left:${(i * 47.37) % 100}%;top:${(i * 29.13) % 61}%;--twinkle-delay:-${i % 11}s;--star-size:${i % 5 === 0 ? 3 : 1}px`;
          layer.appendChild(star);
        }
      }
      scene.appendChild(layer);
    }
  });
  function renderSky() {
    const now = new Date();
    const hour = previewHour ?? now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    const sky = window.AobingSky.getSkyState(hour);
    const sunProgress = Math.max(0, Math.min(1, (hour - 5) / 15));
    document.body.style.setProperty('--sky-sun-x', `${10 + sunProgress * 80}%`);
    document.body.style.setProperty('--sky-sun-y', `${65 - Math.sin(sunProgress * Math.PI) * 48}%`);
    for (const [name, value] of Object.entries({ daylight: sky.daylight, warmth: sky.warmth, stars: sky.stars, 'warm-color': sky.warmColor })) {
      document.body.style.setProperty(`--sky-${name}`, value);
    }
    document.body.dataset.skyPhase = sky.phase.toLowerCase();
    skyChoices.forEach((button) => button.setAttribute('aria-pressed', String(previewHour === null ? button.dataset.skyHour === 'auto' : Number(button.dataset.skyHour) === previewHour)));
    if (previewHour !== null) now.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    skyLabel.textContent = `${previewHour === null ? 'Local time' : 'Preview'} · ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${sky.phase}`;
  }
  function syncSkyClock() {
    clearTimeout(skyTimer);
    renderSky();
    if (!document.hidden) skyTimer = setTimeout(syncSkyClock, 30000);
  }
  skyChoices.forEach((button) => button.addEventListener('click', () => {
    previewHour = button.dataset.skyHour === 'auto' ? null : Number(button.dataset.skyHour);
    renderSky();
  }));
  document.addEventListener('visibilitychange', syncSkyClock);
  window.addEventListener('pageshow', syncSkyClock);
  window.addEventListener('pagehide', () => clearTimeout(skyTimer));
  syncSkyClock();
  const train = document.getElementById('boot-train');
  const trainArrival = reducedMotion.matches ? null : train.animate([
    { transform: 'translateX(calc(-50vw - 50% - 100px))' },
    { transform: 'translateX(0)' },
  ], { duration: 2100, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' });
  let ready = false;
  let started = false;
  const bootBackground = [];
  document.addEventListener('DOMContentLoaded', () => {
    if (started) return;
    for (const element of document.body.children) {
      if (element === curtain || element.matches('script, style, link') || element.inert) continue;
      element.inert = true;
      bootBackground.push(element);
    }
  }, { once: true });
  // Keep the modal's native keyboard behavior without passing keys into a game.
  window.addEventListener('keydown', (event) => {
    if (library.open) event.stopPropagation();
  }, true);

  window.addEventListener('aobingready', () => {
    ready = true;
    start.disabled = false;
    start.textContent = 'ENTER GAME';
    status.textContent = '';
    curtain.classList.add('boot-ready');
  }, { once: true });
  window.addEventListener('aobingloaderror', () => {
    status.textContent = 'The game could not load. Check your connection and try again.';
    start.disabled = false;
    start.textContent = 'RETRY CONNECTION';
    start.addEventListener('click', (event) => {
      event.stopPropagation();
      location.reload();
    }, { once: true });
  }, { once: true });
  start.addEventListener('click', async () => {
    if (!ready || started) return;
    started = true;
    start.disabled = true;
    start.textContent = 'ALL ABOARD!';
    status.textContent = 'Next stop: Aobing IT!';
    skyChoices.forEach((button) => { button.disabled = true; });
    // Initialize audio inside the click gesture; keep the lobby covered until
    // the entire train has cleared the viewport. The shell owns removal.
    window.dispatchEvent(new Event('aobingstart'));
    if (trainArrival) await trainArrival.finished.catch(() => {});
    curtain.classList.add('boot-departing');
    if (!reducedMotion.matches) {
      const distance = window.innerWidth - train.getBoundingClientRect().left + 160;
      const departure = train.animate([
        { transform: 'translateX(0)' },
        { transform: 'translateX(-8px)', offset: 0.1 },
        { transform: `translateX(${distance}px)` },
      ], { duration: 1250, easing: 'cubic-bezier(.6,0,.9,.45)', fill: 'forwards' });
      const anticipation = curtain.animate([
        { transform: 'scale(1)' }, { transform: 'scale(1.035)' },
      ], { duration: 1250, easing: 'ease-in', fill: 'forwards' });
      await Promise.all([departure.finished, anticipation.finished]).catch(() => {});
    }
    document.body.classList.remove('is-booting');
    document.body.classList.add('lobby-entered');
    if (!reducedMotion.matches) {
      await curtain.animate([
        { opacity: 1, transform: 'scale(1.035)' },
        { opacity: .98, transform: 'scale(1.16)', offset: .35 },
        { opacity: 0, transform: 'scale(1.9)' },
      ], { duration: 650, easing: 'cubic-bezier(.5,0,.2,1)', fill: 'forwards' }).finished.catch(() => {});
    }
    curtain.remove();
    bootBackground.forEach((element) => { element.inert = false; });
    document.getElementById('hub-launch').focus({ preventScroll: true });
    const welcome = document.getElementById('lobby-welcome');
    welcome.hidden = false;
    setTimeout(async () => {
      if (!reducedMotion.matches) {
        await welcome.animate([
          { opacity: 1, transform: 'translateX(0)' },
          { opacity: 0, transform: 'translateX(calc(-100% - 48px))' },
        ], { duration: 600, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' }).finished.catch(() => {});
      }
      welcome.hidden = true;
    }, 4500);
  });
  document.addEventListener('keydown', (event) => {
    if (!document.body.classList.contains('is-booting')) return;
    if (event.key === 'Tab') {
      const buttons = [...curtain.querySelectorAll('button:not(:disabled)')].filter((button) => button.getClientRects().length);
      const current = buttons.indexOf(document.activeElement);
      const next = current < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus({ preventScroll: true });
    }
    if (ready && event.key === 'Enter' && !event.target.closest('button')) {
      event.preventDefault();
      start.click();
    }
  });

  const libraryGames = document.getElementById('library-games');
  const libraryTyping = document.getElementById('library-typing');
  const libraryTitle = document.getElementById('library-title');
  function showLibraryGames() {
    libraryGames.hidden = false;
    libraryTyping.hidden = true;
    libraryTitle.textContent = 'Choose your play.';
  }
  document.getElementById('library-back').addEventListener('click', () => {
    showLibraryGames();
    libraryGames.querySelector('[data-launch-mode="typing"]').focus();
  });
  document.querySelectorAll('[data-open-library]').forEach((button) => {
    button.addEventListener('click', () => {
      showLibraryGames();
      library.showModal();
      document.body.classList.add('library-open');
    });
  });
  document.getElementById('library-close').addEventListener('click', () => library.close());
  library.addEventListener('close', () => document.body.classList.remove('library-open'));
  library.addEventListener('click', (event) => {
    if (event.target === library) library.close();
  });
  document.querySelectorAll('[data-launch-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!ready) return;
      if (button.dataset.launchMode === 'typing' && !button.dataset.launchSubmode) {
        libraryGames.hidden = true;
        libraryTyping.hidden = false;
        libraryTitle.textContent = 'Typing';
        window.TypingGame?.refreshKeyboardPanel?.();
        libraryTyping.querySelector('[data-launch-submode="casual"]').focus();
        return;
      }
      library.close();
      const transition = document.getElementById('scene-transition');
      if (!reducedMotion.matches) {
        transition.getAnimations().forEach((animation) => animation.cancel());
        transition.animate([
          { transform: 'translateX(-120%) skewX(-16deg)' },
          { transform: 'translateX(0) skewX(-16deg)', offset: 0.4 },
          { transform: 'translateX(120%) skewX(-16deg)' },
        ], { duration: 550, easing: 'cubic-bezier(.65,0,.35,1)' });
      }
      const detail = button.dataset.launchSubmode
        ? { mode: button.dataset.launchMode, submode: button.dataset.launchSubmode }
        : button.dataset.launchMode;
      window.dispatchEvent(new CustomEvent('aobinglaunch', { detail }));
    });
  });
})();
