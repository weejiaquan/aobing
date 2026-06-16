'use strict';

/*
 * presence.js — Discord Activity presence panel + dual-identity leaderboard-photo helpers.
 *
 * Two halves, mirroring typing.js:
 *   1. A PURE layer (no DOM, no Firebase) — unit-tested in presence.test.js:
 *      resolveLeaderboardPhoto / photoOptionsFor / buildRows.
 *   2. Browser wiring exposing window.Presence.init(deps) — guarded by `typeof document`.
 *
 * Presence model: PURE RTDB (no Discord SDK roster). Each client publishes its own node
 * at activities/{instanceId}/participants/{uid} carrying its Discord identity (id, name,
 * avatar — from kei-bot's token response) plus its in-game identity + click totals. The
 * panel renders entirely from those nodes, so it never needs the SDK's authenticated
 * participants API (which a server-side-token-exchange Activity can't call → error 4006).
 * onDisconnect flips the node to active:false (kept, not removed) so departed players can
 * be listed under a "Left" section instead of vanishing.
 *
 * Exported via module.exports for Node tests and window.PresenceEngine in the browser.
 * Discord-Activity-only: app.js calls init() only when window.__ACTIVITY__ is present.
 */

// =========================================================================
// PURE: leaderboard photo resolution
// =========================================================================
// The leaderboard NAME is always the user's custom displayName; only the PHOTO is
// selectable. 'google' (default) → profile.photoURL; 'discord' → the captured Discord
// avatar; 'none' → blank. Kept in lock-step with the relaxed leaderboard photoURL rule.
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
// 'Hidden' (none) is always available. Google/Discord offered only when that identity
// exists. provider 'discord' users have no separate Google photo.
function photoOptionsFor(identity) {
  var opts = [];
  if (identity && identity.hasGoogle) opts.push('google');
  if (identity && identity.hasDiscord) opts.push('discord');
  opts.push('none');
  return opts;
}

// =========================================================================
// PURE: turn the RTDB participant nodes into sorted render rows
// =========================================================================
// nodes: { <uid>: { discordId, discordName, discordPhotoURL, name, photoURL,
//                   totalClicks, sessionClicks, active, leftAt } }
// Returns rows sorted: ACTIVE first (by sessionClicks desc, self wins ties), then the
// LEFT members (active === false) by most-recently-left. A missing `active` field counts
// as active (backward-compatible with nodes written before this field existed).
//   row = { uid, discordId, discordName, discordPhotoURL, name, photoURL,
//           totalClicks, sessionClicks, active, leftAt, isSelf }
function buildRows(nodes, selfDiscordId) {
  nodes = nodes || {};
  var self = selfDiscordId == null ? null : String(selfDiscordId);
  var rows = Object.keys(nodes).map(function (uid) {
    var n = nodes[uid] || {};
    var did = n.discordId != null ? String(n.discordId) : '';
    return {
      uid: uid,
      discordId: did,
      discordName: n.discordName || '',
      discordPhotoURL: n.discordPhotoURL || '',
      name: n.name || '',
      photoURL: n.photoURL || '',
      totalClicks: n.totalClicks || 0,
      sessionClicks: n.sessionClicks || 0,
      active: n.active !== false,
      leftAt: n.leftAt || 0,
      isSelf: self != null && did === self,
    };
  });
  rows.sort(function (a, b) {
    if (a.active !== b.active) return a.active ? -1 : 1;          // active block first
    if (a.active) {
      if (b.sessionClicks !== a.sessionClicks) return b.sessionClicks - a.sessionClicks;
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return (a.discordName || a.name || '').localeCompare(b.discordName || b.name || '');
    }
    return (b.leftAt || 0) - (a.leftAt || 0);                    // left block: most recent first
  });
  return rows;
}

var PRESENCE_ENGINE = {
  resolveLeaderboardPhoto: resolveLeaderboardPhoto,
  photoOptionsFor: photoOptionsFor,
  buildRows: buildRows,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PRESENCE_ENGINE;
}
if (typeof window !== 'undefined') {
  window.PresenceEngine = PRESENCE_ENGINE;
}

// =========================================================================
// Browser wiring — window.Presence.init(deps). DOM/Firebase live here.
// =========================================================================
if (typeof document !== 'undefined') {
  var _state = null;

  function _esc(deps, s) {
    if (deps && typeof deps.escapeHtml === 'function') return deps.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _serverTs() {
    return (typeof firebase !== 'undefined' && firebase.database)
      ? firebase.database.ServerValue.TIMESTAMP : Date.now();
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
    // Reposition to the bottom-right (just above the #system-time clock) so the panel
    // clears the top-left settings/skins buttons. Inline styles override index.html CSS.
    panel.style.top = 'auto';
    panel.style.left = 'auto';
    panel.style.right = '12px';
    panel.style.bottom = '60px';
    // Styles for elements not defined in index.html's CSS (the "Left" subheader + dim).
    if (!document.getElementById('presence-extra-style')) {
      var st = document.createElement('style');
      st.id = 'presence-extra-style';
      st.textContent =
        '.presence-subhead{font-size:.6rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;'
        + 'color:var(--ba-text-muted,#5a6b80);margin:7px 2px 2px;opacity:.85;'
        + 'border-top:1px solid rgba(31,44,64,.12);padding-top:5px;}'
        + '.presence-row.presence-left{opacity:.5;}'
        + '.presence-row.presence-left .presence-session{color:var(--ba-text-muted,#5a6b80);}';
      document.head.appendChild(st);
    }
    return document.getElementById('presence-list');
  }

  function _rowHtml(deps, img, r) {
    var name1 = r.discordName || r.name || '—';
    var av1 = r.discordPhotoURL
      ? '<img class="presence-av" src="' + img(r.discordPhotoURL) + '" alt="">'
      : '<div class="presence-av presence-av-ph">' + _esc(deps, (name1 || '?').slice(0, 1)) + '</div>';
    var youTag = r.isSelf ? '<span class="presence-you">you</span>' : '';
    // Row 2 = in-game identity, shown only when it differs from the Discord name.
    var row2 = '';
    if (r.name && r.name !== r.discordName) {
      var av2 = r.photoURL
        ? '<img class="presence-av-sm" src="' + img(r.photoURL) + '" alt="">'
        : '<div class="presence-av-sm presence-av-ph">' + _esc(deps, (r.name || '?').slice(0, 1)) + '</div>';
      row2 = '<div class="presence-row2">' + av2 +
        '<span class="presence-game-name">' + _esc(deps, r.name) + '</span></div>';
    }
    return (
      '<div class="presence-row' + (r.isSelf ? ' presence-self' : '') + (r.active ? '' : ' presence-left') + '">' +
      '<div class="presence-ident">' + av1 +
      '<div class="presence-names"><div class="presence-row1">' +
      '<span class="presence-dname">' + _esc(deps, name1) + '</span>' + youTag + '</div>' + row2 + '</div></div>' +
      '<div class="presence-clicks">' +
      '<span class="presence-total">' + (r.totalClicks || 0).toLocaleString() + '</span>' +
      '<span class="presence-session">+' + (r.sessionClicks || 0).toLocaleString() + '</span>' +
      '</div></div>'
    );
  }

  function _render(deps, listEl, rows) {
    if (!listEl) return;
    var img = deps.activityImg || function (u) { return u; };
    var active = rows.filter(function (r) { return r.active; });
    var left = rows.filter(function (r) { return !r.active; });
    var html =
      '<div class="presence-head"><span class="presence-title">In this Activity</span>' +
      '<span class="presence-count">' + active.length + '</span></div>';
    html += active.map(function (r) { return _rowHtml(deps, img, r); }).join('');
    if (left.length) {
      html += '<div class="presence-subhead">Left</div>';
      html += left.map(function (r) { return _rowHtml(deps, img, r); }).join('');
    }
    listEl.innerHTML = html;
    var panel = document.getElementById('presence-panel');
    if (panel) panel.style.display = rows.length ? 'block' : 'none';
  }

  function _writeSelf(deps) {
    if (!_state) return;
    var s;
    try { s = deps.getSelfState ? deps.getSelfState() : null; } catch (e) { s = null; }
    if (!s) return;
    var A = deps.activity;
    var payload = {
      discordId: String(A.discordId == null ? '' : A.discordId),
      discordName: (A.discordName || '').slice(0, 64),
      discordPhotoURL: (A.discordPhotoURL || '').slice(0, 500),
      name: (s.name || '').slice(0, 64),
      photoURL: (s.photoURL || '').slice(0, 500),
      totalClicks: s.totalClicks || 0,
      sessionClicks: s.sessionClicks || 0,
      active: true,
      updatedAt: _serverTs(),
    };
    var sig = payload.name + '|' + payload.photoURL + '|' + payload.totalClicks + '|' + payload.sessionClicks;
    if (sig === _state.lastSig) return;
    // Optimistic dedup; clear on failure so the next tick retries.
    _state.lastSig = sig;
    _state.selfRef.update(payload).catch(function () { if (_state) _state.lastSig = null; });
  }

  function _recompute() {
    if (!_state) return;
    var rows = PRESENCE_ENGINE.buildRows(_state.nodes, _state.selfDiscordId);
    _render(_state.deps, _state.listEl, rows);
  }

  function _destroy() {
    if (!_state) return;
    try { if (_state.timer) clearInterval(_state.timer); } catch (e) {}
    try { if (_state.nodesRef) _state.nodesRef.off('value', _state.nodesCb); } catch (e) {}
    try { if (_state.selfRef) _state.selfRef.onDisconnect().cancel(); } catch (e) {}
    // Mark left (not remove) so an explicit teardown still records the departure.
    try { if (_state.selfRef) _state.selfRef.update({ active: false, leftAt: _serverTs() }).catch(function () {}); } catch (e) {}
    _state = null;
  }

  function init(deps) {
    if (!deps || !deps.db || !deps.activity) return;
    var A = deps.activity;
    // Need a real instance AND a trusted Discord id (the RTDB rule rejects a node whose
    // discordId !== the token's discord_id claim).
    if (!A.instanceId || A.uid == null || A.discordId == null) return;
    if (_state) _destroy();

    var base = 'activities/' + A.instanceId + '/participants';
    var selfRef = deps.db.ref(base + '/' + A.uid);
    var nodesRef = deps.db.ref(base);

    _state = {
      deps: deps,
      listEl: _ensurePanel(),
      selfRef: selfRef,
      nodesRef: nodesRef,
      selfDiscordId: String(A.discordId),
      nodes: {},
      lastSig: null,
      timer: null,
      nodesCb: null,
    };

    // On disconnect, flip to active:false (+ leftAt) instead of removing, so the player
    // moves to the "Left" section rather than disappearing.
    try { selfRef.onDisconnect().update({ active: false, leftAt: _serverTs() }); } catch (e) {}
    _writeSelf(deps);
    _state.timer = setInterval(function () { _writeSelf(deps); }, 3000);

    // Everyone's node in this instance (keyed by uid). This is the only data source.
    _state.nodesCb = nodesRef.on('value', function (snap) {
      var map = snap.val() || {};
      if (_state) { _state.nodes = map; _recompute(); }
    });

    _recompute();
  }

  window.Presence = { init: init, destroy: _destroy, _recompute: _recompute };
}
