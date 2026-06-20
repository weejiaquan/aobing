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

  function createConnection(opts) {
    const WS = opts.WebSocketImpl ||
      (typeof WebSocket !== 'undefined' ? WebSocket : null);
    const timeoutMs = opts.connectTimeoutMs || 8000;
    let state = { status: 'connecting', uid: null, lobby: null, error: null };
    let ws = null;
    let authed = false;
    let timer = null;
    let closed = false;

    function emit() { if (opts.onState) opts.onState(state); }
    function setStatus(s) { state = Object.assign({}, state, { status: s }); emit(); }
    function fail() {
      if (closed) return;
      if (timer) { clearTimeout(timer); timer = null; }
      setStatus('offline');
    }

    emit(); // initial 'connecting'
    timer = setTimeout(function () { if (!authed) fail(); }, timeoutMs);

    Promise.resolve(opts.getToken()).then(function (token) {
      if (closed) return;
      ws = new WS(opts.url);
      ws.onopen = function () { ws.send(JSON.stringify(buildAuth(token))); };
      ws.onmessage = function (ev) {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'auth_ok') {
          authed = true;
          if (timer) { clearTimeout(timer); timer = null; }
        }
        state = applyServerMessage(state, msg);
        emit();
      };
      ws.onclose = function () { fail(); };
      ws.onerror = function () { fail(); };
    }).catch(function () { fail(); });

    return {
      send: function (msg) { if (ws && authed) ws.send(JSON.stringify(msg)); },
      close: function () {
        closed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (ws) ws.close();
      },
      getState: function () { return state; },
    };
  }

  const ENGINE = {
    MP_ENGINE: true,
    buildAuth: buildAuth, buildCreate: buildCreate,
    buildJoin: buildJoin, buildLeave: buildLeave,
    applyServerMessage: applyServerMessage,
    createConnection: createConnection,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  if (typeof window !== 'undefined') window.MpEngine = ENGINE;
})();
