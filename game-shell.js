/* Game chrome stays separate from the clicker economy and game engines. */
(() => {
  const library = document.getElementById('game-library');
  const curtain = document.getElementById('curtain');
  const start = document.getElementById('boot-start');
  const status = document.getElementById('boot-status');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const requestedHour = new URLSearchParams(location.search).get('hour');
  let previewHour = requestedHour !== null && requestedHour.trim() !== '' && Number.isFinite(Number(requestedHour)) ? ((Number(requestedHour) % 24) + 24) % 24 : null;
  const urlPreview = previewHour !== null;
  let skySlider = null;           // bound once the settings window has been parsed
  let skyLabel = null;
  let skyTimer;
  let tourStart = null;           // ms timestamp while the sky tour is running
  let tourFrom = 0;               // hour the running tour swept from
  let shownHour = 0;              // hour currently on screen
  const TOUR_TICK_MS = 200;       // sweep cadence; CSS blends between ticks
  let blendMode = 'none';         // CSS blend for the next sky change (see game-shell.css)
  const SKY_PHASE_KEYS = { Sunrise: 'sky.sunrise', Day: 'sky.day', Sunset: 'sky.sunset', Night: 'sky.night' };
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
    const touring = tourStart !== null;
    const hour = touring ? window.AobingSky.getTourHour(Date.now() - tourStart, tourFrom)
      : previewHour ?? now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    shownHour = hour;
    const sky = window.AobingSky.getSkyState(hour);
    const sunProgress = Math.max(0, Math.min(1, (hour - 5) / 15));
    document.body.style.setProperty('--sky-sun-x', `${10 + sunProgress * 80}%`);
    document.body.style.setProperty('--sky-sun-y', `${65 - Math.sin(sunProgress * Math.PI) * 48}%`);
    for (const [name, value] of Object.entries({ daylight: sky.daylight, warmth: sky.warmth, stars: sky.stars, 'warm-color': sky.warmColor })) {
      document.body.style.setProperty(`--sky-${name}`, value);
    }
    document.body.dataset.skyPhase = sky.phase.toLowerCase();
    if (previewHour !== null || touring) now.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const readout = `${I18N.t(touring ? 'sky.tour' : previewHour === null ? 'sky.local_time' : 'sky.preview')} · ${time} · ${I18N.t(SKY_PHASE_KEYS[sky.phase])}`;
    if (skyLabel) skyLabel.textContent = readout;
    if (skySlider) {
      // The thumb follows the clock and the tour; while scrubbing it already holds
      // the value the player set, so writing the same number changes nothing.
      if (previewHour === null || touring) skySlider.value = hour.toFixed(2);
      skySlider.setAttribute('aria-valuetext', readout);
    }
  }
  function syncSkyClock(blend) {
    clearTimeout(skyTimer);
    if (blend) blendMode = blend;
    document.body.dataset.skyBlend = blendMode;
    renderSky();
    // Commit an unblended sky before anything else can change it: without this the
    // first paint can batch with the next render and fade in from the initial values.
    if (blendMode === 'none') void document.body.offsetWidth;
    // Steady state: blend each change over the wait until the next one, so the
    // wall clock drifts continuously instead of stepping every half minute.
    blendMode = tourStart === null ? 'clock' : 'tour';
    if (!document.hidden) skyTimer = setTimeout(syncSkyClock, tourStart === null ? 30000 : TOUR_TICK_MS);
  }
  function setSkyHour(value, blend) {
    previewHour = value === null || value === 'auto' ? null : ((Number(value) % 24) + 24) % 24;
    if (!Number.isFinite(previewHour)) previewHour = null;
    syncSkyClock(blend || 'pick');
  }
  // app.js owns the picker's clicks so the choice persists with the other settings;
  // the shell only renders. ?hour= keeps its preview until the player picks one.
  window.GameShell = {
    applySkyPreference(hour, tour) {
      tourStart = tour ? Date.now() : null;
      if (tour && skySlider) skySlider.step = 'any';
      // Restoring a stored choice on load should land on it, not fade into it.
      if (urlPreview) syncSkyClock('none'); else { setSkyHour(hour); syncSkyClock('none'); }
    },
    setSkyHour: (hour) => setSkyHour(hour),
    shownSkyHour: () => shownHour,
    // Dragging the slider: follow the thumb with no blend so scrubbing feels direct.
    scrubSkyHour: (hour) => setSkyHour(hour, 'none'),
    setSkyTour(on) {
      tourFrom = shownHour;                 // sweep on from the sky already showing
      tourStart = on ? Date.now() : null;
      // 'any' lets the thumb glide during the sweep; scrubbing keeps the 15-minute
      // steps the markup declares.
      if (skySlider) skySlider.step = on ? 'any' : '0.25';
      syncSkyClock(on ? 'tour' : 'pick');
    },
  };
  function bindSkyControls() {
    skySlider = document.getElementById('sky-hour-slider');
    skyLabel = document.getElementById('sky-time-label');
    const hours = window.AobingSky.STAGE_HOURS;
    const span = Number(skySlider.max);
    document.getElementById('sky-hour-ticks').replaceChildren(...hours.map((hour) => {
      const tick = document.createElement('option');
      tick.value = String(hour);
      return tick;
    }));
    [...document.getElementById('sky-scale').children].forEach((label, index) => {
      label.style.setProperty('--at', `${(hours[index] / span) * 100}%`);
    });
    syncSkyClock();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindSkyControls, { once: true });
  else bindSkyControls();
  window.addEventListener('i18nchange', renderSky);
  document.addEventListener('visibilitychange', () => syncSkyClock());
  window.addEventListener('pageshow', () => syncSkyClock());
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
    start.textContent = I18N.t('boot.enter');
    status.textContent = '';
    curtain.classList.add('boot-ready');
  }, { once: true });
  window.addEventListener('aobingloaderror', () => {
    status.textContent = I18N.t('boot.error');
    start.disabled = false;
    start.textContent = I18N.t('boot.retry');
    start.addEventListener('click', (event) => {
      event.stopPropagation();
      location.reload();
    }, { once: true });
  }, { once: true });
  start.addEventListener('click', async () => {
    if (!ready || started) return;
    started = true;
    start.disabled = true;
    start.textContent = I18N.t('boot.all_aboard');
    status.textContent = I18N.t('boot.next_stop');
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
    libraryTitle.textContent = I18N.t('library.title');
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
        libraryTitle.textContent = I18N.t('mode.typing');
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
