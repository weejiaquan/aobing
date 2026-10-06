/* Shared presentation only: never delay a game's clock, audio, or input setup. */
(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pending = new Map();
  const animations = new Set();
  function animate(element, frames, options) {
    if (!element?.animate || reduced.matches || document.hidden) return;
    const animation = element.animate(frames, options);
    animations.add(animation);
    animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
    return animation;
  }
  function clear(panel) {
    pending.get(panel)?.();
    pending.delete(panel);
  }
  function showScreen(panel, screens, name) {
    clear(panel);
    const next = screens[name];
    const previous = Object.values(screens).find(screen => screen && !screen.hidden);
    for (const [key, screen] of Object.entries(screens)) {
      if (!screen) continue;
      screen.hidden = key !== name;
      screen.inert = key !== name;
      screen.setAttribute('aria-hidden', String(key !== name));
    }
    if (!next || previous === next) return;
    const playing = name === 'game' || name === 'calib';
    const result = name === 'results';
    let timer;
    const owned = [];
    const cleanup = () => {
      clearTimeout(timer);
      owned.forEach(animation => animation?.cancel());
      previous?.classList.remove('ui-screen-leaving');
      next.inert = next.hidden;
      pending.delete(panel);
    };
    // Gameplay appears immediately and at its exact native geometry. Menu motion
    // must never obscure an early note or shift canvas pointer coordinates.
    if (playing) return;
    if (reduced.matches || document.hidden || !next.animate) {
      if (result && !document.hidden && !document.querySelector('dialog[open]')) {
        next.tabIndex = -1;
        next.focus({preventScroll: true});
      }
      return;
    }
    pending.set(panel, cleanup);
    if (previous) {
      previous.classList.add('ui-screen-leaving');
      owned.push(animate(previous, [{opacity: 1}, {opacity: 0}], {duration: 240, easing: 'ease-out', fill: 'forwards'}));
    }
    next.inert = true; // A finishing tap must not activate Retry through the reveal.
    owned.push(animate(next, [{opacity: 0}, {opacity: 1}], {duration: result ? 360 : 220, easing: 'ease-out'}));
    const children = result
      ? [...next.querySelectorAll('h2,[id$="results-body"] > *,[class$="results-actions"],#divaft-retry,#divaft-back')]
      : [...next.children].slice(0, 8);
    const grade = next.querySelector('.osu-res-grade');
    children.forEach((child, index) => {
      if (child === grade) return;
      owned.push(animate(child, [
        {opacity: 0, transform: result ? 'translateY(22px) scale(.98)' : 'translateY(12px)'},
        {opacity: 1, transform: 'translateY(0) scale(1)'},
      ], {duration: result ? 480 : 300, delay: Math.min(index, 6) * (result ? 65 : 25),
        easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards'}));
    });
    if (grade) owned.push(animate(grade, [
      {opacity: 0, transform: 'translateY(10px) scale(1.2)'},
      {opacity: 1, transform: 'translateY(0) scale(1)'},
    ], {duration: 580, delay: 120, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards'}));
    // One bounded cleanup per panel; switching again cancels every old callback.
    timer = setTimeout(cleanup, result ? 920 : 520);
    const reveal = owned[0];
    // Controls become available after the short crossfade, independently of the
    // decorative result stagger. Cleanup also releases them on cancellation.
    if (reveal) reveal.finished.then(() => { if (pending.get(panel) === cleanup) next.inert = next.hidden; }, () => {});
    if (result) {
      next.tabIndex = -1;
      // Focus after the reveal, so held gameplay keys do not activate a button.
      const incoming = owned[previous ? 1 : 0];
      incoming?.finished.then(() => {
        if (pending.get(panel) !== cleanup || next.hidden || document.querySelector('dialog[open]')) return;
        next.inert = false;
        next.focus({preventScroll: true});
      }, () => {});
    }
  }
  const stop = () => {
    [...pending.values()].forEach(cleanup => cleanup());
    animations.forEach(animation => animation.cancel());
    animations.clear();
  };
  reduced.addEventListener('change', () => { if (reduced.matches) stop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('gamemodechange', stop);
  window.UIMotion = {showScreen, clear};
})();
