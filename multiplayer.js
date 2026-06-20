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

  function u8ToB64(u8) {
    let s = '';
    const CH = 0x8000; // chunk to avoid String.fromCharCode arg overflow
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function b64ToU8(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  function encodeChartTransfer(record) {
    return JSON.stringify({
      meta: {
        hash: record.hash, title: record.title, artist: record.artist,
        diffName: record.diffName, stars: record.stars, length: record.length,
      },
      osuText: record.osuText,
      audio: u8ToB64(record.audio),
      art: record.art ? u8ToB64(record.art) : null,
    });
  }

  function decodeChartTransfer(str) {
    const o = JSON.parse(str);
    return {
      osuText: o.osuText,
      audio: b64ToU8(o.audio),
      art: o.art ? b64ToU8(o.art) : null,
      hash: o.meta.hash, title: o.meta.title, artist: o.meta.artist,
      diffName: o.meta.diffName, stars: o.meta.stars, length: o.meta.length,
    };
  }

  function chunkString(str, size) {
    const frames = [];
    if (str.length === 0) return [{ seq: 0, total: 1, data: '' }];
    const total = Math.ceil(str.length / size);
    for (let i = 0, seq = 0; i < str.length; i += size, seq++) {
      frames.push({ seq: seq, total: total, data: str.slice(i, i + size) });
    }
    return frames;
  }

  function createReassembler() {
    let total = null;
    const parts = {}; // seq -> data
    let count = 0;
    return {
      add: function (frame) {
        if (total == null) total = frame.total;
        if (!(frame.seq in parts)) { parts[frame.seq] = frame.data; count++; }
        return total != null && count === total;
      },
      isComplete: function () { return total != null && count === total; },
      received: function () { return count; },
      total: function () { return total; },
      result: function () {
        if (total == null || count !== total) return null;
        let s = '';
        for (let i = 0; i < total; i++) s += parts[i];
        return s;
      },
    };
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
    u8ToB64: u8ToB64, b64ToU8: b64ToU8,
    encodeChartTransfer: encodeChartTransfer, decodeChartTransfer: decodeChartTransfer,
    chunkString: chunkString, createReassembler: createReassembler,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  if (typeof window !== 'undefined') window.MpEngine = ENGINE;
})();

// =========================================================================
// Browser wiring — window.MpUI.open(container). Lobby browser + in-lobby view.
// Isolated: never imported by osustd.js; failures here stay contained.
if (typeof document !== 'undefined') {
  const KEI = (typeof KEI_BASE !== 'undefined') ? KEI_BASE : 'https://kei.aobing.it';
  let conn = null;

  function el(tag, props, children) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  function getToken() { return firebase.auth().currentUser.getIdToken(); }

  function renderOffline(container, why) {
    container.innerHTML = '';
    container.appendChild(el('p', { textContent: 'Multiplayer is offline right now.' }));
    container.appendChild(el('p', { textContent: why || '', className: 'mp-sub' }));
  }

  function renderLobby(container, state) {
    container.innerHTML = '';
    const lobby = state.lobby;
    container.appendChild(el('h3', { textContent: lobby.name }));
    const list = el('ul', {});
    Object.keys(lobby.members).forEach(function (uid) {
      const m = lobby.members[uid];
      const tag = (uid === lobby.host_uid) ? ' (host)' : '';
      list.appendChild(el('li', { textContent: m.name + tag }));
    });
    container.appendChild(list);
    container.appendChild(el('button', {
      textContent: 'Leave', onclick: function () { conn.send(MpEngine.buildLeave()); conn.close(); conn = null; openBrowser(container); },
    }));
  }

  function onState(container, state) {
    if (state.status === 'offline') { renderOffline(container, 'Lost connection.'); return; }
    if (state.lobby) { renderLobby(container, state); }
  }

  function ensureConn(container) {
    if (conn) return conn;
    conn = MpEngine.createConnection({
      url: KEI.replace(/^http/, 'ws') + '/api/mp/ws',
      getToken: getToken,
      onState: function (s) { onState(container, s); },
    });
    return conn;
  }

  function openBrowser(container) {
    container.innerHTML = '';
    container.appendChild(el('h3', { textContent: 'Multiplayer lobbies' }));
    fetch(KEI + '/api/mp/lobbies').then(function (r) { return r.json(); })
      .then(function (body) {
        const create = el('button', {
          textContent: 'Create lobby',
          onclick: function () {
            const name = prompt('Lobby name?') || 'Lobby';
            ensureConn(container).send(MpEngine.buildCreate({ name: name }));
          },
        });
        container.appendChild(create);
        body.lobbies.forEach(function (row) {
          const label = row.name + ' — ' + row.hostName + ' (' +
            row.playerCount + '/' + row.cap + ')' + (row.hasPassword ? ' 🔒' : '');
          container.appendChild(el('button', {
            textContent: label,
            onclick: function () {
              const pw = row.hasPassword ? (prompt('Password?') || '') : undefined;
              ensureConn(container).send(MpEngine.buildJoin(row.id, pw));
            },
          }));
        });
      })
      .catch(function () { renderOffline(container, 'Could not reach the lobby server.'); });
  }

  window.MpUI = { open: openBrowser };
}
