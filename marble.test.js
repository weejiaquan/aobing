'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),E=require('./marble');
function scenario(colors,head=500){const s=E.create(1,17);s.chain=colors.map((color,i)=>({id:i+1,color,s:head-i*30}));s.nextId=100;s.loaded=colors[0];s.next=colors[0];return s;}
function advance(s,seconds){const events=[];for(let t=0;t<seconds;t+=1/120)events.push(...E.advance(s,1/120));return events;}
function orderly(s){for(let i=1;i<s.chain.length;i++)assert.ok(s.chain[i-1].s-s.chain[i].s>=29.99);assert.equal(new Set(s.chain.map(m=>m.id)).size,s.chain.length);}
test('seeded waves and three bounded, arc-length paths are deterministic',()=>{
  for(let level=1;level<=12;level++){
    const a=E.create(level,8);assert.deepEqual(a,E.create(level,8));assert.equal(a.chain.length,36+(level-1)*4);orderly(a);
    const p=E.pathFor(level);assert.ok(p.length>1500);assert.ok(p.points.every(pt=>pt.x>20&&pt.x<880&&pt.y>20&&pt.y<600));
    for(let s=0;s<p.length;s+=100){const pos=E.point(p,s);assert.ok(Math.abs(Math.hypot(pos.tx,pos.ty)-1)<1e-8);}
  }
  assert.equal(E.pathFor(1),E.pathFor(4));assert.notEqual(E.pathFor(1).length,E.pathFor(2).length);
});
test('swept collision finds fast crossings and rejects misses',()=>{
  assert.equal(E.hitTime(0,0,200,0,100,0,10),.45);
  assert.equal(E.hitTime(0,0,200,0,100,20,10),null);
  assert.equal(E.hitTime(100,0,20,0,100,0,10),0);
  assert.equal(E.hitTime(0,0,0,0,100,0,10),null);
});
test('front and back insertion preserve chain order and push the leading section',()=>{
  for(const front of [true,false]){
    const s=scenario([0,1,2]);E.insert(s,1,3,front);assert.equal(s.chain.length,4);orderly(s);
    assert.equal(s.chain[front?1:2].color,3);assert.equal(s.chain[0].s,530);
  }
});
test('three matching marbles clear once and gaps roll back into a scored combo',()=>{
  const s=scenario([0,0,1,1,0,0]),events=[];
  E.insert(s,2,1,true,events);assert.equal(s.chain.length,4);assert.equal(s.score,300);assert.equal(events[1].combo,1);
  const head=s.chain[0].s;E.advance(s,.1);assert.ok(s.chain[0].s<head);assert.equal(s.chain.length,4);
  const rest=advance(s,2);assert.equal(s.outcome,'won');assert.equal(s.score,1100);assert.equal(s.bestCombo,2);
  assert.equal(rest.filter(e=>e.type==='won').length,1);assert.equal(rest.filter(e=>e.type==='clear')[0].combo,2);
  const score=s.score;advance(s,1);assert.equal(s.score,score);
});
test('matching colors separated by a gap cannot clear prematurely',()=>{
  const s=scenario([0,0,0]);s.chain[0].s+=90;assert.equal(E.runAt(s,1),null);
  E.advance(s,.1);assert.equal(s.chain.length,3);advance(s,1);assert.equal(s.outcome,'won');
});
test('projectiles hit a moving chain, insert and finish the wave',()=>{
  const s=scenario([0,0,0],340),p=E.point(E.pathFor(1),310);
  assert.ok(E.shoot(s,Math.atan2(p.y-310,p.x-450)));
  const events=advance(s,1);assert.equal(s.outcome,'won');assert.equal(s.score,400);assert.equal(s.cleared,4);
  assert.ok(events.some(e=>e.type==='insert'));assert.equal(s.projectiles.length,0);
});
test('firing is rate-limited and misses leave the viewport without changing score',()=>{
  const s=scenario([0,1],100);assert.ok(E.shoot(s,Math.PI));assert.equal(E.shoot(s,Math.PI),false);
  advance(s,1);assert.equal(s.projectiles.length,0);assert.equal(s.score,0);assert.equal(s.chain.length,2);assert.ok(E.shoot(s,Math.PI));
});
test('ammo swap is reversible and eliminating a color removes it from the magazine',()=>{
  const s=scenario([0,0,1,2]);s.loaded=0;s.next=1;E.swap(s);assert.equal(s.loaded,1);E.swap(s);assert.equal(s.loaded,0);
  E.insert(s,0,0,true);assert.ok(!E.available(s).includes(0));assert.ok(E.available(s).includes(s.loaded));assert.ok(E.available(s).includes(s.next));
});
test('exit loss freezes simulation and rejects further shots',()=>{
  const s=scenario([0,1],E.pathFor(1).length-15.1);const events=E.advance(s,.1);
  assert.equal(s.outcome,'lost');assert.equal(events.filter(e=>e.type==='lost').length,1);
  const snapshot=JSON.stringify(s);assert.equal(E.shoot(s,0),false);assert.equal(E.swap(s),false);advance(s,1);assert.equal(JSON.stringify(s),snapshot);
});
test('timesteps are bounded and frame-rate independent for normal chain movement',()=>{
  const a=E.create(3,123),b=structuredClone(a);for(let i=0;i<60;i++)E.advance(a,1/60);for(let i=0;i<120;i++)E.advance(b,1/120);
  assert.ok(Math.abs(a.chain[0].s-b.chain[0].s)<1e-8);
  const before=a.chain[0].s;E.advance(a,20);assert.ok(a.chain[0].s-before<10);
  const serialized=JSON.stringify(a);E.advance(a,NaN);E.advance(a,-1);assert.equal(JSON.stringify(a),serialized);
});
test('unattended waves reach a loss without overlapping or unbounded state',()=>{
  for(let level=1;level<=6;level++){
    const s=E.create(level,123);for(let n=0;n<2000&&s.outcome==='playing';n++){E.advance(s,.1);orderly(s);}
    assert.equal(s.outcome,'lost');assert.ok(s.chain.every(m=>Number.isFinite(m.s)));
  }
});
