/* Physical keyboard bindings compiled to Doom's native DOS scan codes. */
(function (root) {
  'use strict';
  const actions = ['forward', 'backward', 'strafe_left', 'strafe_right', 'left', 'right', 'fire', 'use', 'run'];
  const fields = ['key_up', 'key_down', 'key_strafeleft', 'key_straferight', 'key_left', 'key_right', 'key_fire', 'key_use', 'key_speed'];
  const defaults = { forward: 'KeyW', backward: 'KeyS', strafe_left: 'KeyA', strafe_right: 'KeyD', left: 'ArrowLeft', right: 'ArrowRight', fire: 'Space', use: 'KeyE', run: 'ShiftLeft' };
  const scans = { Space: 57, ShiftLeft: 54, ArrowUp: 72, ArrowDown: 80, ArrowLeft: 75, ArrowRight: 77 };
  for (const [letters, first] of [['QWERTYUIOP', 16], ['ASDFGHJKL', 30], ['ZXCVBNM', 44]]) {
    [...letters].forEach((letter, i) => { scans['Key' + letter] = first + i; });
  }
  function canonical(code) { return code === 'ShiftRight' ? 'ShiftLeft' : code; }
  function fresh() { return { keys: { ...defaults }, mouse: ['fire', 'none', 'none'] }; }
  function validate(value) {
    if (!value || !value.keys || !Array.isArray(value.mouse) || value.mouse.length !== 3) return false;
    const keys = actions.map(action => value.keys[action]);
    return keys.every(code => Object.hasOwn(scans, code)) && new Set(keys).size === actions.length &&
      value.mouse.every(action => ['fire', 'use', 'none'].includes(action));
  }
  function restore(value) { return validate(value) ? { keys: { ...value.keys }, mouse: [...value.mouse] } : fresh(); }
  function assign(value, action, code) {
    code = canonical(code);
    if (!actions.includes(action) || !Object.hasOwn(scans, code)) return 'dos.remap_reserved';
    if (actions.some(other => other !== action && value.keys[other] === code)) return 'dos.remap_duplicate';
    value.keys[action] = code; return '';
  }
  function overrides(value) {
    const config = restore(value);
    return Object.fromEntries(actions.map((action, i) => [fields[i], scans[config.keys[action]]]));
  }
  const api = { actions, defaults, canonical, fresh, validate, restore, assign, overrides };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DosBindings = api;
})(typeof window !== 'undefined' ? window : globalThis);
