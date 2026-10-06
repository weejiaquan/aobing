/* Discord launch routing and a bounded, identity-scoped completed-score queue. */
(() => {
  'use strict';
  let context = null, initialMode = null, revision = null, busy = false, timer = null;
  let queue = [], queueKey = null, initialized = false;
  const activity = () => window.__ACTIVITY__;
  const modes = new Set(['osu', 'vsrg']);
  const activeUser = () => typeof firebase !== 'undefined' ? firebase.auth().currentUser : null;
  const now = () => Date.now();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const maxAge = 12 * 60 * 60 * 1000;

  function persist() {
    queue = queue.filter(item => now() - item.createdAt < maxAge && item.expiresAt * 1000 > now()).slice(-20);
    try { if (queueKey) localStorage.setItem(queueKey, JSON.stringify(queue)); } catch (_) {}
  }
  async function request(path, data, timeoutMs = 10000) {
    const user = activeUser(), a = activity();
    if (!user || user.uid !== a?.uid) throw new Error('Activity identity changed');
    const controller = new AbortController();
    let timeout;
    try {
      return await Promise.race([(async () => {
        const token = await user.getIdToken();
        if (controller.signal.aborted || activeUser()?.uid !== user.uid) throw new Error('Activity identity changed');
        const response = await fetch((a.keiBase || 'https://kei.aobing.it') + '/api/activity/game/' + path, {
          method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
          body: JSON.stringify(data), signal: controller.signal,
        });
        if (!response.ok) { const error = new Error('Activity game HTTP ' + response.status); error.status = response.status; throw error; }
        return await response.json();
      })(), new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('Activity game timed out')); }, timeoutMs);
      })]);
    } finally { clearTimeout(timeout); }
  }
  async function refresh(timeoutMs) {
    const next = await request('context', {instanceId: activity().instanceId}, timeoutMs);
    if (!modes.has(next.mode) || !next.session) return null;
    context = next;
    return next;
  }
  async function flush() {
    if (busy || !context || activeUser()?.uid !== activity()?.uid) return;
    busy = true;
    try {
      if (context.expiresAt * 1000 < now() + 60000) await refresh();
      persist();
      for (const item of [...queue]) {
        try {
          await request('score', {...item.result, session: item.session});
          queue = queue.filter(row => row.result.runId !== item.result.runId); persist();
        } catch (error) {
          // Invalid payloads cannot recover. Auth/network/rate-limit failures stay
          // queued for reconnect, with the same run ID so retries never add a PB.
          if ([400, 409, 422].includes(error.status)) {
            queue = queue.filter(row => row.result.runId !== item.result.runId); persist();
          }
          break;
        }
      }
    } finally { busy = false; }
  }
  async function tick() {
    clearTimeout(timer);
    try {
      const next = await refresh();
      if (next && next.revision !== revision && next.requestedBy === activity().discordId) {
        if (window.GameShell?.enterActivity(next.mode)) revision = next.revision;
      }
      await flush();
    } catch (_) { /* A chat/backend outage must never interrupt a song. */ }
    timer = setTimeout(tick, 15000);
  }
  async function init() {
    if (initialized || !activity()?.instanceId) return;
    initialized = true;
    queueKey = 'aobing-activity-scores-v1:' + activity().uid + ':' + activity().instanceId;
    try {
      const saved = JSON.parse(localStorage.getItem(queueKey) || '[]');
      queue = Array.isArray(saved) ? saved.filter(row => row?.result?.runId && typeof row.session === 'string' && Number.isFinite(row.createdAt)).slice(-20) : [];
    } catch (_) { queue = []; }
    // Launch callback persistence and Firebase sign-in can finish just after the
    // iframe appears. A short bounded retry avoids flashing the clicker first.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const next = await refresh(2500);
        if (next) { initialMode = next.mode; revision = next.revision; break; }
      } catch (_) {}
      if (attempt < 3) await pause(400);
    }
    timer = setTimeout(tick, 15000);
    void flush();
  }
  function newRun() {
    if (!context || context.expiresAt * 1000 < now() + 60000 || activeUser()?.uid !== activity()?.uid) return null;
    // Bind the destination at song start. A later /launch in another channel
    // must not redirect this round's score or an older queued receipt.
    return {id: crypto.randomUUID(), uid: activity().uid, session: context.session, expiresAt: context.expiresAt};
  }
  async function complete(run, result) {
    if (!run || run.uid !== activeUser()?.uid || run.uid !== activity()?.uid || !context) return;
    const chartHash = result.chartHash || [...new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(await result.getText())))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (run.uid !== activeUser()?.uid || run.uid !== activity()?.uid) return;
    const payload = {runId: run.id, mode: result.mode, chartHash, title: String(result.title || 'Untitled').slice(0,180),
      difficulty: String(result.difficulty || 'Standard').slice(0,100), counts: {...result.counts}, maxCombo: result.maxCombo};
    if (!queue.some(item => item.result.runId === run.id)) queue.push({createdAt: now(), session: run.session, expiresAt: run.expiresAt, result: payload});
    persist(); void flush();
  }
  window.ActivityGames = {init, newRun, complete, get initialMode() { return initialMode; }};
  window.addEventListener('online', () => { if (initialized) void flush(); });
  window.addEventListener('pagehide', () => { clearTimeout(timer); persist(); });
  window.addEventListener('pageshow', () => { if (initialized) { clearTimeout(timer); timer = setTimeout(tick, 1000); } });
})();
