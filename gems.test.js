'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),E=require('./gems');
function fixture() {
  const s=E.create(123);
  s.board.forEach((g,i)=>{g.color=(Math.floor(i/8)*2+i%8)%6;g.special='';});
  return s;
}
function stable(s) {
  assert.equal(s.board.length,64);assert.equal(new Set(s.board.map(g=>g.id)).size,64);
  assert.equal(E.matches(s.board).length,0);
  assert.ok(s.board.every(g=>g && g.color>=0 && g.color<6));
  if(s.outcome==='playing')assert.ok(E.findMove(s.board));
  assert.deepEqual(E.restore(JSON.parse(JSON.stringify(s))),s);
}
test('new boards are deterministic, match-free and playable across seeds',()=>{
  for(let seed=0;seed<150;seed++){const s=E.create(seed);stable(s);assert.equal(s.moves,30);assert.deepEqual(s,E.create(seed));}
});
test('invalid swaps, row wrapping, diagonals and ended games do not mutate or spend moves',()=>{
  const s=fixture(),before=JSON.stringify(s);
  for(const [a,b] of [[7,8],[0,9],[-1,0],[0,64],[0,0],[0,1]]){const r=E.move(s,a,b);assert.equal(r.valid,false);assert.equal(r.state,s);}
  assert.equal(JSON.stringify(s),before);
  assert.equal(E.move({...s,outcome:'lost'},0,1).valid,false);
});
test('a four-match makes a directional gem at the swapped destination',()=>{
  const s=fixture();[25,26,28,35].forEach(i=>s.board[i].color=0);s.board[27].color=1;
  s.board[24].color=s.board[29].color=2;
  assert.deepEqual(E.matches(s.board),[]);
  const r=E.move(s,35,27);assert.ok(r.valid);assert.equal(r.state.moves,29);
  const after=r.frames.find(f=>f.kind==='cleared');assert.equal(after.board[27].special,'row');
  assert.equal(after.board[25],null);stable(r.state);
});
test('a five-match creates a prism and a T intersection creates a burst',()=>{
  const s=fixture();[25,26,28,29,35].forEach(i=>s.board[i].color=0);s.board[27].color=1;
  s.board[24].color=s.board[30].color=2;
  assert.equal(E.move(s,35,27).frames.find(f=>f.kind==='cleared').board[27].special,'prism');
  const cross=fixture();[10,18,25,27,34].forEach(i=>cross.board[i].color=0);cross.board[26].color=1;
  cross.board[24].color=2;
  assert.deepEqual(E.matches(cross.board),[]);
  assert.equal(E.move(cross,34,26).frames.find(f=>f.kind==='cleared').board[26].special,'blast');
});
test('matched special gems clear their line and chain into other specials',()=>{
  const s=fixture();[25,27,34].forEach(i=>s.board[i].color=0);s.board[26].color=1;
  s.board[24].color=2;
  s.board[25].special='row';s.board[30].special='column';
  const r=E.move(s,34,26),clear=r.frames.find(f=>f.kind==='clear').cleared;
  for(let i=24;i<32;i++)assert.ok(clear.includes(i));
  for(let i=6;i<64;i+=8)assert.ok(clear.includes(i));stable(r.state);
});
test('a prism swap clears the chosen color without also clearing its old color',()=>{
  const s=fixture();s.board[0].special='prism';
  const expected=s.board.flatMap((g,i)=>g.color===s.board[1].color||i===0?[i]:[]).map(i=>i===0?1:i===1?0:i).sort((a,b)=>a-b);
  const r=E.move(s,0,1);assert.ok(r.valid);
  assert.deepEqual(r.frames.find(f=>f.kind==='clear').cleared.sort((a,b)=>a-b),expected);stable(r.state);
});
test('two prisms clear all 64 tiles',()=>{
  const s=fixture();s.board[0].special=s.board[1].special='prism';
  const r=E.move(s,0,1);assert.equal(r.frames.find(f=>f.kind==='clear').cleared.length,64);stable(r.state);
});
test('complete turns preserve originals, refill safely, award cascades once and remain resumable',()=>{
  let sawChain=false;
  for(let seed=1;seed<=40;seed++) {
    let s=E.create(seed,20);
    for(let n=0;n<30&&s.outcome==='playing';n++) {
      const previous=JSON.stringify(s),move=E.findMove(s.board),r=E.move(s,...move);
      assert.ok(r.valid);assert.equal(JSON.stringify(s),previous);assert.equal(r.state.moves,s.moves-1);
      assert.ok(r.state.score>s.score);assert.ok(r.frames.length>=4);
      sawChain ||= r.chain>1;s=r.state;stable(s);
    }
    assert.notEqual(s.outcome,'playing');
  }
  assert.ok(sawChain);
});
test('target completion wins even on the final move; otherwise the round ends',()=>{
  const s=E.create(7);s.moves=1;s.score=s.target-1;
  assert.equal(E.move(s,...E.findMove(s.board)).state.outcome,'won');
  const loss=E.create(7,999);loss.moves=1;
  assert.equal(E.move(loss,...E.findMove(loss.board)).state.outcome,'lost');
});
test('malformed or inconsistent saved progress is rejected',()=>{
  const s=E.create(2);
  for(const patch of [{moves:-1},{moves:31},{score:NaN},{outcome:'won'},{seed:0},{target:2},{board:[]},{level:1000}])assert.equal(E.restore({...s,...patch}),null);
  const duplicate=structuredClone(s);duplicate.board[1].id=duplicate.board[0].id;assert.equal(E.restore(duplicate),null);
  const broken=structuredClone(s);broken.board[0].special='unknown';assert.equal(E.restore(broken),null);
});
