'use strict';
// Classic/native mania rules. Holds receive ONE accuracy judgement combining
// head and release error; the browser is only an input/audio/render adapter.
(function(root) {
  const TIERS=['marvelous','perfect','great','good','bad'];
  function windows(od) {
    od=Number.isFinite(Number(od))?Math.max(0,Math.min(10,Number(od))):5;
    return {marvelous:16.5,perfect:Math.floor(64-3*od)+0.5,great:Math.floor(97-3*od)+0.5,
      good:Math.floor(127-3*od)+0.5,bad:Math.floor(151-3*od)+0.5,miss:Math.floor(188-3*od)+0.5};
  }
  function tapTier(error,w) {
    if(error>=w.good) return 'miss';
    const e=Math.abs(error);
    return TIERS.find(t=>e<w[t])||'miss';
  }
  function holdTier(headError,tailError,broken,w) {
    if(tailError>=w.good || tailError<=-w.bad) return 'miss';
    if(broken || !Number.isFinite(headError)) return 'bad';
    const head=Math.abs(headError), sum=head+Math.abs(tailError);
    if(head<w.marvelous*1.2 && sum<w.marvelous*2.4) return 'marvelous';
    if(head<w.perfect*1.1 && sum<w.perfect*2.2) return 'perfect';
    if(head<w.great && sum<w.great*2) return 'great';
    if(head<w.good && sum<w.good*2) return 'good';
    return 'bad';
  }
  function createSession(chart) {
    const w=windows(chart.overallDifficulty), events=[];
    const notes=chart.notes.map(n=>({...n,headJudged:false,tailJudged:false,holding:false,broken:false,headError:Infinity}));
    const lanes=Array.from({length:chart.keyCount},(_,i)=>notes.filter(n=>n.lane===i));
    const held=new Set();
    const state={totalNotes:notes.length,combo:0,maxCombo:0,counts:{marvelous:0,perfect:0,great:0,good:0,bad:0,miss:0}};
    function combo(ok) { state.combo=ok?state.combo+1:0; state.maxCombo=Math.max(state.maxCombo,state.combo); }
    function result(n,tier,error,addCombo=true) {
      if(n.tailJudged) return;
      n.tailJudged=true; n.holding=false;
      state.counts[tier]++;
      if(tier==='miss') combo(false); else if(addCombo) combo(true);
      events.push({kind:'judge',note:n,tier,error});
    }
    function advance(time) {
      for(const n of notes) {
        if(n.tailJudged) continue;
        if(!n.headJudged && time>n.time+w.good) {
          n.headJudged=true; n.broken=true; combo(false);
          if(n.endTime==null) result(n,'miss');
          else events.push({kind:'break',note:n});
        }
        if(n.endTime!=null && time>n.endTime+w.good) result(n,'miss');
      }
    }
    function press(lane,time) {
      advance(time);
      if(held.has(lane)) return;
      held.add(lane);
      // A dropped/missed hold can be picked up again, but cannot regain a top
      // grade. Never let a recovery consume the next tap in the lane.
      for(const n of lanes[lane]||[]) {
        if(n.endTime!=null && n.headJudged && !n.tailJudged && time>=n.time && time<n.endTime+w.good) {
          n.holding=true;
          return;
        }
      }
      const pending=(lanes[lane]||[]).filter(n=>!n.headJudged);
      // A previous tap's late window cannot extend beyond the next head's
      // start. Miss it once, then let the player continue the jack pattern.
      while(pending.length>1 && pending[1].time<=time && pending[0].time<pending[1].time) {
        const old=pending.shift(); old.headJudged=true; old.broken=true; combo(false);
        if(old.endTime==null) result(old,'miss'); else events.push({kind:'break',note:old});
      }
      const n=pending[0];
      if(!n || time<n.time-w.miss) return;
      const error=time-n.time, tier=tapTier(error,w);
      n.headJudged=true; n.headError=error;
      if(n.endTime==null) { result(n,tier,error); if(tier!=='miss') events.push({kind:'sound',note:n}); }
      else {
        n.holding=tier!=='miss'; n.broken=tier==='miss';
        combo(tier!=='miss');
        events.push({kind:tier==='miss'?'break':'head',note:n,tier,error});
        if(tier!=='miss') events.push({kind:'sound',note:n});
      }
    }
    function release(lane,time) {
      advance(time); held.delete(lane);
      for(const n of lanes[lane]||[]) {
        if(!n.holding || n.tailJudged) continue;
        n.holding=false;
        if(time<=n.endTime-w.bad) { n.broken=true; combo(false); events.push({kind:'break',note:n}); }
        else result(n,holdTier(n.headError,time-n.endTime,n.broken,w),time-n.endTime,false);
      }
    }
    function auto(time) {
      const due=[];
      for(const n of notes) {
        if(!n.headJudged && n.time<=time) due.push({n,t:n.time,tail:false});
        if(n.endTime!=null && !n.tailJudged && n.endTime<=time) due.push({n,t:n.endTime,tail:true});
      }
      due.sort((a,b)=>a.t-b.t || Number(b.tail)-Number(a.tail));
      for(const e of due) { if(e.tail) release(e.n.lane,e.t); else { held.delete(e.n.lane); press(e.n.lane,e.t); if(e.n.endTime==null) held.delete(e.n.lane); } }
      advance(time);
    }
    return {notes,state,windows:w,held,advance,press,release,auto,takeEvents:()=>events.splice(0)};
  }
  const api={windows,tapTier,holdTier,createSession};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.RhythmMania=api;
})(typeof window!=='undefined'?window:globalThis);
