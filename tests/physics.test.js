import test from 'node:test';
import assert from 'node:assert/strict';
import { getTrack, TRACK_DEFS } from '../shared/tracks.js';
import {
  INPUT, createCar, step, simulate, encodeInputs, decodeInputs, countTicks, ticksToMs,
} from '../shared/physics.js';
import { autopilot } from './helpers.js';

const track = getTrack('sunset-loop');

test('a car left alone does not move', () => {
  const car = createCar(track);
  for (let i = 0; i < 120; i++) step(car, INPUT.NONE, track);
  assert.equal(car.x, track.start.x);
  assert.equal(car.y, track.start.y);
  assert.equal(car.lap, 0);
});

test('throttle accelerates, braking scrubs speed off', () => {
  const car = createCar(track);
  for (let i = 0; i < 60; i++) step(car, INPUT.THROTTLE, track);
  const cruising = car.speed;
  assert.ok(cruising > 100, `expected the car to be moving, got ${cruising}`);

  for (let i = 0; i < 30; i++) step(car, INPUT.REVERSE, track);
  assert.ok(car.speed < cruising, 'braking should reduce speed');
});

test('the simulation is deterministic for identical inputs', () => {
  const { masks } = autopilot(track);
  const a = simulate(track, masks);
  const b = simulate(track, masks);
  assert.equal(a.timeMs, b.timeMs);
  assert.deepEqual(a.lapTimes, b.lapTimes);
  assert.equal(a.car.x, b.car.x);
  assert.equal(a.car.y, b.car.y);
  assert.equal(a.car.angle, b.car.angle);
});

test('checkpoints must be taken in order before a lap counts', () => {
  const car = createCar(track);
  // Teleporting to the finish line without visiting the checkpoints proves
  // nothing: the next expected checkpoint is still #1.
  car.x = track.checkpoints[0].x;
  car.y = track.checkpoints[0].y;
  step(car, INPUT.NONE, track);
  assert.equal(car.lap, 0);
  assert.equal(car.nextCheckpoint, 1);
});

test('off-track running is slower than staying on the road', () => {
  // One second of throttle keeps both cars on the start straight, clear of the
  // first corner and the barriers.
  const onRoad = createCar(track);
  for (let i = 0; i < 60; i++) step(onRoad, INPUT.THROTTLE, track);
  assert.equal(onRoad.offTrack, false);

  const offRoad = createCar(track);
  for (let i = 0; i < 60; i++) {
    offRoad.offTrack = true; // hold it in the gravel
    step(offRoad, INPUT.THROTTLE, track);
  }
  assert.ok(
    offRoad.speed < onRoad.speed * 0.75,
    `gravel (${offRoad.speed.toFixed(1)}) should cost real speed vs tarmac (${onRoad.speed.toFixed(1)})`,
  );
});

test('run-length encoding round-trips', () => {
  const masks = [0, 0, 0, 1, 1, 9, 9, 9, 0];
  const rle = encodeInputs(masks);
  assert.deepEqual(rle, [[0, 3], [1, 2], [9, 3], [0, 1]]);
  assert.deepEqual(decodeInputs(rle), masks);
  assert.equal(countTicks(rle), masks.length);
});

test('decodeInputs rejects malformed or oversized traces', () => {
  assert.throws(() => decodeInputs('nope'), TypeError);
  assert.throws(() => decodeInputs([[1]]), TypeError);
  assert.throws(() => decodeInputs([[99, 1]]), RangeError);
  assert.throws(() => decodeInputs([[1, 0]]), RangeError);
  assert.throws(() => decodeInputs([[1, 10]], 5), RangeError);
});

test('every circuit can be completed and reports one time per lap', () => {
  for (const def of TRACK_DEFS) {
    const circuit = getTrack(def.id);
    const { car } = autopilot(circuit);
    assert.ok(car.finished, `${def.id} was not completed by the autopilot`);
    assert.equal(car.lapTimes.length, def.laps);
    const sum = car.lapTimes.reduce((a, b) => a + b, 0);
    // Per-lap times are rounded individually, so allow a millisecond of drift.
    assert.ok(Math.abs(ticksToMs(car.finishTick) - sum) <= car.lapTimes.length);
  }
});
