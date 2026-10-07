/* Marble Trail: seeded simulation, path geometry and swept collision; no DOM. */
(function(root){
  'use strict';
  const WIDTH=900,HEIGHT=620,RADIUS=15,SPACING=30,SHOOTER={x:450,y:310},SHOT_SPEED=820;
  const paths=new Map();
  function pathFor(level=1){
    const variant=(level-1)%3;if(paths.has(variant))return paths.get(variant);
    const points=[],turns=[1.3,1.4,1.22][variant];let length=0;
    for(let i=0;i<=600;i++){
      const f=i/600,a=-Math.PI/2+f*Math.PI*2*turns,rx=385-235*f,ry=245-135*f;
      const p={x:450+Math.cos(a)*rx,y:310+Math.sin(a)*ry};
      if(variant===1)p.x+=Math.sin(a*3)*18*(1-f);
      if(variant===2)p.y+=Math.sin(a*2)*22*(1-f);
      if(i)length+=Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y);
      points.push({...p,s:length});
    }
    const result={points,length,variant};paths.set(variant,result);return result;
  }
  function point(path,s){
    const ps=path.points;s=Math.max(0,Math.min(path.length,s));
    let lo=0,hi=ps.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(ps[mid].s<s)lo=mid;else hi=mid;}
    const a=ps[lo],b=ps[hi],f=(s-a.s)/(b.s-a.s),d=Math.hypot(b.x-a.x,b.y-a.y);
    return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,tx:(b.x-a.x)/d,ty:(b.y-a.y)/d};
  }
  function random(state){let x=state.seed|0;x^=x<<13;x^=x>>>17;x^=x<<5;state.seed=x>>>0;return state.seed/4294967296;}
  function available(state){return [...new Set(state.chain.map(m=>m.color))];}
  function ammo(state){const colors=available(state);return colors.length?colors[Math.floor(random(state)*colors.length)]:0;}
  function syncAmmo(state){const colors=available(state);if(!colors.includes(state.loaded))state.loaded=ammo(state);if(!colors.includes(state.next))state.next=ammo(state);}
  function create(level=1,seed=Math.floor(Math.random()*4294967295)){
    level=Math.max(1,Math.min(999,Math.floor(level)||1));
    const state={level,seed:(seed>>>0)||1,chain:[],projectiles:[],nextId:1,score:0,cleared:0,shots:0,combo:0,bestCombo:0,cooldown:0,time:0,outcome:'playing',loaded:0,next:0};
    const count=36+Math.min(level-1,12)*4,colors=level>=4?5:4;
    for(let i=0;i<count;i++){
      let color=Math.floor(random(state)*colors);
      if(i>1&&state.chain[i-1].color===color&&state.chain[i-2].color===color)color=(color+1)%colors;
      // Paired colors give each wave useful targets without pre-cleared triples.
      if(i%4===1)color=state.chain[i-1].color;
      state.chain.push({id:state.nextId++,color,s:330-i*SPACING});
    }
    state.loaded=ammo(state);state.next=ammo(state);return state;
  }
  function swap(state){if(state.outcome!=='playing')return false;[state.loaded,state.next]=[state.next,state.loaded];return true;}
  function shoot(state,angle){
    if(state.outcome!=='playing'||state.cooldown>0||!Number.isFinite(angle)||state.projectiles.length>=3)return false;
    state.projectiles.push({id:state.nextId++,color:state.loaded,x:SHOOTER.x+Math.cos(angle)*36,y:SHOOTER.y+Math.sin(angle)*36,vx:Math.cos(angle)*SHOT_SPEED,vy:Math.sin(angle)*SHOT_SPEED});
    state.loaded=state.next;state.next=ammo(state);state.cooldown=.22;state.shots++;return true;
  }
  // First intersection with a circle, including a segment starting inside it.
  function hitTime(x,y,dx,dy,cx,cy,r){
    const ox=x-cx,oy=y-cy,c=ox*ox+oy*oy-r*r;if(c<=0)return 0;
    const a=dx*dx+dy*dy;if(!a)return null;
    const b=2*(ox*dx+oy*dy),disc=b*b-4*a*c;if(disc<0)return null;
    const t=(-b-Math.sqrt(disc))/(2*a);return t>=0&&t<=1?t:null;
  }
  function runAt(state,index){
    if(!state.chain[index])return null;
    let start=index,end=index;const color=state.chain[index].color;
    while(start>0&&state.chain[start-1].color===color&&state.chain[start-1].s-state.chain[start].s<=SPACING+.01)start--;
    while(end+1<state.chain.length&&state.chain[end+1].color===color&&state.chain[end].s-state.chain[end+1].s<=SPACING+.01)end++;
    return end-start+1>=3?{start,end}:null;
  }
  function clearAt(state,index,events,combo){
    const run=runAt(state,index);if(!run)return false;
    const removed=state.chain.splice(run.start,run.end-run.start+1);
    state.combo=Math.min(combo,5);state.bestCombo=Math.max(state.bestCombo,state.combo);
    const points=removed.length*100*state.combo;state.score+=points;state.cleared+=removed.length;
    events.push({type:'clear',marbles:removed,combo:state.combo,points});syncAmmo(state);return true;
  }
  function insert(state,index,color,front,events=[]){
    const at=index+(front?0:1),old=state.chain[index];if(!old)return;
    const s=front?old.s+SPACING:old.s-SPACING;
    state.chain.splice(at,0,{id:state.nextId++,color,s});
    // Inserting between touching balls pushes only the section toward the exit.
    if(at+1<state.chain.length)state.chain[at].s=Math.max(state.chain[at].s,state.chain[at+1].s+SPACING);
    for(let i=at-1;i>=0;i--)state.chain[i].s=Math.max(state.chain[i].s,state.chain[i+1].s+SPACING);
    events.push({type:'insert',index:at});
    if(!clearAt(state,at,events,1))state.combo=0;
  }
  function step(state,dt,events){
    const path=pathFor(state.level);state.time+=dt;state.cooldown=Math.max(0,state.cooldown-dt);
    if(!state.chain.length){state.outcome='won';state.projectiles=[];events.push({type:'won'});return;}
    const gap=state.chain.findIndex((m,i)=>i+1<state.chain.length&&m.s-state.chain[i+1].s>SPACING+.01);
    if(gap>=0){
      const amount=Math.min(220*dt,state.chain[gap].s-state.chain[gap+1].s-SPACING);
      for(let i=0;i<=gap;i++)state.chain[i].s-=amount;
      if(state.chain[gap].s-state.chain[gap+1].s<=SPACING+.01){
        if(!clearAt(state,gap,events,state.combo+1))state.combo=0;
      }
    }else{
      const speed=state.chain[0].s<100?155:18+Math.min(state.level-1,20)*2;
      state.chain.forEach(m=>{m.s+=speed*dt;});
    }
    for(const shot of [...state.projectiles]){
      const dx=shot.vx*dt,dy=shot.vy*dt;let closest=null;
      state.chain.forEach((m,i)=>{
        if(m.s<0)return;
        const p=point(path,m.s),t=hitTime(shot.x,shot.y,dx,dy,p.x,p.y,RADIUS*2-1);
        if(t!==null&&(!closest||t<closest.t))closest={t,index:i,p};
      });
      if(closest){
        const {p,t,index}=closest;
        const front=(shot.x+dx*t-p.x)*p.tx+(shot.y+dy*t-p.y)*p.ty>=0;
        state.projectiles.splice(state.projectiles.indexOf(shot),1);insert(state,index,shot.color,front,events);
      }else{
        shot.x+=dx;shot.y+=dy;
        if(shot.x<-40||shot.x>WIDTH+40||shot.y<-40||shot.y>HEIGHT+40)state.projectiles.splice(state.projectiles.indexOf(shot),1);
      }
    }
    if(!state.chain.length){state.outcome='won';state.projectiles=[];events.push({type:'won'});}
    else if(state.chain[0].s>=path.length-RADIUS){state.outcome='lost';state.projectiles=[];events.push({type:'lost'});}
  }
  function advance(state,seconds){
    const events=[];if(state.outcome!=='playing'||!Number.isFinite(seconds)||seconds<=0)return events;
    const count=Math.ceil(Math.min(seconds,.25)*120),dt=Math.min(seconds,.25)/count;
    for(let i=0;i<count&&state.outcome==='playing';i++)step(state,dt,events);
    return events;
  }
  const api={WIDTH,HEIGHT,RADIUS,SPACING,SHOOTER,pathFor,point,create,available,swap,shoot,hitTime,runAt,insert,advance};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MarbleEngine=api;
})(typeof window!=='undefined'?window:globalThis);
