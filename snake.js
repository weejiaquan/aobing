/* Sky Snake: seeded grid rules and step timing, independent of canvas and input. */
(function (root) {
  'use strict';
  const COLS = 18, ROWS = 18, START_LENGTH = 3, POINTS = 10;
  const VECTORS = {up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0]};
  const OPPOSITE = {up: 'down', down: 'up', left: 'right', right: 'left'};
  function random(state) {
    let x = state.seed | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    state.seed = x >>> 0; return state.seed / 4294967296;
  }
  const same = (a, b) => a.x === b.x && a.y === b.y;
  function placeFood(state) {
    const taken = new Set(state.snake.map(p => p.y * COLS + p.x)), free = [];
    for (let i = 0; i < COLS * ROWS; i++) if (!taken.has(i)) free.push(i);
    if (!free.length) return null;
    const i = free[Math.floor(random(state) * free.length)];
    return {x: i % COLS, y: Math.floor(i / COLS)};
  }
  function create(seed = Math.floor(Math.random() * 4294967295)) {
    const y = Math.floor(ROWS / 2), head = Math.floor(COLS / 2);
    const state = {seed: (seed >>> 0) || 1, snake: Array.from({length: START_LENGTH}, (_, i) => ({x: head - i, y})),
      direction: 'right', queue: [], score: 0, eaten: 0, outcome: 'playing'};
    state.food = placeFood(state);
    return state;
  }
  // Buffers up to two turns so quick inputs between steps are not lost.
  function turn(state, direction) {
    const last = state.queue[state.queue.length - 1] || state.direction;
    if (state.outcome !== 'playing' || !VECTORS[direction] || direction === last || direction === OPPOSITE[last] || state.queue.length >= 2) return false;
    state.queue.push(direction); return true;
  }
  function step(state) {
    if (state.outcome !== 'playing') return {type: 'idle'};
    if (state.queue.length) state.direction = state.queue.shift();
    const [dx, dy] = VECTORS[state.direction], head = {x: state.snake[0].x + dx, y: state.snake[0].y + dy};
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) { state.outcome = 'lost'; return {type: 'crash', cause: 'wall'}; }
    const eating = same(head, state.food);
    // The tail vacates its cell this step unless the snake is growing.
    const body = eating ? state.snake : state.snake.slice(0, -1);
    if (body.some(p => same(p, head))) { state.outcome = 'lost'; return {type: 'crash', cause: 'self'}; }
    state.snake.unshift(head);
    if (!eating) { state.snake.pop(); return {type: 'move'}; }
    const points = POINTS * speedTier(state);
    state.eaten++; state.score += points;
    state.food = placeFood(state);
    if (!state.food) { state.outcome = 'won'; return {type: 'won', points}; }
    return {type: 'eat', points};
  }
  // Speed rises every five foods; later foods are worth more to match.
  function speedTier(state) { return Math.min(6, 1 + Math.floor(state.eaten / 5)); }
  function interval(state) { return 150 - (speedTier(state) - 1) * 16; }
  const api = {COLS, ROWS, START_LENGTH, POINTS, create, turn, step, speedTier, interval};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SnakeEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
