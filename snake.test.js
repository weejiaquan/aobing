'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),E=require('./snake');
// A playing state with an explicit body (head first) and food position.
function scenario(snake,food,direction='right'){return {seed:42,snake:snake.map(([x,y])=>({x,y})),direction,queue:[],score:0,eaten:0,outcome:'playing',food:{x:food[0],y:food[1]}};}
const cells=s=>s.snake.map(p=>[p.x,p.y]);
test('new rounds are deterministic, centred and place food off the snake',()=>{
  for(let seed=0;seed<200;seed++){
    const s=E.create(seed);assert.deepEqual(s,E.create(seed));
    assert.deepEqual(cells(s),[[9,9],[8,9],[7,9]]);assert.equal(s.direction,'right');
    assert.ok(s.food.x>=0&&s.food.x<E.COLS&&s.food.y>=0&&s.food.y<E.ROWS);
    assert.ok(!s.snake.some(p=>p.x===s.food.x&&p.y===s.food.y),'seed '+seed+' food on snake');
  }
});
test('moving shifts the whole body one cell without growing',()=>{
  const s=scenario([[5,5],[4,5],[3,5]],[0,0]);
  assert.deepEqual(E.step(s),{type:'move'});assert.deepEqual(cells(s),[[6,5],[5,5],[4,5]]);
});
test('turns are buffered up to two, and reversals or repeats are refused',()=>{
  const s=scenario([[5,5],[4,5],[3,5]],[0,0]);
  assert.equal(E.turn(s,'left'),false,'reverse into the neck');
  assert.equal(E.turn(s,'right'),false,'same direction');
  assert.equal(E.turn(s,'diagonal'),false);
  assert.equal(E.turn(s,'up'),true);assert.equal(E.turn(s,'down'),false,'reverse of a queued turn');
  assert.equal(E.turn(s,'left'),true);assert.equal(E.turn(s,'down'),false,'queue is full');
  E.step(s);assert.deepEqual(cells(s)[0],[5,4]);E.step(s);assert.deepEqual(cells(s)[0],[4,4]);
  assert.equal(s.direction,'left');assert.deepEqual(s.queue,[]);
});
test('eating grows the snake, scores, and respawns food on a free cell',()=>{
  const s=scenario([[5,5],[4,5],[3,5]],[6,5]);
  const event=E.step(s);assert.equal(event.type,'eat');assert.equal(event.points,10);
  assert.deepEqual(cells(s),[[6,5],[5,5],[4,5],[3,5]]);assert.equal(s.score,10);assert.equal(s.eaten,1);
  assert.ok(!s.snake.some(p=>p.x===s.food.x&&p.y===s.food.y));
});
test('walls and the snake\'s own body end the round',()=>{
  const wall=scenario([[17,3],[16,3],[15,3]],[0,0]);
  assert.deepEqual(E.step(wall),{type:'crash',cause:'wall'});assert.equal(wall.outcome,'lost');
  assert.deepEqual(cells(wall),[[17,3],[16,3],[15,3]],'crash leaves the body in place');
  assert.deepEqual(E.step(wall),{type:'idle'});assert.equal(E.turn(wall,'up'),false);
  const top=scenario([[4,0],[4,1],[4,2]],[9,9],'up');assert.equal(E.step(top).cause,'wall');
  const self=scenario([[5,5],[6,5],[6,6],[5,6],[4,6],[4,5]],[0,0],'down');
  assert.deepEqual(E.step(self),{type:'crash',cause:'self'});assert.equal(self.outcome,'lost');
});
test('the head may follow into the cell the tail is leaving, but not when growing',()=>{
  const loop=scenario([[5,5],[5,6],[6,6],[6,5]],[0,0],'right');
  assert.deepEqual(E.step(loop),{type:'move'});assert.deepEqual(cells(loop),[[6,5],[5,5],[5,6],[6,6]]);
  // Food never spawns on the body; force it onto the tail to prove growth keeps the tail solid.
  const growing=scenario([[5,5],[5,6],[6,6],[6,5]],[6,5],'right');
  assert.deepEqual(E.step(growing),{type:'crash',cause:'self'});
});
test('speed and food value step up every five foods and cap at tier six',()=>{
  const s=E.create(9);const seen=[];
  for(let eaten=0;eaten<=40;eaten+=5){s.eaten=eaten;seen.push([E.speedTier(s),E.interval(s)]);}
  assert.deepEqual(seen,[[1,150],[2,134],[3,118],[4,102],[5,86],[6,70],[6,70],[6,70],[6,70]]);
});
test('filling the final free cell wins the round',()=>{
  // Serpentine path through every cell; the food is its first cell and the head its second.
  const path=[];for(let y=E.ROWS-1;y>=0;y--){const row=[];for(let x=0;x<E.COLS;x++)row.push([x,y]);if((E.ROWS-1-y)%2===0)row.reverse();path.push(...row);}
  const s=scenario(path.slice(1),path[0],'right');s.eaten=25;
  assert.deepEqual(path[0],[17,17]);assert.deepEqual(cells(s)[0],[16,17]);
  assert.deepEqual(E.step(s),{type:'won',points:60});assert.equal(s.outcome,'won');assert.equal(s.food,null);
  assert.equal(s.snake.length,E.COLS*E.ROWS);assert.equal(s.score,60);
});
test('scripted play from a seed is reproducible',()=>{
  const V={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]};
  // Greedy bot: nearest-to-food direction among moves that do not crash next step.
  const choose=s=>Object.keys(V).map(d=>{const x=s.snake[0].x+V[d][0],y=s.snake[0].y+V[d][1];
    const safe=x>=0&&y>=0&&x<E.COLS&&y<E.ROWS&&!s.snake.slice(0,-1).some(p=>p.x===x&&p.y===y);
    return {d,safe,dist:Math.abs(s.food.x-x)+Math.abs(s.food.y-y)};}).filter(c=>c.safe).sort((a,b)=>a.dist-b.dist)[0]?.d;
  const run=()=>{const s=E.create(1234),log=[];for(let n=0;n<3000&&s.outcome==='playing';n++){const d=choose(s);if(d)E.turn(s,d);log.push(E.step(s).type);}return {s,log};};
  const a=run(),b=run();assert.deepEqual(a,b);
  assert.ok(a.s.eaten>=10,'greedy play should eat at least ten foods, ate '+a.s.eaten);
  assert.equal(a.s.snake.length,E.START_LENGTH+a.s.eaten);assert.ok(a.s.score>=a.s.eaten*E.POINTS);
});
