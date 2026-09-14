/* Presentation and focus management for the existing app-owned panel toggles. */
(() => {
  const entries = [
    ['settings-panel', 'settings-btn'], ['skins-panel', 'skins-btn'],
    ['shop-panel', 'shop-btn'], ['profile-panel', 'sensei-bar'],
    ['modifiers-panel', 'modifiers-btn'],
    ['leaderboard-modal', 'leaderboard-btn'], ['stats-modal', 'stats-btn'],
  ].map(([id, trigger]) => ({ panel: document.getElementById(id), trigger: document.getElementById(trigger) }));
  const backdrop = document.getElementById('ui-panel-backdrop');
  const confirmation = document.getElementById('app-modal');
  let active = null;
  let previousFocus = null;
  const background = new Set();
  const focusables = (root) => [...root.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]')]
    .filter((el) => !el.closest('[hidden],[inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');

  function close(entry) {
    const closeButton = entry.panel.querySelector('#leaderboard-close,#stats-close');
    if (closeButton) closeButton.click();
    else entry.panel.classList.remove('open');
  }
  function releaseBackground() {
    background.forEach((el) => { el.inert = false; });
    background.clear();
  }
  function sync() {
    const opened = entries.filter(({ panel }) => panel.classList.contains('open'));
    const next = opened.find((entry) => entry !== active) || opened[0] || null;
    if (next === active) return;
    const old = active;
    releaseBackground();
    active = next;
    if (next) {
      if (!old) previousFocus = document.activeElement;
      opened.filter((entry) => entry !== next).forEach(close);
    }
    entries.forEach(({ panel, trigger }) => {
      const isOpen = panel === next?.panel;
      panel.inert = !isOpen;
      panel.setAttribute('aria-hidden', String(!isOpen));
      trigger?.setAttribute('aria-expanded', String(isOpen));
      trigger?.setAttribute('aria-controls', panel.id);
    });
    backdrop.hidden = !next || !next.panel.classList.contains('hub-window');
    document.body.classList.toggle('ui-window-open', !!next);
    if (next?.panel.id === 'shop-panel' || old?.panel.id === 'shop-panel') {
      document.getElementById('mode-chip').setAttribute('aria-expanded', String(next?.panel.id === 'shop-panel'));
    }
    if (next) {
      for (const el of document.body.children) {
        if (el === next.panel || el.contains(next.panel) || el === backdrop || el.inert ||
            el.matches('script,style,link,dialog,#app-modal,#link-toast')) continue;
        el.inert = true;
        background.add(el);
      }
      const dialog = next.panel.querySelector('[role="dialog"]') || next.panel;
      dialog.setAttribute('aria-modal', 'true');
      dialog.tabIndex = -1;
      (dialog.querySelector('.ui-close,.stats-close') || focusables(dialog)[0] || dialog).focus({ preventScroll: true });
    } else if (old) {
      const fallback = old.panel.id === 'shop-panel' ? document.getElementById('mode-chip') : old.trigger;
      const returnTo = previousFocus?.isConnected && previousFocus.getClientRects().length && !previousFocus.closest('[inert],[hidden]') ? previousFocus : fallback;
      returnTo?.focus({ preventScroll: true });
      previousFocus = null;
    }
  }
  for (const { panel, trigger } of entries) {
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    trigger?.setAttribute('aria-expanded', 'false');
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  document.querySelectorAll('[data-close-panel]').forEach((button) => button.addEventListener('click', () => {
    document.getElementById(button.dataset.closePanel).classList.remove('open');
  }));
  document.getElementById('modifiers-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    window.TypingGame?.refreshKeyboardPanel?.();
    document.getElementById('modifiers-panel').classList.toggle('open');
  });
  backdrop.addEventListener('click', () => { if (active) close(active); });
  document.querySelectorAll('.shop-item').forEach((item) => {
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
  });
  new MutationObserver(() => {
    if (active) active.panel.inert = !confirmation.hidden;
  }).observe(confirmation, { attributes: true, attributeFilter: ['hidden'] });
  // Existing switches retain their application handlers; expose their state.
  document.querySelectorAll('#settings-panel .settings-row').forEach((row, index) => {
    const label = row.querySelector('.settings-label');
    const control = row.querySelector('input,select,button');
    if (!label || !control) return;
    label.id ||= `setting-label-${index}`;
    control.setAttribute('aria-labelledby', label.id);
    if (control.classList.contains('settings-toggle')) {
      const syncSwitch = () => control.setAttribute('aria-checked', String(control.classList.contains('on')));
      control.setAttribute('role', 'switch');
      syncSwitch();
      new MutationObserver(syncSwitch).observe(control, { attributes: true, attributeFilter: ['class'] });
    }
  });
  window.addEventListener('keydown', (event) => {
    if (!confirmation.hidden) {
      if (event.key === 'Tab') {
        const options = focusables(confirmation);
        const first = options[0], last = options[options.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      return;
    }
    if (!active || document.querySelector('.merge-overlay,#update-modal')) return;
    // Stop game shortcuts while preserving native input/button behavior.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault(); close(active); return;
    }
    if (event.key === 'Tab') {
      const options = focusables(active.panel);
      const first = options[0], last = options[options.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !options.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !options.includes(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    const tile = event.target.closest('.skin-item,.shop-item');
    if (tile && event.target === tile && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      if (tile.getAttribute('aria-disabled') === 'true') return;
      const variant = tile.dataset.variant;
      tile.click();
      if (variant) document.querySelector(`.skin-item[data-variant="${CSS.escape(variant)}"]`)?.focus();
    }
  }, true);
})();
