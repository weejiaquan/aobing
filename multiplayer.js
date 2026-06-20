'use strict';
// osu! multiplayer client. Pure core (MP_ENGINE) is Node-testable; browser
// wiring is guarded by `typeof document`. Fully isolated from osustd.js: a
// failure here must never affect single-player.
(function () {
  function buildAuth(token) { return { type: 'auth', token: token }; }
  function buildCreate(opts) {
    opts = opts || {};
    return { type: 'create_lobby', name: opts.name, password: opts.password,
             listed: opts.listed !== false, discord: opts.discord || null };
  }
  function buildJoin(id, password) {
    return { type: 'join_lobby', id: id, password: password };
  }
  function buildLeave() { return { type: 'leave_lobby' }; }

  function applyServerMessage(state, msg) {
    const next = { status: state.status, uid: state.uid,
                   lobby: state.lobby, error: state.error };
    switch (msg.type) {
      case 'auth_ok':
        next.status = 'online'; next.uid = msg.uid; break;
      case 'lobby_state':
      case 'member_joined':
      case 'member_left':
        next.lobby = msg.lobby; break;
      case 'error':
        next.error = msg.code; break;
      default:
        break;
    }
    return next;
  }

  const ENGINE = {
    MP_ENGINE: true,
    buildAuth: buildAuth, buildCreate: buildCreate,
    buildJoin: buildJoin, buildLeave: buildLeave,
    applyServerMessage: applyServerMessage,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  if (typeof window !== 'undefined') window.MpEngine = ENGINE;
})();
