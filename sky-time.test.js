'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getSkyState, getTourHour, STAGE_HOURS, TOUR_MS } = require('./sky-time.js');

function approximately(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`);
}

test('sky: midnight and midday have distinct, stable night/day lighting', () => {
  for (const hour of [0, 3, 22]) {
    const state = getSkyState(hour);
    assert.equal(state.phase, 'Night', `phase at ${hour}:00`);
    assert.equal(state.daylight, 0, `daylight at ${hour}:00`);
    assert.equal(state.warmth, 0, `warmth at ${hour}:00`);
    assert.equal(state.stars, 1, `stars at ${hour}:00`);
  }
  for (const hour of [9, 12, 15]) {
    const state = getSkyState(hour);
    assert.equal(state.phase, 'Day', `phase at ${hour}:00`);
    assert.equal(state.daylight, 1, `daylight at ${hour}:00`);
    assert.equal(state.warmth, 0, `warmth at ${hour}:00`);
    assert.equal(state.stars, 0, `stars at ${hour}:00`);
  }
});

test('sky: sunrise and sunset anchors provide their intended warm lighting', () => {
  const sunrise = getSkyState(6);
  assert.equal(sunrise.phase, 'Sunrise');
  approximately(sunrise.daylight, .35, 'sunrise daylight');
  approximately(sunrise.warmth, .72, 'sunrise warmth');
  assert.equal(sunrise.warmColor, '#efadc1');
  const sunset = getSkyState(18);
  assert.equal(sunset.phase, 'Sunset');
  approximately(sunset.daylight, .55, 'sunset daylight');
  approximately(sunset.warmth, .7, 'sunset warmth');
  assert.equal(sunset.warmColor, '#f48c52');
  assert.ok(sunrise.stars > 0 && sunrise.stars < 1);
  assert.ok(sunset.stars > 0 && sunset.stars < 1);
});

test('sky: phase changes occur at the intended local clock boundaries', () => {
  for (const [hour, phase] of [[4.999, 'Night'], [5, 'Sunrise'],
    [7.999, 'Sunrise'], [8, 'Day'], [16.999, 'Day'], [17, 'Sunset'],
    [19.999, 'Sunset'], [20, 'Night']]) {
    assert.equal(getSkyState(hour).phase, phase, `phase at hour ${hour}`);
  }
});

test('sky: positive and negative hours wrap across multiple days', () => {
  for (const hour of [0, .25, 6, 12, 18.5, 23.75]) {
    const expected = getSkyState(hour);
    for (const days of [-7, -2, -1, 1, 2, 7]) {
      assert.deepEqual(getSkyState(hour + days * 24), expected,
        `hour ${hour}, day offset ${days}`);
    }
  }
  assert.deepEqual(getSkyState(-0), getSkyState(0));
});

test('sky: lighting stays continuous across twilight anchors and midnight', () => {
  const epsilon = 1e-5;
  for (const hour of [0, 5, 6, 7, 8, 12, 16, 17, 18, 19, 20, 24]) {
    const before = getSkyState(hour - epsilon);
    const at = getSkyState(hour);
    const after = getSkyState(hour + epsilon);
    for (const field of ['daylight', 'warmth', 'stars']) {
      approximately(before[field], at[field], `${field} before hour ${hour}`, 1e-7);
      approximately(after[field], at[field], `${field} after hour ${hour}`, 1e-7);
    }
  }
});

test('sky: every minute of the day has finite, bounded lighting values', () => {
  const phases = new Set(['Night', 'Sunrise', 'Day', 'Sunset']);
  for (let minute = 0; minute <= 1440; minute++) {
    const state = getSkyState(minute / 60);
    for (const field of ['daylight', 'warmth', 'stars']) {
      assert.ok(Number.isFinite(state[field]), `${field} must be finite at minute ${minute}`);
      assert.ok(state[field] >= 0 && state[field] <= 1,
        `${field} must be within [0, 1] at minute ${minute}: ${state[field]}`);
    }
    assert.ok(phases.has(state.phase), `valid phase at minute ${minute}`);
    assert.match(state.warmColor, /^#[a-f\d]{6}$/i, `valid tint at minute ${minute}`);
  }
});

test('sky: dawn increases daylight and fades stars; dusk reverses that motion', () => {
  for (const [start, end, direction] of [[5, 8, 1], [16, 20, -1]]) {
    let previous = getSkyState(start);
    for (let minute = start * 60 + 1; minute <= end * 60; minute++) {
      const current = getSkyState(minute / 60);
      assert.ok((current.daylight - previous.daylight) * direction >= 0,
        `daylight moves consistently at minute ${minute}`);
      assert.ok((current.stars - previous.stars) * direction <= 0,
        `stars move opposite daylight at minute ${minute}`);
      previous = current;
    }
  }
});

test('sky: nonfinite and nonnumeric inputs are rejected without coercion', () => {
  for (const input of [NaN, Infinity, -Infinity, undefined, null, '6', '', true, {}, [], 6n]) {
    assert.throws(() => getSkyState(input), {
      name: 'TypeError', message: 'Sky time must be a finite hour',
    }, `reject input ${String(input)}`);
  }
  for (const input of [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE]) {
    const state = getSkyState(input);
    assert.ok(Number.isFinite(state.daylight), `finite number ${input} remains valid`);
  }
});

test('sky tour: sweeps a whole day in one minute, starting where it was', () => {
  assert.equal(TOUR_MS, 60000, 'one sweep lasts a minute');
  for (const from of [0, 6, 12, 18, 23, 23.75]) {
    assert.equal(getTourHour(0, from), from, `sweep starts at ${from}:00, without a jump`);
    assert.equal(getTourHour(TOUR_MS, from).toFixed(6), from.toFixed(6),
      `sweep returns to ${from}:00 after a full minute`);
    assert.equal(getTourHour(TOUR_MS / 2, from), (from + 12) % 24,
      `half a sweep is half a day from ${from}:00`);
    assert.equal(getTourHour(TOUR_MS * 3.5, from), (from + 12) % 24,
      `sweeps keep repeating past ${from}:00`);
  }
});

test('sky tour: the hour advances continuously, with no stage-sized jumps', () => {
  const step = TOUR_MS / 240;            // the shell renders far more often than this
  let previous = getTourHour(0, 6);
  const phases = new Set([getSkyState(previous).phase]);
  for (let elapsed = step; elapsed <= TOUR_MS; elapsed += step) {
    const hour = getTourHour(elapsed, 6);
    const advanced = (hour - previous + 24) % 24;
    assert.ok(advanced > 0 && advanced < 0.2,
      `at ${elapsed}ms the sweep moved ${advanced.toFixed(3)}h, expected a small forward step`);
    phases.add(getSkyState(hour).phase);
    previous = hour;
  }
  assert.deepEqual([...phases].sort(), ['Day', 'Night', 'Sunrise', 'Sunset'],
    'one sweep shows every sky phase');
});

test('sky tour: the slider checkpoints are the four art-directed stages', () => {
  assert.deepEqual(STAGE_HOURS, [6, 12, 18, 23], 'sunrise, day, sunset, night');
  assert.deepEqual(STAGE_HOURS.map((hour) => getSkyState(hour).phase),
    ['Sunrise', 'Day', 'Sunset', 'Night'], 'each checkpoint sits in its own phase');
  for (const hour of STAGE_HOURS) {
    assert.ok(hour >= 0 && hour <= 24, `checkpoint ${hour} fits on the 0-24 slider`);
  }
});

test('sky tour: nonfinite inputs are rejected without coercion', () => {
  for (const input of [NaN, Infinity, -1, -15000, undefined, null, '0', {}, []]) {
    assert.throws(() => getTourHour(input, 6), {
      name: 'TypeError', message: 'Sky tour needs a non-negative elapsed time',
    }, `reject elapsed ${String(input)}`);
  }
  for (const input of [NaN, Infinity, undefined, null, '6', {}, []]) {
    assert.throws(() => getTourHour(0, input), {
      name: 'TypeError', message: 'Sky tour needs a finite start hour',
    }, `reject start hour ${String(input)}`);
  }
});
