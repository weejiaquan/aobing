/* Gem Rush: deterministic match-three rules, independent of UI and economy. */
(function (root) {
  'use strict';
  const SIZE = 8, COLORS = 6, MOVES = 30;
  const copy = board => board.map(gem => gem && {...gem});
  const adjacent = (a, b) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < 64 && b < 64 &&
    Math.abs(a % SIZE - b % SIZE) + Math.abs(Math.floor(a / SIZE) - Math.floor(b / SIZE)) === 1;
  function random(state) {
    let x = state.seed | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    state.seed = x >>> 0; return state.seed / 4294967296;
  }
  function gem(state, color) { return {id: state.nextId++, color, special: ''}; }
  function runs(board) {
    const found = [];
    for (const step of [1, SIZE]) for (let line = 0; line < SIZE; line++) {
      const start = step === 1 ? line * SIZE : line;
      let group = [];
      const flush = () => { if (group.length >= 3) found.push({cells: group, direction: step === 1 ? 'row' : 'column'}); group = []; };
      for (let n = 0; n < SIZE; n++) {
        const i = start + n * step, tile = board[i];
        if (!tile || tile.special === 'prism') { flush(); continue; }
        if (group.length && board[group[0]].color !== tile.color) flush();
        group.push(i);
      }
      flush();
    }
    return found;
  }
  function matches(board) { return [...new Set(runs(board).flatMap(run => run.cells))]; }
  function findMove(board) {
    for (let a = 0; a < 64; a++) for (const b of [a + 1, a + SIZE]) {
      if (!adjacent(a,b) || !board[a] || !board[b]) continue;
      if (board[a].special === 'prism' || board[b].special === 'prism') return [a,b];
      [board[a],board[b]] = [board[b],board[a]];
      const valid = matches(board).length > 0;
      [board[a],board[b]] = [board[b],board[a]];
      if (valid) return [a,b];
    }
    return null;
  }
  function freshBoard(state) {
    // Fill without existing matches, then require a legal move. Seeded fallback
    // bounds board generation even if a caller supplied an unfortunate seed.
    for (let attempt = 0; attempt < 100; attempt++) {
      const board = [];
      for (let i = 0; i < 64; i++) {
        const allowed = Array.from({length:COLORS},(_,c)=>c).filter(c =>
          !(i % SIZE >= 2 && board[i-1].color === c && board[i-2].color === c) &&
          !(i >= SIZE*2 && board[i-SIZE].color === c && board[i-SIZE*2].color === c));
        board.push(gem(state,allowed[Math.floor(random(state)*allowed.length)]));
      }
      if (findMove(board)) return board;
    }
    // Known playable, match-free pattern; no recursive regeneration.
    const board = Array.from({length:64},(_,i)=>gem(state,(Math.floor(i/8)*2+i%8)%6));
    [0,1,10].forEach(i=>{board[i].color=0;}); board[2].color=1;
    return board;
  }
  function create(seed = Math.floor(Math.random()*4294967295), level = 1) {
    const state = {version:1,seed:(seed >>> 0) || 1,nextId:1,level:Math.max(1,Math.min(999,Math.floor(level)||1)),score:0,moves:MOVES,bestCascade:0,outcome:'playing'};
    state.target = 4000 + (state.level-1)*750;
    state.board = freshBoard(state); return state;
  }
  function specialPlans(board, groups, preferred) {
    const components = [];
    for (const run of groups) {
      const touched = components.filter(c => run.cells.some(i=>c.cells.has(i)));
      const component = {cells:new Set(run.cells),runs:[run]};
      for (const c of touched) { c.cells.forEach(i=>component.cells.add(i)); component.runs.push(...c.runs); components.splice(components.indexOf(c),1); }
      components.push(component);
    }
    return components.flatMap(c => {
      const longest = c.runs.reduce((a,b)=>a.cells.length >= b.cells.length ? a : b);
      const special = longest.cells.length >= 5 ? 'prism' : c.runs.length > 1 ? 'blast' : longest.cells.length >= 4 ? longest.direction : '';
      if (!special) return [];
      const choices = [...preferred,...c.cells].filter(i=>c.cells.has(i) && !board[i].special);
      return choices.length ? [{index:choices[0],special}] : [];
    });
  }
  function expand(board, initial, activatedPrism) {
    const clear = new Set(initial), done = new Set();
    for (const i of clear) {
      const tile = board[i]; if (!tile || !tile.special || done.has(i)) continue;
      if (i === activatedPrism) continue; // Direct prism swaps clear the chosen color.
      done.add(i);
      for (let j = 0; j < 64; j++) {
        if (tile.special === 'row' && Math.floor(j/8) === Math.floor(i/8) ||
            tile.special === 'column' && j%8 === i%8 ||
            tile.special === 'blast' && Math.abs(j%8-i%8) <= 1 && Math.abs(Math.floor(j/8)-Math.floor(i/8)) <= 1 ||
            tile.special === 'prism' && board[j]?.color === tile.color) clear.add(j);
      }
    }
    return clear;
  }
  function fall(state) {
    const board = state.board;
    for (let col = 0; col < 8; col++) {
      const survivors = [];
      for (let row = 7; row >= 0; row--) if (board[row*8+col]) survivors.push(board[row*8+col]);
      for (let row = 7; row >= 0; row--) board[row*8+col] = survivors[7-row] || gem(state,Math.floor(random(state)*COLORS));
    }
  }
  function move(original,a,b) {
    if (original.outcome !== 'playing' || !adjacent(a,b)) return {valid:false,state:original,frames:[]};
    const state = {...original,board:copy(original.board)}, frames = [];
    const snapshot = (kind, extra={}) => frames.push({kind,board:copy(state.board),score:state.score,...extra});
    [state.board[a],state.board[b]] = [state.board[b],state.board[a]];
    let initial = [];
    const prism = [a,b].find(i=>state.board[i].special === 'prism');
    if (prism !== undefined) {
      const other = prism === a ? b : a;
      initial = state.board.flatMap((tile,i)=>state.board[other].special === 'prism' || tile.color === state.board[other].color || i === prism ? [i] : []);
    }
    if (!initial.length && !matches(state.board).length) return {valid:false,state:original,frames:[]};
    state.moves--; snapshot('swap');
    let chain = 0;
    while (initial.length || matches(state.board).length) {
      chain++;
      const groups = runs(state.board), plans = initial.length ? [] : specialPlans(state.board,groups,chain === 1 ? [b,a] : []);
      const clear = expand(state.board,initial.length ? initial : groups.flatMap(r=>r.cells),chain === 1 ? prism : undefined); initial = [];
      for (const plan of plans) clear.delete(plan.index);
      state.score += clear.size * 50 * Math.min(chain,5) + plans.length * 100;
      snapshot('clear',{cleared:[...clear],chain});
      for (const i of clear) state.board[i] = null;
      for (const plan of plans) state.board[plan.index].special = plan.special;
      snapshot('cleared',{chain}); fall(state); snapshot('fall',{chain});
      if (chain >= 50) { state.board=freshBoard(state);snapshot('shuffle');break; }
    }
    state.bestCascade = Math.max(state.bestCascade,chain);
    state.outcome = state.score >= state.target ? 'won' : state.moves <= 0 ? 'lost' : 'playing';
    if (state.outcome === 'playing' && !findMove(state.board)) { state.board=freshBoard(state);snapshot('shuffle'); }
    return {valid:true,state,frames,chain};
  }
  function restore(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.board) || value.board.length !== 64) return null;
    for (const key of ['seed','nextId','level','score','moves','target','bestCascade']) if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    if (!value.seed || value.seed > 4294967295 || value.level < 1 || value.level > 999 || value.moves > MOVES || value.target !== 4000+(value.level-1)*750) return null;
    if (!['playing','won','lost'].includes(value.outcome) || value.outcome !== (value.score >= value.target ? 'won' : value.moves === 0 ? 'lost' : 'playing')) return null;
    if (value.board.some(g=>!g || !Number.isSafeInteger(g.id) || g.id < 1 || g.id >= value.nextId || !Number.isInteger(g.color) || g.color < 0 || g.color >= COLORS || !['','row','column','blast','prism'].includes(g.special))) return null;
    if (new Set(value.board.map(g=>g.id)).size !== 64 || matches(value.board).length || value.outcome === 'playing' && !findMove(value.board)) return null;
    return {...value,board:copy(value.board)};
  }
  const api = {SIZE,COLORS,MOVES,adjacent,matches,runs,findMove,create,move,restore};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GemEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
