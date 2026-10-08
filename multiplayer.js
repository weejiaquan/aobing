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
  function buildSelectMap(map) { return { type: 'select_map', map: map }; }
  function buildRelay(toUid, body) { return { type: 'relay', to_uid: toUid, body: body }; }

  function applyServerMessage(state, msg) {
    const next = Object.assign({}, state);
    if (msg.type === 'auth_ok') { next.status = 'online'; next.uid = msg.uid; next.error = null; next.protocol = msg.protocol || 1; }
    if (msg.type !== 'activity_lobby' && (['lobby_state','member_joined','member_left','countdown'].includes(msg.type) || msg.lobby)) {
      next.lobby = msg.lobby || null;
      next.currentMap = next.lobby ? next.lobby.current_map : null;
      next.error = null;
    }
    if (msg.type === 'error') next.error = msg.code;
    if (msg.type === 'map_selected') next.currentMap = msg.map;
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
      samples: (record.samples || []).map(s => ({name:s.name,bytes:u8ToB64(s.bytes)})),
    });
  }

  function decodeChartTransfer(str) {
    const o = JSON.parse(str);
    return {
      osuText: o.osuText,
      audio: b64ToU8(o.audio),
      art: o.art ? b64ToU8(o.art) : null,
      samples: (o.samples || []).map(s => ({name:s.name,bytes:b64ToU8(s.bytes)})),
      hash: o.meta.hash, title: o.meta.title, artist: o.meta.artist,
      diffName: o.meta.diffName, stars: o.meta.stars, length: o.meta.length,
    };
  }

  function chunkString(str, size) {
    if (!Number.isInteger(size) || size < 1) throw new Error('invalid chunk size');
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
    let count = 0, bytes = 0;
    return {
      add: function (frame) {
        if (!frame || !Number.isInteger(frame.total) || frame.total < 1 || frame.total > 16384 ||
            !Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq >= frame.total ||
            typeof frame.data !== 'string' || frame.data.length > 49152) throw new Error('invalid frame');
        if (total == null) total = frame.total;
        if (frame.seq in parts) {
          if (parts[frame.seq] !== frame.data) throw new Error('conflicting frame');
          return count === total;
        }
        if (frame.total !== total) throw new Error('inconsistent frame');
        bytes += frame.data.length;
        if (bytes > 64 * 1024 * 1024) throw new Error('transfer too large');
        parts[frame.seq] = frame.data; count++;
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

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function digest(value) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
  }
  async function contentDigest(encoded) {
    const o = JSON.parse(encoded);
    return digest(JSON.stringify({osuText:o.osuText,audio:o.audio,art:o.art || null,samples:o.samples || []}));
  }
  async function verifyTransfer(encoded, map) {
    if (typeof encoded !== 'string' || encoded.length > 64 * 1024 * 1024 || await contentDigest(encoded) !== map.contentHash) throw new Error('corrupted');
    const rec = decodeChartTransfer(encoded);
    if (rec.hash !== map.hash || await digest(rec.osuText) !== map.hash || !rec.audio.length ||
        rec.samples.length > 512 || rec.samples.some(s => typeof s.name !== 'string' || s.name.length > 256)) throw new Error('corrupted');
    return rec;
  }
  function createConnection(opts) {
    const WS = opts.WebSocketImpl || globalThis.WebSocket;
    let state = {status:'connecting',uid:null,lobby:null,error:null,currentMap:null};
    let ws, stopped = false, timer, heartbeat, lastMessage = Date.now(), pending = [], chain = Promise.resolve();
    let bestRtt = Infinity, offset = 0;
    const emit = () => { if (opts.onState) opts.onState(state); };
    function stop(error, notify = true) {
      if (stopped) return;
      stopped = true; clearTimeout(timer); clearInterval(heartbeat); pending = [];
      if (ws) { ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null; try { ws.close(); } catch (_) {} }
      state = Object.assign({},state,{status:'offline',lobby:null,currentMap:null,error:error || state.error});
      if (notify) emit();
    }
    function send(msg) {
      if (stopped) return false;
      if (state.status !== 'online') {
        if (['create_lobby','join_lobby','join_activity'].includes(msg.type) && !pending.length) { pending.push(msg); return true; }
        return false;
      }
      if (!ws || ws.readyState !== 1 || ws.bufferedAmount > 2 * 1024 * 1024) return false;
      try { ws.send(JSON.stringify(msg)); return true; } catch (_) { stop('lost_connection'); return false; }
    }
    emit();
    timer = setTimeout(() => stop('timeout'), opts.connectTimeoutMs || 8000);
    Promise.resolve().then(() => opts.getToken()).then(token => {
      if (stopped) return;
      if (!token) throw new Error('auth_required');
      ws = new WS(opts.url);
      ws.onopen = () => { if (!stopped) { try { ws.send(JSON.stringify(buildAuth(token))); } catch (_) { stop('lost_connection'); } } };
      ws.onmessage = ev => {
        if (stopped) return;
        let msg;
        try { msg = JSON.parse(ev.data); if (!msg || typeof msg.type !== 'string') throw new Error(); }
        catch (_) { stop('invalid_message'); return; }
        lastMessage = Date.now();
        state = applyServerMessage(state,msg);
        if (msg.type === 'auth_ok') {
          clearTimeout(timer);
          pending.splice(0).forEach(send);
          if (state.protocol >= 2) {
            send({type:'ping',sent:Date.now()});
            heartbeat = setInterval(() => {
              if (Date.now() - lastMessage > 45000) { stop('timeout'); return; }
              send({type:'ping',sent:Date.now()});
            },10000);
          }
        }
        if (msg.type === 'pong' && Number.isFinite(msg.sent) && Number.isFinite(msg.server_time)) {
          const rtt = Date.now() - msg.sent;
          if (rtt >= 0 && rtt < bestRtt) { bestRtt = rtt; offset = msg.server_time - (Date.now() + msg.sent)/2; }
          return;
        }
        if (msg.type === 'error' && state.status !== 'online') { stop(msg.code); return; }
        emit(); // callbacks always see the new lobby/host/map
        if (opts.onMessage) opts.onMessage(msg);
      };
      ws.onclose = ws.onerror = () => stop('lost_connection');
    }).catch(() => stop('auth_required'));
    return {
      send, close: () => stop(null,false), getState: () => state, serverNow: () => Date.now() + offset,
      sendChunk(msg, valid = () => true) {
        const work = chain.then(async () => {
          const deadline = Date.now() + 15000;
          while (!stopped && valid() && ws && ws.bufferedAmount > 256 * 1024 && Date.now() < deadline) await delay(25);
          if (stopped || !valid() || Date.now() >= deadline || !send(msg)) throw new Error('transfer stopped');
          await delay(Math.max(35, new TextEncoder().encode(JSON.stringify(msg)).length / 700)); // aggregate pacing below 1 MB/s
        });
        chain = work.catch(() => {});
        return work;
      }
    };
  }

  // One peer session per transfer; WebRTC is only an optimization. Caller owns fallback.
  function createPeerSession(opts) {
    const PC = opts.RTCPeerConnectionImpl || globalThis.RTCPeerConnection;
    let pc, channel, stopped = false, open = false, ice = [], outboundIce = [], descriptionSent = false, timer;
    const later = opts.setTimeoutImpl || setTimeout, cancel = opts.clearTimeoutImpl || clearTimeout;
    function close() {
      if (stopped) return;
      stopped = true; cancel(timer); ice = []; outboundIce = [];
      if (channel) { channel.onclose = channel.onerror = channel.onmessage = channel.onopen = null; try { channel.close(); } catch (_) {} }
      if (pc) { pc.onicecandidate = pc.onconnectionstatechange = pc.ondatachannel = null; try { pc.close(); } catch (_) {} }
    }
    function fail() { if (!stopped) { close(); opts.onFailure(); } }
    function touch() { cancel(timer); timer = later(fail,open ? 20000 : 5000); }
    function publishDescription(kind) {
      if (stopped) return;
      opts.signal({kind,data:pc.localDescription});
      descriptionSent = true;
      for (const data of outboundIce.splice(0)) opts.signal({kind:'ice',data});
    }
    function bind(dc) {
      if (stopped) { dc.close(); return; }
      channel = dc;
      dc.onopen = () => { if (stopped) return; open = true; touch(); if (opts.onOpen) opts.onOpen(api); };
      dc.onmessage = ev => { if (stopped) return; touch(); try { opts.onFrame(JSON.parse(ev.data)); } catch (_) { fail(); } };
      dc.onclose = dc.onerror = fail;
    }
    const api = {
      close,
      async signal(msg) {
        if (stopped || !pc) return;
        try {
          if (msg.kind === 'ice') {
            if (ice.length >= 128) throw new Error('too many candidates');
            if (pc.remoteDescription) await pc.addIceCandidate(msg.data); else ice.push(msg.data);
          } else if ((msg.kind === 'offer' && !opts.offerer) || (msg.kind === 'answer' && opts.offerer)) {
            await pc.setRemoteDescription(msg.data);
            for (const candidate of ice.splice(0)) await pc.addIceCandidate(candidate);
            if (!opts.offerer) { await pc.setLocalDescription(await pc.createAnswer()); publishDescription('answer'); }
          }
        } catch (_) { fail(); }
      },
      async send(encoded) {
        for (const frame of chunkString(encoded, 8192)) {
          const end = Date.now() + 15000;
          while (!stopped && channel && channel.bufferedAmount > 256 * 1024 && Date.now() < end) await delay(20);
          if (stopped || !channel || channel.readyState !== 'open' || Date.now() >= end) throw new Error('peer closed');
          channel.send(JSON.stringify(frame)); touch();
        }
      }
    };
    Promise.resolve().then(async () => {
      if (stopped) return;
      pc = new PC({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
      touch();
      pc.onicecandidate = ev => {
        if (stopped || !ev.candidate) return;
        try {
          const data = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
          if (descriptionSent) opts.signal({kind:'ice',data});
          else if (outboundIce.length < 128) outboundIce.push(data);
          else fail();
        } catch (_) { fail(); }
      };
      pc.onconnectionstatechange = () => { if (['failed','closed'].includes(pc.connectionState)) fail(); };
      pc.ondatachannel = ev => bind(ev.channel);
      if (opts.offerer) {
        bind(pc.createDataChannel('chart'));
        await pc.setLocalDescription(await pc.createOffer());
        publishDescription('offer');
      }
      if (opts.offer) await api.signal(opts.offer);
    }).catch(fail);
    return api;
  }

  const ENGINE = {
    MP_ENGINE: true, digest, contentDigest, verifyTransfer, createPeerSession,
    buildAuth: buildAuth, buildCreate: buildCreate,
    buildJoin: buildJoin, buildLeave: buildLeave,
    buildSelectMap: buildSelectMap, buildRelay: buildRelay,
    applyServerMessage: applyServerMessage,
    createConnection: createConnection,
    u8ToB64: u8ToB64, b64ToU8: b64ToU8,
    encodeChartTransfer: encodeChartTransfer, decodeChartTransfer: decodeChartTransfer,
    chunkString: chunkString, createReassembler: createReassembler,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  if (typeof window !== 'undefined') window.MpEngine = ENGINE;
})();

// Browser controller: all asynchronous work is scoped to a connection and map generation.
if (typeof document !== 'undefined') (function () {
  const KEI = typeof KEI_BASE !== 'undefined' ? KEI_BASE : 'https://kei.aobing.it';
  const M = window.MpEngine;
  const t = (key, args) => I18N.t(key, args);
  let container, conn, browseGen = 0, epoch = 0, mapKey = '', hostUid = null, status = '', prepared = null;
  let serverErrorShown = false;
  let activityPreview, previewSupported = false, previewTimer = null;
  let haveMap = false, preparing = false, receiver = null, encodedCache = null, round = null;
  const peers = new Map(), uploads = new Map();
  const dialog = () => document.getElementById('multiplayer-dialog');
  const game = () => window.OsuStdGame;
  function node(tag, props, children = []) {
    const n = document.createElement(tag); Object.assign(n, props || {});
    children.forEach(c => n.appendChild(c)); return n;
  }
  function button(label, action, disabled = false) {
    return node('button', {type:'button',textContent:label,disabled,onclick: () => Promise.resolve().then(action).catch(() => message(t('mp.action_failed')))});
  }
  function message(value) {
    status = value;
    const line = container && container.querySelector('#mp-xfer-status');
    if (line) line.textContent = value;
  }
  function getState() { return conn ? conn.getState() : {}; }
  function currentMap() { return getState().currentMap; }
  function resetTransfer(keepPrepared = false) {
    epoch++; preparing = false; encodedCache = null;
    if (!keepPrepared) { prepared = null; haveMap = false; }
    if (receiver) { clearTimeout(receiver.timer); clearTimeout(receiver.deadline); receiver = null; }
    peers.forEach(p => p.close()); peers.clear(); uploads.clear();
  }
  function teardown() {
    clearInterval(previewTimer); previewTimer = null; previewSupported = false; activityPreview = undefined;
    browseGen++; resetTransfer(); mapKey = ''; hostUid = null; round = null;
    if (conn) conn.close(); conn = null;
    if (game() && game().detachMultiplayer) game().detachMultiplayer();
    const hud = document.getElementById('mp-scoreboard'); if (hud) hud.remove();
    renderPresenceEntry();
  }
  function avatar(member) {
    const name = String(member.name || member.discordName || '?');
    const n = node('span',{className:'mp-avatar',textContent:Array.from(name)[0],title:name});
    const photo = member.photo || member.discordPhotoURL || member.photoURL;
    try {
      const url = new URL(photo);
      if (url.protocol === 'https:') {
        const img = node('img',{src:url.href,alt:'',referrerPolicy:'no-referrer'});
        img.onerror = () => img.remove(); n.appendChild(img);
        n.style.position='relative';img.style.position='absolute';img.style.inset='0';
      }
    } catch (_) {}
    return n;
  }
  function rosterStrip(members) {
    return node('span',{className:'mp-avatar-stack'},members.slice(0,6).map(avatar));
  }
  function presenceContent() {
    const lobby = getState().lobby || activityPreview;
    if(lobby) {
      const members=Object.values(lobby.members || {}),busy=['countdown','racing'].includes(lobby.phase);
      return {members,label:t('mp.in_room',{n:members.length}),hint:busy?t('mp.room_playing'):members.map(m=>m.name).join(', '),busy,full:members.length>=lobby.cap};
    }
    const members=window.Presence?.getRows?.() || [];
    if(activityPreview===null)return {members:[],label:t('mp.room_empty'),hint:t('mp.activity_people',{n:members.length})};
    return {members,label:t('mp.activity_people',{n:members.length}),hint:t('mp.room_unavailable')};
  }
  function renderPresenceEntry() {
    if(!window.__ACTIVITY__?.instanceId)return;
    const select=document.getElementById('osu-select');if(!select)return;
    if(select.hidden && !dialog().open)return;
    let entry=document.getElementById('mp-presence-entry');
    if(!entry){entry=node('div',{id:'mp-presence-entry',className:'mp-presence-entry'});const stage=select.querySelector('.rs-stage');if(stage)select.insertBefore(entry,stage);else select.appendChild(entry);}
    const info=presenceContent(),copy=node('span',{className:'mp-presence-copy'},[node('strong',{textContent:info.label}),node('small',{textContent:info.hint})]);
    const join=button(t(getState().lobby?'mp.title':'mp.join_lobby'),()=>{
      if(!dialog().open)dialog().showModal();container=document.getElementById('mp-panel');
      if(getState().lobby){renderLobby(getState());return;}
      ensureConnection();send({type:'join_activity',instance_id:window.__ACTIVITY__.instanceId});openBrowser();
    },!getState().lobby && (info.busy || info.full));
    entry.replaceChildren(rosterStrip(info.members),copy,join);
    const inside=document.getElementById('mp-activity-roster');
    if(inside)inside.replaceChildren(rosterStrip(info.members),node('span',{textContent:info.label}),node('small',{textContent:info.hint}));
    const joinCard=container?.querySelector('.mp-activity-card > button');
    if(joinCard)joinCard.disabled=!!(info.busy||info.full);
  }
  function pollActivity() {
    if(document.hidden || !window.__ACTIVITY__?.instanceId)return;
    if(previewSupported && !getState().lobby && document.getElementById('osu-panel')?.classList.contains('open') && !document.getElementById('osu-select')?.hidden)conn?.send({type:'activity_lobby',instance_id:window.__ACTIVITY__.instanceId});
  }
  function activatePresence() {
    if(!window.__ACTIVITY__?.instanceId || !document.getElementById('osu-panel')?.classList.contains('open'))return;
    renderPresenceEntry();
    if(typeof firebase !== 'undefined' && firebase.auth().currentUser && !firebase.auth().currentUser.isAnonymous)ensureConnection();
  }
  function send(msg) { if (!conn || !conn.send(msg)) throw new Error('offline'); }
  function stateMessage(state) {
    const map = currentMap(); if (map) send({type:'member_state',contentHash:map.contentHash,state});
  }
  async function encodedMap(map) {
    if (!encodedCache) encodedCache = game().getChartRecord(map.hash).then(rec => {
      if (!rec) throw new Error('missing map');
      return M.encodeChartTransfer(rec);
    });
    const pending = encodedCache;
    try {
      const encoded = await pending;
      if (encoded.length > 64*1024*1024 || await M.contentDigest(encoded) !== map.contentHash) throw new Error('wrong map');
      return encoded;
    } catch (error) {
      if (encodedCache === pending) encodedCache = null;
      throw error;
    }
  }
  function transferBody(map, id, extra) { return Object.assign({hash:map.hash,contentHash:map.contentHash,transferId:id},extra); }
  function relay(uid, body) { send(M.buildRelay(uid,body)); }
  function receiverFailed() {
    if (!receiver) return;
    clearTimeout(receiver.timer); clearTimeout(receiver.deadline);
    const peer = peers.get(receiver.host); if (peer) peer.close(); peers.delete(receiver.host);
    receiver = null; message(t('mp.transfer_failed'));
    try { stateMessage('spectator'); } catch (_) {}
    renderLobby(getState());
  }
  function armReceiver() {
    if (!receiver) return;
    const tr = receiver;
    clearTimeout(tr.timer);
    tr.timer = setTimeout(() => {
      if (receiver !== tr) return;
      // An open DataChannel can still stall before its first byte. Relay remains
      // the correctness path, including when this watchdog beats the peer timer.
      if (!tr.relay && !tr.completing) fallback();
      else receiverFailed();
    },20000);
  }
  function fallback() {
    if (!receiver || receiver.relay || receiver.completing) return;
    const peer = peers.get(receiver.host); if (peer) peer.close(); peers.delete(receiver.host);
    receiver.relay = true; receiver.ra = M.createReassembler(); armReceiver();
    try { relay(receiver.host,transferBody(receiver.map,receiver.id,{t:'need_map'})); }
    catch (_) { receiverFailed(); }
  }
  async function acceptFrame(from, body, frame, viaRelay) {
    const tr = receiver;
    if (!tr || tr.completing || tr.host !== from || tr.id !== body.transferId || tr.map.contentHash !== body.contentHash || tr.map.hash !== body.hash || tr.relay !== viaRelay) return;
    try {
      armReceiver();
      const done = tr.ra.add(frame);
      message(t('mp.downloading',{received:tr.ra.received(),total:tr.ra.total()}));
      if (!done) return;
      tr.completing = true;
      clearTimeout(tr.timer);
      tr.timer = setTimeout(() => { if (receiver === tr) receiverFailed(); },30000);
      const peer = peers.get(from); if (peer) peer.close(); peers.delete(from);
      const rec = await M.verifyTransfer(tr.ra.result(),tr.map);
      if (receiver !== tr) return;
      const count = await game().importForeignCharts([Object.assign(rec,{origin:{type:'received',fromName:tr.fromName,lobby:tr.lobby,receivedAt:new Date().toISOString()}})]);
      if (receiver !== tr) return;
      if (count !== 1) throw new Error('unsupported chart');
      clearTimeout(tr.timer); clearTimeout(tr.deadline);
      receiver = null; haveMap = true; message(t('mp.saved')); renderLobby(getState());
    } catch (_) { if (receiver === tr) receiverFailed(); }
  }
  function requestMap(map, host, generation) {
    if (generation !== epoch || !conn) return;
    const lobby = getState().lobby;
    const id = globalThis.crypto.randomUUID();
    receiver = {map,host,id,ra:M.createReassembler(),relay:false,fromName:(lobby.members[host] || {}).name || '',lobby:lobby.name};
    receiver.deadline = setTimeout(receiverFailed,1200000);
    message(t('mp.requesting',{title:map.title})); armReceiver();
    const base = transferBody(map,id,{});
    const peer = M.createPeerSession({offerer:true,
      signal: msg => { if (generation === epoch) relay(host,Object.assign({},base,msg,{t:'rtc'})); },
      onFrame: frame => { acceptFrame(host,base,frame,false); }, onFailure:fallback});
    peers.set(host,peer);
  }
  async function mapChanged(map) {
    resetTransfer(); status = ''; const generation = epoch;
    if (!map || !game()) return;
    try {
      const rec = await game().getChartRecord(map.hash);
      if (generation !== epoch) return;
      const have = !!rec && await M.contentDigest(M.encodeChartTransfer(rec)) === map.contentHash;
      if (generation !== epoch) return;
      haveMap = have;
      if (haveMap) message(t('mp.already_have',{title:map.title}));
      else if (getState().uid !== getState().lobby.host_uid) requestMap(map,getState().lobby.host_uid,generation);
      else { message(t('mp.transfer_failed')); stateMessage('spectator'); }
      renderLobby(getState());
    } catch (_) { if (generation === epoch) { message(t('mp.save_failed')); try { stateMessage('spectator'); } catch (_) {} renderLobby(getState()); } }
  }
  async function onRelay(from, body) {
    const st = getState(), lobby = st.lobby, map = currentMap();
    if (!lobby || !map || !body || !lobby.members[from] || body.hash !== map.hash || body.contentHash !== map.contentHash || typeof body.transferId !== 'string') return;
    if (st.uid !== lobby.host_uid) {
      if (from !== lobby.host_uid || !receiver || receiver.id !== body.transferId) return;
      if (body.t === 'chunk') await acceptFrame(from,body,body,true);
      else if (body.t === 'transfer_error') receiverFailed();
      else if (body.t === 'rtc' && peers.has(from)) await peers.get(from).signal(body);
      return;
    }
    const generation = epoch;
    const valid = () => generation === epoch && !!getState().lobby && !!getState().lobby.members[from];
    const base = transferBody(map,body.transferId,{});
    if (body.t === 'need_map') {
      if (uploads.has(from)) return;
      uploads.set(from,body.transferId);
      const peer = peers.get(from); if (peer) peer.close(); peers.delete(from);
      try {
        const encoded = await encodedMap(map);
        for (const frame of M.chunkString(encoded,16384)) {
          if (!valid() || uploads.get(from) !== body.transferId) return;
          await conn.sendChunk(M.buildRelay(from,Object.assign({},base,frame,{t:'chunk'})), () => valid() && uploads.get(from) === body.transferId);
        }
      } catch (_) { if (valid()) relay(from,Object.assign({},base,{t:'transfer_error'})); }
      finally { if (uploads.get(from) === body.transferId) uploads.delete(from); }
    } else if (body.t === 'rtc') {
      if (body.kind === 'offer') {
        if (peers.has(from)) peers.get(from).close();
        const peer = M.createPeerSession({offerer:false,offer:body,
          signal: msg => { if (valid()) relay(from,Object.assign({},base,msg,{t:'rtc'})); },
          onFrame: () => {}, onFailure: () => {},
          onOpen: session => { encodedMap(map).then(encoded => { if (valid()) return session.send(encoded); }).catch(() => session.close()); }});
        peer.transferId = body.transferId; peers.set(from,peer);
      } else if (peers.has(from) && peers.get(from).transferId === body.transferId) await peers.get(from).signal(body);
    }
  }
  function scoreboard(lobby, target) {
    target.replaceChildren();
    const heading = node('strong',{textContent:t(lobby.phase === 'results' ? 'mp.results' : 'mp.standings')});
    target.appendChild(heading);
    const list = node('ol');
    Object.values(lobby.members).sort((a,b) => (a.state === 'forfeit')-(b.state === 'forfeit') || b.score-a.score || b.acc-a.acc || b.combo-a.combo).forEach(m => {
      list.appendChild(node('li',{textContent:m.name + ' · ' + m.score + ' · ' + Number(m.acc).toFixed(2) + '% · ' + t('mp.state_'+m.state)}));
    }); target.appendChild(list);
  }
  function updateHud(lobby) {
    let hud = document.getElementById('mp-scoreboard');
    if (!lobby || !['countdown','racing','results'].includes(lobby.phase)) { if (hud) hud.remove(); return; }
    if (!hud) { hud = node('aside',{id:'mp-scoreboard'}); document.body.appendChild(hud); }
    scoreboard(lobby,hud);
    if (lobby.phase === 'results') hud.appendChild(button(t('mp.title'),() => { if (!dialog().open) dialog().showModal(); renderLobby(getState()); }));
  }
  function launch(lobby) {
    if (!lobby.round_id || round === lobby.round_id) return;
    round = lobby.round_id;
    const roundId = round, connection = conn, map = lobby.current_map;
    const mine = lobby.members[getState().uid];
    if (!mine || mine.state !== 'playing') return;
    const report = stats => {
      if (conn === connection && getState().lobby && getState().lobby.round_id === roundId) connection.send(Object.assign({type:'score',round_id:roundId},stats));
    };
    try {
      if (!prepared || prepared.contentHash !== map.contentHash || document.hidden) throw new Error('not prepared');
      dialog().close();
      game().startMultiplayer(prepared.value,{startAt:performance.now() + lobby.start_at_epoch_ms - conn.serverNow(),onScore:report});
    } catch (_) { report({score:0,combo:0,acc:0,state:'forfeit'}); message(t('mp.start_failed')); }
    prepared = null;
  }
  function onState(state) {
    renderPresenceEntry();
    if (state.status === 'offline') {
      activityPreview=undefined;clearInterval(previewTimer);previewTimer=null;renderPresenceEntry();
      resetTransfer(); mapKey = ''; hostUid = null; updateHud(null);
      if (game() && game().detachMultiplayer) game().detachMultiplayer();
      renderOffline(state.error); return;
    }
    if (state.error) { message(t('mp.server_error',{code:state.error})); serverErrorShown = true; }
    else if (serverErrorShown) { message(''); serverErrorShown = false; }
    if (!state.lobby) return;
    const key = state.lobby.id + ':' + (state.currentMap ? state.currentMap.contentHash : '');
    const hostChanged = hostUid !== state.lobby.host_uid;
    hostUid = state.lobby.host_uid;
    if (key !== mapKey) { mapKey = key; mapChanged(state.currentMap); }
    else if (hostChanged) {
      // Ready audio belongs to the map, not its previous host. Retain it while
      // cancelling old-host transfers; otherwise the server still says Ready but
      // the next countdown would have no prepared audio and forfeit everyone.
      if (haveMap) resetTransfer(true);
      else mapChanged(state.currentMap);
    }
    for (const [uid,peer] of peers) if (!state.lobby.members[uid]) { peer.close(); peers.delete(uid); uploads.delete(uid); }
    if (state.lobby.phase === 'countdown') launch(state.lobby);
    updateHud(state.lobby);
    if (dialog().open) renderLobby(state);
  }
  function ensureConnection() {
    if (conn && getState().status !== 'offline') return;
    if (conn) teardown();
    conn = M.createConnection({url:KEI.replace(/^http/,'ws')+'/api/mp/ws',
      getToken: async () => {
        const user = firebase.auth().currentUser;
        if (!user || user.isAnonymous) throw new Error('auth_required');
        return user.getIdToken();
      }, onState,
      onMessage: msg => {
        if(msg.type==='auth_ok'){previewSupported=msg.activity_preview===true;pollActivity();clearInterval(previewTimer);if(previewSupported)previewTimer=setInterval(pollActivity,5000);}
        if(msg.type==='activity_lobby'){activityPreview=msg.lobby;renderPresenceEntry();}
        if (msg.type === 'relay') onRelay(msg.from_uid,msg.body).catch(() => message(t('mp.transfer_failed')));
      }});
  }
  function renderOffline(code) {
    if (!container) return;
    container.replaceChildren(node('p',{textContent:code === 'auth_required' ? t('mp.sign_in') : t('mp.offline')}),node('p',{textContent:code ? t('mp.server_error',{code}) : ''}),button(t('mp.retry'),() => { teardown(); openBrowser(); }));
  }
  async function ready() {
    if (preparing || !haveMap) return;
    const generation = epoch, map = currentMap(); preparing = true; renderLobby(getState());
    try {
      const value = await game().prepareMultiplayer(map.hash);
      const rec = await game().getChartRecord(map.hash);
      if (!rec || await M.contentDigest(M.encodeChartTransfer(rec)) !== map.contentHash) throw new Error('map changed');
      if (generation !== epoch) return;
      prepared = {value,contentHash:map.contentHash}; stateMessage('ready'); message('');
    } catch (_) { if (generation === epoch) message(t('mp.start_failed')); }
    finally { if (generation === epoch) { preparing = false; renderLobby(getState()); } }
  }
  function renderLobby(state) {
    const lobby = state.lobby; if (!lobby || !container) return;
    container.replaceChildren(node('div',{className:'mp-room-head'},[
      node('h3',{textContent:lobby.name}),
      node('span',{className:'mp-room-code',textContent:t('mp.room_code') + ' · ' + lobby.id})
    ]));
    const busy = ['countdown','racing'].includes(lobby.phase);
    container.appendChild(node('div',{className:'mp-map-card'},[
      node('span',{className:'mp-eyebrow',textContent:t('mp.selected_map')}),
      node('p',{textContent:lobby.current_map ? lobby.current_map.title + ' · ' + lobby.current_map.diffName : t('mp.waiting_map')})
    ]));
    const list = node('ul',{className:'mp-members'});
    Object.entries(lobby.members).forEach(([uid,m]) => {
      const badge = node('span',{className:'mp-member-state',textContent:t('mp.state_'+m.state)});
      badge.setAttribute('data-state',m.state);
      list.appendChild(node('li',{},[node('span',{className:'mp-member-person'},[avatar(m),node('span',{textContent:uid === lobby.host_uid ? t('mp.member_host',{name:m.name}) : m.name})]),badge]));
    });
    container.appendChild(list);
    const line = node('p',{id:'mp-xfer-status',textContent:status}); line.setAttribute('role','status'); container.appendChild(line);
    if (lobby.phase === 'results') { const scores = node('div'); scoreboard(lobby,scores); container.appendChild(scores); }
    const actions = node('div',{className:'mp-room-actions'}); container.appendChild(actions);
    if (!busy && state.uid === lobby.host_uid) actions.appendChild(button(t('mp.pick_map'),pickMap));
    if (!busy && lobby.current_map) {
      const readyButton = button(t('mp.ready'),ready,!haveMap || preparing || lobby.members[state.uid].state === 'ready');
      readyButton.className = 'mp-primary'; actions.appendChild(readyButton);
      actions.appendChild(button(t('mp.spectate'),() => { prepared = null; stateMessage('spectator'); }));
      if (!haveMap && !receiver) actions.appendChild(button(t('mp.retry'),() => mapChanged(currentMap())));
      if (state.uid === lobby.host_uid) actions.appendChild(button(t('mp.start'),() => send({type:'start'}),!Object.values(lobby.members).some(m => m.state === 'ready') || Object.values(lobby.members).some(m => !['ready','spectator'].includes(m.state))));
    }
    const footer = node('div',{className:'mp-room-footer'},[node('p',{textContent:t('mp.close_hint')}),button(t('mp.leave'),() => { if (conn) conn.send(M.buildLeave()); teardown(); openBrowser(); })]);
    container.appendChild(footer);
  }
  async function pickMap() {
    const generation = epoch, charts = await game().listCharts();
    if (generation !== epoch || !getState().lobby) return;
    const existing = container.querySelector('#mp-map-picker'); if (existing) existing.remove();
    const box = node('div',{id:'mp-map-picker'},[node('h4',{textContent:t('mp.pick_map_title')})]);
    if (!charts.length) box.appendChild(node('p',{textContent:t('mp.library_empty')}));
    charts.forEach(map => box.appendChild(button(t('mp.map_row',{title:map.title,diff:map.diffName}),async () => {
      const rec = await game().getChartRecord(map.hash), encoded = M.encodeChartTransfer(rec);
      if (encoded.length > 64*1024*1024) throw new Error('map too large');
      const contentHash = await M.contentDigest(encoded);
      const duration = window.OsuStdEngine.assembleChart(rec.osuText).objects.reduce((end, o) => Math.max(end, o.endTime || o.time), 0);
      if (generation !== epoch) return;
      send(M.buildSelectMap(Object.assign({},map,{contentHash,duration})));
      box.remove();
    })));
    container.appendChild(box);
  }
  function input(label, type = 'text', value = '') {
    const field = node('input',{type,value,maxLength:type === 'password' ? 128 : 64});
    return {field,label:node('label',{},[node('span',{textContent:label}),field])};
  }
  async function openBrowser() {
    if (!container) return;
    if (getState().lobby) { renderLobby(getState()); return; }
    const generation = ++browseGen;
    container.replaceChildren(node('h3',{textContent:t('mp.lobbies_title')}),node('p',{textContent:t('mp.loading')}));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),8000);
    try {
      const response = await fetch(KEI+'/api/mp/lobbies',{signal:controller.signal,cache:'no-store'});
      if (!response.ok) throw new Error('offline');
      const body = await response.json();
      if (generation !== browseGen || getState().lobby) return;
      if (!Array.isArray(body.lobbies) || body.protocol !== 2) throw new Error('server update required');
      container.replaceChildren();
      if (!firebase.auth().currentUser || firebase.auth().currentUser.isAnonymous) { renderOffline('auth_required'); return; }
      ensureConnection();
      const line = node('p',{id:'mp-xfer-status',textContent:status}); line.setAttribute('role','status'); container.appendChild(line);
      const activity = window.__ACTIVITY__ && window.__ACTIVITY__.instanceId;
      if (activity) {
        const join = button(t('mp.join_lobby'),() => send({type:'join_activity',instance_id:activity}));
        join.className = 'mp-primary'; join.setAttribute('aria-describedby','mp-activity-hint');
        container.appendChild(node('section',{className:'mp-activity-card'},[
          node('div',{},[
            node('span',{className:'mp-eyebrow',textContent:t('mp.activity_connected')}),
            node('h3',{textContent:t('mp.activity_title')}),
            node('p',{id:'mp-activity-hint',textContent:t('mp.activity_hint')}),
            node('div',{id:'mp-activity-roster',className:'mp-presence-entry'})
          ]),join
        ]));
      }
      const options = node(activity ? 'details' : 'div',{className:'mp-options'});
      if (activity) options.appendChild(node('summary',{textContent:t('mp.other_lobbies')}));
      container.appendChild(options);
      const grid = node('div',{className:'mp-entry-grid'}); options.appendChild(grid);
      const name = input(t('mp.lobby_name_prompt'),'text',t('mp.lobby_default_name'));
      const password = input(t('mp.create_password'),'password');
      password.field.autocomplete = 'new-password';
      const listed = input(t('mp.listed'),'checkbox'); listed.field.checked = true;
      const form = node('form',{id:'mp-create-form',className:'mp-entry-card'},[node('h3',{textContent:t('mp.create_lobby')}),name.label,password.label,listed.label,node('button',{type:'submit',textContent:t('mp.create_lobby')})]);
      form.onsubmit = e => { e.preventDefault(); try { send(M.buildCreate({name:name.field.value.trim() || t('mp.lobby_default_name'),password:password.field.value,listed:listed.field.checked})); } catch (_) { message(t('mp.action_failed')); } };
      grid.appendChild(form);
      const code = input(t('mp.room_code'));
      code.field.id = 'mp-room-code'; code.field.required = true; code.field.autocomplete = 'off'; code.field.spellcheck = false;
      const joinPassword = input(t('mp.join_password'),'password'); joinPassword.field.autocomplete = 'current-password';
      const joinForm = node('form',{id:'mp-join-form',className:'mp-entry-card'},[node('h3',{textContent:t('mp.join_code')}),code.label,joinPassword.label,node('button',{type:'submit',textContent:t('mp.join')})]);
      joinForm.onsubmit = e => { e.preventDefault(); if (!code.field.value.trim()) { code.field.focus(); return; } try { send(M.buildJoin(code.field.value.trim().toUpperCase(),joinPassword.field.value)); } catch (_) { message(t('mp.action_failed')); } };
      grid.appendChild(joinForm);
      const publicRooms = node('section',{className:'mp-public'},[
        node('div',{className:'mp-section-head'},[node('h3',{textContent:t('mp.lobbies_title')}),button(t('mp.refresh'),openBrowser)])
      ]);
      if (!body.lobbies.length) publicRooms.appendChild(node('p',{className:'mp-empty',textContent:t('mp.no_lobbies')}));
      body.lobbies.forEach(row => {
        const join = button(t('mp.join'),() => {
          if (row.hasPassword) { code.field.value = row.id; joinPassword.field.focus(); return; }
          send(M.buildJoin(row.id,''));
        },row.playerCount >= row.cap);
        publicRooms.appendChild(node('div',{className:'mp-lobby-row'},[
          node('div',{},[node('strong',{textContent:row.name}),node('p',{textContent:t('mp.room_details',{host:row.hostName,players:row.playerCount,cap:row.cap})}),node('span',{className:'mp-access',textContent:t(row.hasPassword ? 'mp.password_required' : 'mp.no_password')})]),join
        ]));
      });
      options.appendChild(publicRooms);
      renderPresenceEntry();
    } catch (_) { if (generation === browseGen && !getState().lobby) renderOffline('no_server'); }
    finally { clearTimeout(timer); }
  }
  window.MpUI = {open(target) { container = target; openBrowser(); },close:teardown,dismiss() { if (!getState().lobby && !window.__ACTIVITY__?.instanceId) teardown(); }};
  window.addEventListener('beforeunload',teardown);
  window.addEventListener('gamemodechange',() => { if (conn) teardown(); });
  window.addEventListener('activityrosterchange',renderPresenceEntry);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollActivity();});
  const standardPanel=document.getElementById('osu-panel');
  if(standardPanel)new MutationObserver(activatePresence).observe(standardPanel,{attributes:true,attributeFilter:['class']});
  const standardSelect=document.getElementById('osu-select');
  if(standardSelect)new MutationObserver(()=>{renderPresenceEntry();pollActivity();}).observe(standardSelect,{attributes:true,attributeFilter:['hidden']});
  activatePresence();
  window.addEventListener('i18nchange',() => { if (container && dialog().open) { if (getState().lobby) renderLobby(getState()); else openBrowser(); } });
  // An account change must not leave the old identity authenticated on the socket.
  if (typeof firebase !== 'undefined') firebase.auth().onAuthStateChanged(user => {
    if (conn && getState().uid && (!user || user.uid !== getState().uid)) { teardown(); if (container) renderOffline('auth_required'); }
  });
})();
