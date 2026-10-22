'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),E=require('./drift');
// Builds a state from a 4×4 grid of values (0 = empty) with fresh ids.
function board(rows,extra={}){
  const s={version:1,seed:99,nextId:1,board:[],score:0,moves:0,reached:false,outcome:'playing',...extra};
  for(const value of rows.flat())s.board.push(value?{id:s.nextId++,value}:null);
  return s;
}
const values=s=>Array.from({length:4},(_,r)=>s.board.slice(r*4,r*4+4).map(t=>t?t.value:0));
function consistent(s){
  const tiles=s.board.filter(Boolean);
  assert.equal(new Set(tiles.map(t=>t.id)).size,tiles.length,'tile ids must be unique');
  assert.ok(tiles.every(t=>t.id<s.nextId),'ids must be below nextId');
  assert.deepEqual(E.restore(JSON.parse(JSON.stringify(s))),s,'state must survive a save/restore round trip');
}
test('new games are deterministic and start with two small tiles',()=>{
  for(let seed=0;seed<100;seed++){
    const s=E.create(seed),tiles=s.board.filter(Boolean);
    assert.deepEqual(s,E.create(seed));assert.equal(tiles.length,2,'seed '+seed);
    assert.ok(tiles.every(t=>t.value===2||t.value===4));assert.equal(s.outcome,'playing');consistent(s);
  }
});
test('tiles slide to the edge and equal neighbours merge once per move in every direction',()=>{
  const s=board([[2,2,2,2],[4,0,4,8],[0,0,0,2],[8,8,16,0]]);
  const expected={
    left:[[4,4,0,0],[8,8,0,0],[2,0,0,0],[16,16,0,0]],
    right:[[0,0,4,4],[0,0,8,8],[0,0,0,2],[0,0,16,16]],
    up:[[2,2,2,2],[4,8,4,8],[8,0,16,2],[0,0,0,0]],
    down:[[0,0,0,0],[2,0,2,2],[4,2,4,8],[8,8,16,2]]
  };
  for(const [dir,grid] of Object.entries(expected)){
    const r=E.move(s,dir);assert.ok(r.valid,dir);
    const withoutSpawn=values(r.state);withoutSpawn[Math.floor(r.spawned.index/4)][r.spawned.index%4]=0;
    assert.deepEqual(withoutSpawn,grid,dir+' result');
    assert.equal(r.gained,r.merges.reduce((n,m)=>n+m.value,0),dir+' points');
    assert.equal(r.state.score,r.gained);assert.equal(r.state.moves,1);consistent(r.state);
  }
});
test('a line of 4,4,8 merges the leading pair only and reports every slide',()=>{
  const r=E.move(board([[4,4,8,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]),'left');
  assert.deepEqual(values(r.state)[0].slice(0,2),[8,8]);
  assert.deepEqual(r.slides.map(sl=>[sl.from,sl.to]),[[0,0],[1,0],[2,1]]);
  assert.equal(r.merges.length,1);assert.deepEqual(r.merges[0].from,[1,2]);assert.equal(r.gained,8);
});
test('moves that change nothing are rejected without spawning or mutating',()=>{
  const s=board([[2,4,8,16],[0,0,0,0],[0,0,0,0],[0,0,0,0]]),before=JSON.stringify(s);
  for(const dir of ['left','right','up'])assert.equal(E.move(s,dir).valid,false,dir);
  assert.equal(E.move(s,'sideways').valid,false);
  assert.equal(JSON.stringify(s),before);
  assert.ok(E.move(s,'down').valid);assert.equal(JSON.stringify(s),before,'valid moves must not mutate the original');
});
test('each valid move spawns exactly one 2 or 4 on an empty cell',()=>{
  let s=E.create(5);
  for(let n=0;n<200&&s.outcome==='playing';n++){
    const dir=E.DIRECTIONS.find(d=>E.move(s,d).valid),r=E.move(s,dir);
    assert.ok(r.spawned,'move '+n+' spawned');assert.ok([2,4].includes(r.spawned.value));
    const prior=new Set(r.slides.map(sl=>sl.to));assert.ok(!prior.has(r.spawned.index),'spawn landed on an occupied cell');
    assert.equal(r.state.board.filter(Boolean).length,s.board.filter(Boolean).length-r.merges.length+1);
    s=r.state;consistent(s);
  }
});
test('reaching 2048 wins once, then keepPlaying continues without re-triggering',()=>{
  const s=board([[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const r=E.move(s,'left');assert.equal(r.state.outcome,'won');assert.equal(r.state.reached,true);consistent(r.state);
  assert.equal(E.move(r.state,'right').valid,false,'moves are blocked until the player chooses to continue');
  const going=E.keepPlaying(r.state);assert.equal(going.outcome,'playing');
  const next=E.move(going,'right');assert.ok(next.valid);assert.equal(next.state.outcome,'playing');consistent(next.state);
});
test('filling the last cell with no equal neighbours loses the game',()=>{
  // Any spawn (2 or 4) at the freed corner sits beside two 8s, so no merge remains.
  const r=E.move(board([[2,4,2,4],[4,2,4,2],[8,4,2,4],[8,16,32,0]]),'right');
  assert.ok(r.valid);assert.equal(r.spawned.index,12);assert.equal(r.state.outcome,'lost');consistent(r.state);
  for(const dir of E.DIRECTIONS)assert.equal(E.move(r.state,dir).valid,false,dir+' after loss');
  assert.equal(E.move(board([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]]),'left').valid,false,'no-op on a full board');
});
test('random play always ends in a consistent lost or won state',()=>{
  for(let seed=1;seed<=15;seed++){
    let s=E.create(seed),n=0;
    while(s.outcome==='playing'&&n++<5000){const dir=E.DIRECTIONS[(n*7+seed)%4],r=E.move(s,dir);if(r.valid)s=r.state;else{const any=E.DIRECTIONS.map(d=>E.move(s,d)).find(m=>m.valid);assert.ok(any,'playing state must have a move');s=any.state;}}
    assert.notEqual(s.outcome,'playing','seed '+seed+' finished');consistent(s);
  }
});
test('malformed or inconsistent saved progress is rejected',()=>{
  const s=E.create(3);
  for(const patch of [{version:2},{board:[]},{seed:0},{score:-1},{moves:1.5},{reached:true},{reached:'no'},{outcome:'lost'},{outcome:'won'},{outcome:'paused'},{nextId:1}])
    assert.equal(E.restore({...s,...patch}),null,JSON.stringify(patch));
  const odd=structuredClone(s);odd.board[odd.board.findIndex(Boolean)].value=6;assert.equal(E.restore(odd),null,'non power of two');
  const dup=structuredClone(s);const [a,b]=dup.board.flatMap((t,i)=>t?[i]:[]);dup.board[b].id=dup.board[a].id;assert.equal(E.restore(dup),null,'duplicate ids');
  assert.equal(E.restore({...s,board:Array(16).fill(null)}),null,'empty board');
  assert.equal(E.restore(null),null);
});
