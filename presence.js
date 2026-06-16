'use strict';

/*
 * presence.js — Discord Activity presence panel + dual-identity leaderboard-photo helpers.
 *
 * Two halves, mirroring typing.js:
 *   1. A PURE layer (no DOM, no Firebase, no Discord SDK) — unit-tested in
 *      presence.test.js. resolveLeaderboardPhoto / photoOptionsFor / mergeParticipants.
 *   2. Browser wiring exposing window.Presence.init(deps) — guarded by `typeof document`.
 *      The host (app.js) injects every dependency (db, the Activity handle, activityImg,
 *      a getSelfState() snapshot fn); presence.js never reaches into app.js's closure.
 *
 * The pure layer is exported via module.exports for Node tests and attached to
 * window.PresenceEngine in the browser.
 *
 * Feature is Discord-Activity-only: app.js calls init() only when window.__ACTIVITY__ is
 * present, so this file is inert on the normal web.
 */

// =========================================================================
// PURE: leaderboard photo resolution
// =========================================================================
// The leaderboard NAME is always the user's custom displayName; only the PHOTO is
// selectable. 'google' (default) → the in-game profile.photoURL; 'discord' → the
// captured Discord avatar; 'none' → blank (the board renders a letter placeholder).
// The RTDB rule for leaderboard photoURL is relaxed to accept exactly these three
// values, so this function and that rule must stay in lock-step.
function resolveLeaderboardPhoto(profile) {
  if (!profile) return '';
  var pref = profile.leaderboardPhoto || 'google';
  if (pref === 'none') return '';
  if (pref === 'discord') return profile.discordPhotoURL || '';
  return profile.photoURL || '';
}

// =========================================================================
// PURE: which photo-source options to offer in the profile picker
// =========================================================================
// 'Hidden' (none) is always available — anyone may hide a sensitive picture. Google
// and Discord are offered only when that identity actually exists. provider 'discord'
// users have no separate Google photo (their profile.photoURL IS the Discord avatar).
function photoOptionsFor(identity) {
  var opts = [];
  if (identity && identity.hasGoogle) opts.push('google');
  if (identity && identity.hasDiscord) opts.push('discord');
  opts.push('none');
  return opts;
}

// =========================================================================
// PURE: merge the Discord roster with the RTDB game nodes into render rows
// =========================================================================
// roster: [{ discordId, username, avatarURL }]  — Discord SDK, the presence authority + identity.
// nodes:  { <discordId>: { name, photoURL, totalClicks, sessionClicks } } — RTDB game state.
// Returns rows sorted by sessionClicks desc (self wins ties), each:
//   { discordId, username, avatarURL, isSelf, hasGame, name, photoURL, totalClicks, sessionClicks }
// Orphan nodes (in RTDB but not in the roster — e.g. the participants API is unavailable
// or mid-sync) are synthesised from their own game node so an active player is never hidden.
function mergeParticipants(roster, nodes, selfDiscordId) {
  roster = roster || [];
  nodes = nodes || {};
  var self = selfDiscordId == null ? null : String(selfDiscordId);

  function rowFrom(p, n) {
    return {
      discordId: String(p.discordId),
      username: p.username || '',
      avatarURL: p.avatarURL || '',
      isSelf: self != null && String(p.discordId) === self,
      hasGame: !!n,
      name: n ? (n.name || '') : '',
      photoURL: n ? (n.photoURL || '') : '',
      totalClicks: n ? (n.totalClicks || 0) : 0,
      sessionClicks: n ? (n.sessionClicks || 0) : 0,
    };
  }

  var seen = {};
  var rows = roster.map(function (p) {
    seen[String(p.discordId)] = true;
    return rowFrom(p, nodes[p.discordId] || null);
  });
  Object.keys(nodes).forEach(function (did) {
    if (seen[did]) return;
    var n = nodes[did];
    rows.push(rowFrom({ discordId: did, username: n.name || '', avatarURL: n.photoURL || '' }, n));
  });

  rows.sort(function (a, b) {
    if (b.sessionClicks !== a.sessionClicks) return b.sessionClicks - a.sessionClicks;
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return (a.username || '').localeCompare(b.username || '');
  });
  return rows;
}

var PRESENCE_ENGINE = {
  resolveLeaderboardPhoto: resolveLeaderboardPhoto,
  photoOptionsFor: photoOptionsFor,
  mergeParticipants: mergeParticipants,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PRESENCE_ENGINE;
}
if (typeof window !== 'undefined') {
  window.PresenceEngine = PRESENCE_ENGINE;
}

// =========================================================================
// Browser wiring — window.Presence.init(deps). DOM/Firebase/SDK live here and
// are dependency-injected by app.js. Guarded so Node tests never run it.
// =========================================================================
if (typeof document !== 'undefined') {
  var _state = null; // active session handle, so a re-init can tear down cleanly.

  function _esc(deps, s) {
    if (deps && typeof deps.escapeHtml === 'function') return deps.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Normalise one Discord SDK participant into { discordId, username, avatarURL }.
  function _normParticipant(p) {
    if (!p || p.id == null) return null;
    var name = p.global_name || p.nickname || p.username || '';
    var avatar = '';
    if (p.avatar) {
      avatar = 'https://cdn.discordapp.com/avatars/' + p.id + '/' + p.avatar + '.png?size=64';
    } else {
      // Default avatar bucket — works without an avatar hash.
      var idx = 0;
      try { idx = Number(BigInt(p.id) % 5n); } catch (e) { idx = 0; }
      avatar = 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png';
    }
    return { discordId: String(p.id), username: name, avatarURL: avatar };
  }

  function _normRoster(payload) {
    var arr = (payload && payload.participants) || [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var n = _normParticipant(arr[i]);
      if (n) out.push(n);
    }
    return out;
  }

  function _ensurePanel() {
    var panel = document.getElementById('presence-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'presence-panel';
      var list = document.createElement('div');
      list.id = 'presence-list';
      panel.appendChild(list);
      document.body.appendChild(panel);
    }
    return document.getElementById('presence-list');
  }

  function _render(deps, listEl, rows) {
    if (!listEl) return;
    var img = deps.activityImg || function (u) { return u; };
    var head =
      '<div class="presence-head">' +
      '<span class="presence-title">In this Activity</span>' +
      '<span class="presence-count">' + rows.length + '</span>' +
      '</div>';
    var body = rows.map(function (r) {
      var dAvatar = r.avatarURL
        ? '<img class="presence-av" src="' + img(r.avatarURL) + '" alt="">'
        : '<div class="presence-av presence-av-ph">' + _esc(deps, (r.username || '?').slice(0, 1)) + '</div>';
      var youTag = r.isSelf ? '<span class="presence-you">you</span>' : '';
      var row2 = '';
      if (r.hasGame && r.name) {
        var gAvatar = r.photoURL
          ? '<img class="presence-av-sm" src="' + img(r.photoURL) + '" alt="">'
          : '<div class="presence-av-sm presence-av-ph">' + _esc(deps, (r.name || '?').slice(0, 1)) + '</div>';
        row2 =
          '<div class="presence-row2">' + gAvatar +
          '<span class="presence-game-name">' + _esc(deps, r.name) + '</span>' +
          '</div>';
      }
      return (
        '<div class="presence-row' + (r.isSelf ? ' presence-self' : '') + '">' +
        '<div class="presence-ident">' +
        dAvatar +
        '<div class="presence-names">' +
        '<div class="presence-row1">' +
        '<span class="presence-dname">' + _esc(deps, r.username || '—') + '</span>' + youTag +
        '</div>' + row2 +
        '</div>' +
        '</div>' +
        '<div class="presence-clicks">' +
        '<span class="presence-total">' + (r.totalClicks || 0).toLocaleString() + '</span>' +
        '<span class="presence-session">+' + (r.sessionClicks || 0).toLocaleString() + '</span>' +
        '</div>' +
        '</div>'
      );
    }).join('');
    listEl.innerHTML = head + body;
    // Always-visible while there's anyone in the instance; hidden when empty (and so
    // never shown on the normal web, where init() is never called).
    var panel = document.getElementById('presence-panel');
    if (panel) panel.style.display = rows.length ? 'block' : 'none';
  }

  function _writeSelf(deps) {
    if (!_state) return;
    var s;
    try { s = deps.getSelfState ? deps.getSelfState() : null; } catch (e) { s = null; }
    if (!s) return;
    var payload = {
      discordId: String(deps.activity.discordId == null ? '' : deps.activity.discordId),
      name: (s.name || '').slice(0, 64),
      photoURL: (s.photoURL || '').slice(0, 500),
      totalClicks: s.totalClicks || 0,
      sessionClicks: s.sessionClicks || 0,
      updatedAt: (typeof firebase !== 'undefined' && firebase.database)
        ? firebase.database.ServerValue.TIMESTAMP : Date.now(),
    };
    // Skip a redundant write when nothing user-visible changed (the timestamp alone
    // isn't worth a write — it keeps RTDB chatter down on an idle participant).
    var sig = payload.name + '|' + payload.photoURL + '|' + payload.totalClicks + '|' + payload.sessionClicks;
    if (sig === _state.lastSig) return;
    // Optimistically dedup (so concurrent ticks don't double-write the same payload),
    // but clear the signature on failure so the next tick retries — otherwise a single
    // failed write would suppress the node forever while the user is idle.
    _state.lastSig = sig;
    _state.selfRef.update(payload).catch(function () { if (_state) _state.lastSig = null; });
  }

  function _recompute() {
    if (!_state) return;
    var rows = PRESENCE_ENGINE.mergeParticipants(_state.roster, _state.nodes, _state.selfDiscordId);
    _render(_state.deps, _state.listEl, rows);
  }

  function _destroy() {
    if (!_state) return;
    try { if (_state.timer) clearInterval(_state.timer); } catch (e) {}
    try { if (_state.nodesRef) _state.nodesRef.off('value', _state.nodesCb); } catch (e) {}
    try { if (_state.unsubRoster) _state.unsubRoster(); } catch (e) {}
    try { if (_state.selfRef) _state.selfRef.onDisconnect().cancel(); } catch (e) {}
    try { if (_state.selfRef) _state.selfRef.remove().catch(function () {}); } catch (e) {}
    _state = null;
  }

  function init(deps) {
    if (!deps || !deps.db || !deps.activity) return;
    var A = deps.activity;
    // Need a real instance AND a trusted Discord id: it's the merge key and the RTDB
    // rule rejects a participant node whose discordId !== the token's discord_id claim.
    if (!A.instanceId || A.uid == null || A.discordId == null) return;
    if (_state) _destroy(); // idempotent re-init

    var base = 'activities/' + A.instanceId + '/participants';
    var selfRef = deps.db.ref(base + '/' + A.uid);
    var nodesRef = deps.db.ref(base);

    _state = {
      deps: deps,
      listEl: _ensurePanel(),
      selfRef: selfRef,
      nodesRef: nodesRef,
      selfDiscordId: A.discordId == null ? null : String(A.discordId),
      roster: [],
      nodes: {},
      lastSig: null,
      timer: null,
      nodesCb: null,
      unsubRoster: null,
    };

    // Self-clean on leave/close, then publish our first snapshot.
    try { selfRef.onDisconnect().remove(); } catch (e) {}
    _writeSelf(deps);
    // Keep our row's clicks fresh. getSelfState reads live click totals from app.js.
    _state.timer = setInterval(function () { _writeSelf(deps); }, 3000);

    // RTDB: everyone's game node in this instance, keyed in the map by discordId.
    _state.nodesCb = nodesRef.on('value', function (snap) {
      var map = {};
      var val = snap.val() || {};
      Object.keys(val).forEach(function (uid) {
        var n = val[uid];
        if (n && n.discordId != null) map[String(n.discordId)] = n;
      });
      if (_state) { _state.nodes = map; _recompute(); }
    });

    // Discord SDK: the authoritative roster (identity + presence). Seed once, then subscribe.
    if (typeof A.getParticipants === 'function') {
      Promise.resolve().then(function () { return A.getParticipants(); })
        .then(function (payload) {
          if (_state) { _state.roster = _normRoster(payload); _recompute(); }
        })
        .catch(function () { /* roster unavailable — orphan-node fallback still renders players */ });
    }
    if (typeof A.subscribeParticipants === 'function') {
      try {
        _state.unsubRoster = A.subscribeParticipants(function (payload) {
          if (_state) { _state.roster = _normRoster(payload); _recompute(); }
        });
      } catch (e) { /* ignore */ }
    }

    _recompute();
  }

  window.Presence = { init: init, destroy: _destroy, _recompute: _recompute };
}
