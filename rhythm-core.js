'use strict';

// Shared rhythm infrastructure. Gameplay clocks measure audible output, while
// visual and input offsets are independent. No dependency on the game shell.
(function (root) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function eventTime(value, now = performance.now()) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return now;
    const relative = n > 1e12 ? n - performance.timeOrigin : n;
    return Math.abs(relative - now) < 60000 ? relative : now;
  }
  function createClock(ctx, start, now = () => performance.now()) {
    let anchor = { contextTime: ctx.currentTime, performanceTime: now() };
    let frozen = null;
    function output() {
      const stamp = ctx.getOutputTimestamp && ctx.getOutputTimestamp();
      if (stamp && stamp.contextTime > 0 && stamp.performanceTime > 0) return stamp;
      const latency = Number(ctx.outputLatency) || Number(ctx.baseLatency) || 0;
      // Refresh the fallback anchor, rather than extrapolating an entire song
      // from the first audio quantum. Never add latency to getOutputTimestamp.
      anchor = { contextTime: ctx.currentTime - clamp(latency, 0, 1), performanceTime: now() };
      return anchor;
    }
    return {
      at(ts = now()) {
        if (frozen !== null) return frozen;
        const a = output();
        return (a.contextTime - start) * 1000 + ts - a.performanceTime;
      },
      reset(nextStart) { start = nextStart; frozen = null; },
      pause() { frozen = this.at(); return frozen; },
      get paused() { return frozen !== null; },
    };
  }
  // Causal pointer/button states at a checkpoint's own timestamp. Never borrow
  // a future sample: interpolation using an event delivered after a checkpoint
  // would make its result depend on how late the next display frame arrives.
  function createHistory(initial = { x: 256, y: 192, held: false }) {
    const samples = [{ time: -Infinity, ...initial }];
    return {
      push(time, state) {
        const last = samples[samples.length - 1];
        const s = { ...last, ...state, time };
        if (time < last.time) return;
        if (time === last.time) samples[samples.length - 1] = s;
        else samples.push(s);
      },
      at(time) {
        let lo = 0, hi = samples.length;
        while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (samples[m].time <= time) lo = m; else hi = m; }
        return samples[lo];
      },
      prune(time) { while (samples.length > 2 && samples[1].time < time) samples.shift(); },
    };
  }
  function timingPoints(lines) {
    return lines.filter(l => l && !l.startsWith('//')).map(l => {
      const p = l.split(',');
      return { time: Number(p[0]), beatLength: Number(p[1]), uninherited: p[6] == null ? Number(p[1]) > 0 : p[6].trim() === '1',
        sampleSet: Number(p[3]) || 0, sampleIndex: Number(p[4]) || 0, volume: p[5] === undefined ? 100 : clamp(Number(p[5]), 0, 100) };
    }).filter(p => Number.isFinite(p.time) && Number.isFinite(p.beatLength)).sort((a,b) => a.time-b.time);
  }
  function sample(text) {
    const p = String(text || '').split(':');
    return { normalSet: Number(p[0]) || 0, additionSet: Number(p[1]) || 0, index: Number(p[2]) || 0, volume: Number(p[3]) || 0, filename: p.slice(4).join(':') };
  }
  function sampleAt(points, time, defaults = 1) {
    let s = { sampleSet: defaults, sampleIndex: 0, volume: 100 };
    for (const p of points || []) { if (p.time > time) break; s = { sampleSet: p.sampleSet || defaults, sampleIndex: p.sampleIndex || 0, volume: p.volume }; }
    return s;
  }
  function soundSpec(chart, obj, time, edge) {
    const tm = sampleAt(chart.samplePoints, time, chart.sampleSet);
    const s = obj.sample || {};
    const es = edge != null && obj.edgeSets && obj.edgeSets[edge];
    const normal = (es && es[0]) || s.normalSet || tm.sampleSet || 1;
    return { normalSet: normal, additionSet: (es && es[1]) || s.additionSet || normal,
      index: s.index || tm.sampleIndex, volume: s.volume || tm.volume,
      filename: edge == null || edge === 0 ? s.filename : '',
      bits: edge != null && obj.edgeSounds && obj.edgeSounds[edge] != null ? obj.edgeSounds[edge] : obj.hitSound || 0 };
  }
  // Integrate scroll distance, preserving continuity at BPM/SV changes. Stable
  // mania normalises to the duration-weighted dominant BPM of the chart.
  function scrollTimeline(points, endTime) {
    const reds = points.filter(p => p.uninherited && p.beatLength > 0);
    const durations = new Map();
    reds.forEach((p,i) => { const end = Math.min(endTime, reds[i+1] ? reds[i+1].time : endTime); durations.set(p.beatLength,(durations.get(p.beatLength)||0)+Math.max(0,end-Math.max(0,p.time))); });
    let base = reds.length ? reds[0].beatLength : 500, longest = -1;
    for (const [b,d] of durations) if (d > longest) { base=b; longest=d; }
    const out = [{ time: 0, position: 0, speed: 1 }];
    let beat = reds.length ? reds[0].beatLength : 500, sv = 1;
    for (const p of points) {
      const prev = out[out.length-1];
      const pos = prev.position + (p.time-prev.time)*prev.speed;
      if (p.uninherited && p.beatLength>0) { beat=p.beatLength; sv=1; }
      else if (p.beatLength<0) sv=clamp(-100/p.beatLength,0.1,10);
      const item={time:p.time,position:pos,speed:base/beat*sv};
      if (p.time<=prev.time) { item.position=prev.position; out[out.length-1]=item; } else out.push(item);
    }
    return out;
  }
  function scrollAt(timeline,time) {
    let lo=0, hi=timeline.length;
    while(lo+1<hi) { const m=(lo+hi)>>1; if(timeline[m].time<=time) lo=m; else hi=m; }
    const p=timeline[lo]; return p.position+(time-p.time)*p.speed;
  }
  async function collectSamples(names, read, audioFile) {
    const out=[];
    for (const name of names) {
      if (!/\.(wav|ogg|mp3)$/i.test(name) || name.toLowerCase()===String(audioFile).toLowerCase()) continue;
      const bytes=await read(name); if(bytes) out.push({name:name.toLowerCase(),bytes});
    }
    return out;
  }
  function archiveFiles(entries, chartName) {
    const path = chartName.replace(/\\/g,'/'), dir = path.slice(0,path.lastIndexOf('/')+1).toLowerCase();
    const files = new Map();
    for (const [name,bytes] of entries) {
      const normalized=name.replace(/\\/g,'/').toLowerCase();
      if (normalized.startsWith(dir)) files.set(normalized.slice(dir.length),bytes);
    }
    return files;
  }
  const api={clamp,eventTime,createClock,createHistory,timingPoints,sample,soundSpec,scrollTimeline,scrollAt,collectSamples,archiveFiles};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.RhythmCore=api;
})(typeof window!=='undefined'?window:globalThis);
