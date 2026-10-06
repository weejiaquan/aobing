'use strict';
// Geometry/state helpers for Standard. All times are calibrated song ms.
(function(root) {
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function at(path,frac) {
    const f=Math.max(0,Math.min(1,frac))*(path.length-1), i=Math.floor(f), a=path[i], b=path[Math.min(i+1,path.length-1)];
    return a?{x:a.x+(b.x-a.x)*(f-i),y:a.y+(b.y-a.y)*(f-i)}:{x:0,y:0};
  }
  function ball(o,time) {
    const local=Math.max(0,Math.min(o.duration,time-o.time));
    const span=Math.min(o.slides-1,Math.floor(local/o.spanDuration));
    const f=(local-span*o.spanDuration)/o.spanDuration;
    return at(o.path,span%2?1-f:f);
  }
  function checkpoints(o,chart) {
    let beat=500;
    for(const p of chart.timingPoints) { if(p.time>o.time) break; if(p.uninherited) beat=p.beatLength; }
    const interval=beat/(chart.sliderTickRate||1), pts=[];
    // Stable checks the tail slightly early; it is a separate accuracy event
    // from a repeat, and missing it does not break the running combo.
    for(let span=0;span<o.slides;span++) {
      const start=o.time+span*o.spanDuration;
      for(let t=interval;t<o.spanDuration-10;t+=interval) {
        if(pts.length>100000) break;
        pts.push({time:start+t,frac:span%2?1-t/o.spanDuration:t/o.spanDuration,kind:'tick',hit:false,ev:false});
      }
      const tail=span===o.slides-1;
      pts.push({time:tail?Math.max(o.time+o.duration/2,o.endTime-36):start+o.spanDuration,
        frac:span%2?0:1,kind:tail?'tail':'repeat',edge:span+1,hit:false,ev:false});
    }
    return pts.sort((a,b)=>a.time-b.time);
  }
  function sliderResult(s) {
    const count=(s.headResult && s.headResult!=='miss'?1:0)+s.checkpoints.filter(c=>c.hit).length;
    const total=1+s.checkpoints.length;
    return count===total?'h300':count>=total/2?'h100':count?'h50':'miss';
  }
  function processSlider(s,time,history,radius,onPart) {
    const o=s.o;
    if(!s.headJudged && time>o.time+s.hitWindow) { s.headJudged=true; s.headResult='miss'; onPart(false,'head',o.time); }
    for(const cp of s.checkpoints) {
      if(cp.ev || cp.time>time) continue;
      const input=history.at(cp.time), pos=ball(o,cp.time);
      cp.ev=true; cp.hit=input.held && distance(input,pos)<=radius*2.4;
      onPart(cp.hit,cp.kind,cp.time,cp.edge);
    }
    const input=history.at(time);
    s.following=time>=o.time && time<=o.endTime && input.held && distance(input,ball(o,time))<=radius*2.4;
    return s.headJudged && s.checkpoints.every(c=>c.ev) && time>=o.endTime;
  }
  function spinnerRequired(duration,od) {
    const rate=od<5?1.5+0.2*od:1.25+0.25*od;
    return Math.floor((duration/1000*rate+0.5)*2)/2;
  }
  function spinnerResult(spins,required) {
    return spins>=required?'h300':spins>=required-1 && spins>0?'h100':spins>=required*0.25 && spins>0?'h50':'miss';
  }
  // Evaluate cursor rotation from input samples rather than once per display
  // frame. Reject centre jitter and cap impossible angular speeds.
  function spinSample(s,input,time) {
    const dx=input.x-256,dy=input.y-192;
    if(!input.held || Math.hypot(dx,dy)<16) { s.lastAngle=null; s.lastSpinTime=time; return; }
    const angle=Math.atan2(dy,dx);
    if(s.lastAngle!=null && time>s.lastSpinTime) {
      let delta=angle-s.lastAngle;
      delta=Math.atan2(Math.sin(delta),Math.cos(delta));
      s.rot+=Math.min(Math.abs(delta),(time-s.lastSpinTime)/1000*Math.PI*2*12);
    }
    s.lastAngle=angle; s.lastSpinTime=time;
  }
  // Modern stable stacking (v6+), including negative stacks after slider tails.
  // Coordinates and paths are shifted together; parsing never mutates source.
  function stack(objects,preempt,leniency,radius,version=14) {
    const a=objects.map(o=>({...o,stackHeight:0})), threshold=preempt*leniency;
    const end=o=>o.kind==='slider'?ball(o,o.endTime):o;
    if(version<6) {
      for(let i=0;i<a.length;i++) {
        const o=a[i]; if(o.kind==='spinner') continue;
        let last=o.endTime||o.time, negative=0;
        for(let j=i+1;j<a.length;j++) {
          const n=a[j]; if(n.time-last>threshold) break;
          if(n.kind==='spinner') continue;
          if(distance(o,n)<3) { o.stackHeight++; last=n.endTime||n.time; }
          else if(o.kind==='slider' && distance(end(o),n)<3) { n.stackHeight-=++negative; last=n.endTime||n.time; }
        }
      }
    } else for(let i=a.length-1;i>0;i--) {
      let current=a[i]; if(current.stackHeight || current.kind==='spinner') continue;
      for(let j=i-1;j>=0;j--) {
        const prev=a[j]; if(prev.kind==='spinner') continue;
        if(current.time-(current.kind==='circle'?(prev.endTime||prev.time):prev.time)>threshold) break;
        if(current.kind==='circle' && prev.kind==='slider' && distance(end(prev),current)<3) {
          const offset=current.stackHeight-prev.stackHeight+1;
          for(let k=j+1;k<=i;k++) if(a[k].kind!=='spinner' && distance(end(prev),a[k])<3) a[k].stackHeight-=offset;
          break;
        }
        if(distance(current.kind==='slider'?end(prev):prev,current)<3) { prev.stackHeight=current.stackHeight+1; current=prev; }
      }
    }
    for(const o of a) {
      if(o.kind==='spinner') continue;
      const shift=-o.stackHeight*radius/10;
      o.x+=shift; o.y+=shift;
      if(o.path) o.path=o.path.map(p=>({x:p.x+shift,y:p.y+shift}));
    }
    return a;
  }
  const api={at,ball,checkpoints,sliderResult,processSlider,spinnerRequired,spinnerResult,spinSample,stack};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.RhythmStandard=api;
})(typeof window!=='undefined'?window:globalThis);
