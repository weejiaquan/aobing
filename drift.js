/* Merge Drift: deterministic sliding-merge rules, independent of UI and economy. */
(function (root) {
  'use strict';
  const SIZE = 4, CELLS = SIZE * SIZE, GOAL = 2048, MAX_VALUE = 131072;
  const DIRECTIONS = ['left', 'right', 'up', 'down'];
  const copy = board => board.map(tile => tile && {...tile});
  function random(state) {
    let x = state.seed | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    state.seed = x >>> 0; return state.seed / 4294967296;
  }
  // Cell indices of each line, ordered from the edge tiles slide toward.
  function lines(direction) {
    return Array.from({length: SIZE}, (_, line) => Array.from({length: SIZE}, (_, n) =>
      direction === 'left' ? line * SIZE + n : direction === 'right' ? line * SIZE + SIZE - 1 - n :
      direction === 'up' ? n * SIZE + line : (SIZE - 1 - n) * SIZE + line));
  }
  function canMove(board) {
    return board.some((tile, i) => !tile ||
      i % SIZE < SIZE - 1 && board[i + 1]?.value === tile.value ||
      i < CELLS - SIZE && board[i + SIZE]?.value === tile.value);
  }
  const highest = board => board.reduce((max, tile) => Math.max(max, tile ? tile.value : 0), 0);
  function spawn(state) {
    const empty = state.board.flatMap((tile, i) => tile ? [] : [i]);
    if (!empty.length) return null;
    const index = empty[Math.floor(random(state) * empty.length)];
    const tile = {id: state.nextId++, value: random(state) < .9 ? 2 : 4};
    state.board[index] = tile;
    return {id: tile.id, index, value: tile.value};
  }
  function create(seed = Math.floor(Math.random() * 4294967295)) {
    const state = {version: 1, seed: (seed >>> 0) || 1, nextId: 1, board: Array(CELLS).fill(null), score: 0, moves: 0, reached: false, outcome: 'playing'};
    spawn(state); spawn(state);
    return state;
  }
  function move(original, direction) {
    if (original.outcome !== 'playing' || !DIRECTIONS.includes(direction)) return {valid: false, state: original};
    const state = {...original, board: Array(CELLS).fill(null)}, slides = [], merges = [];
    let gained = 0;
    for (const line of lines(direction)) {
      let target = -1, mergeable = false;
      for (const from of line) {
        const tile = original.board[from];
        if (!tile) continue;
        if (mergeable && state.board[line[target]].value === tile.value) {
          // Each tile merges at most once per move; the result is a new tile.
          const to = line[target], merged = {id: state.nextId++, value: tile.value * 2};
          slides.push({id: tile.id, from, to});
          merges.push({id: merged.id, index: to, value: merged.value, from: [state.board[to].id, tile.id]});
          state.board[to] = merged; gained += merged.value; mergeable = false;
        } else {
          const to = line[++target];
          slides.push({id: tile.id, from, to});
          state.board[to] = {...tile}; mergeable = true;
        }
      }
    }
    if (!merges.length && slides.every(slide => slide.from === slide.to)) return {valid: false, state: original};
    state.score += gained; state.moves++;
    const spawned = spawn(state), reachedNow = !state.reached && highest(state.board) >= GOAL;
    state.reached = state.reached || reachedNow;
    state.outcome = reachedNow ? 'won' : canMove(state.board) ? 'playing' : 'lost';
    return {valid: true, state, slides, merges, spawned, gained};
  }
  function keepPlaying(state) {
    if (state.outcome !== 'won') return state;
    return {...state, board: copy(state.board), outcome: canMove(state.board) ? 'playing' : 'lost'};
  }
  function restore(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.board) || value.board.length !== CELLS) return null;
    for (const key of ['seed', 'nextId', 'score', 'moves']) if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    if (!value.seed || value.seed > 4294967295 || typeof value.reached !== 'boolean') return null;
    const tiles = value.board.filter(Boolean);
    if (!tiles.length || tiles.some(tile => !Number.isSafeInteger(tile.id) || tile.id < 1 || tile.id >= value.nextId ||
      !Number.isSafeInteger(tile.value) || tile.value < 2 || tile.value > MAX_VALUE || (tile.value & (tile.value - 1)))) return null;
    if (new Set(tiles.map(tile => tile.id)).size !== tiles.length || value.board.some(tile => tile !== null && typeof tile !== 'object')) return null;
    // Tiles only ever grow, so the goal flag must match the largest tile.
    if (value.reached !== highest(value.board) >= GOAL) return null;
    const movable = canMove(value.board);
    if (!(value.outcome === 'playing' && movable || value.outcome === 'lost' && !movable || value.outcome === 'won' && value.reached)) return null;
    return {...value, board: copy(value.board)};
  }
  const api = {SIZE, CELLS, GOAL, DIRECTIONS, canMove, highest, create, move, keepPlaying, restore};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DriftEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
