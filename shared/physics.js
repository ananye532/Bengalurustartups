// Deterministic fixed-timestep car simulation.
//
// The browser runs this to drive the car the player sees; the server runs the
// exact same code over the submitted input trace to produce the authoritative
// lap time. Nothing in here may read wall-clock time, randomness or the DOM.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

/** World units are pixels; this is the scale used for readouts in m and km/h. */
export const PX_PER_METRE = 8;

export const INPUT = {
  NONE: 0,
  THROTTLE: 1,
  REVERSE: 2,
  LEFT: 4,
  RIGHT: 8,
  HANDBRAKE: 16,
};

const ENGINE = 700;        // forward acceleration, px/s^2
const REVERSE_ENGINE = 320;
const BRAKE = 1250;
const ROLLING_DRAG = 0.85; // per second, applied to forward velocity
const AIR_DRAG = 0.0009;   // quadratic term
const GRIP = 7.2;          // lateral velocity bleed on tarmac, per second
const HANDBRAKE_GRIP = 1.5;
const OFF_TRACK_GRIP = 3.4;
const OFF_TRACK_DRAG = 3.1;
const TURN_RATE = 3.1;     // rad/s at full lock
const MAX_SPEED = 460;
const MAX_SPEED_OFF = 240;
const MAX_REVERSE_SPEED = 170;
const WALL_MARGIN = 10;    // how far past the kerb the car may travel
const WALL_BOUNCE = 0.45;  // velocity retained after scraping the barrier

/** Fresh car state on the grid. `lane` offsets multiple cars side by side. */
export function createCar(track, lane = 0) {
  const { x, y, angle } = track.start;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return {
    x: x + nx * lane,
    y: y + ny * lane,
    angle,
    vx: 0,
    vy: 0,
    speed: 0,
    offTrack: false,
    tick: 0,
    lap: 0,
    nextCheckpoint: 1,
    lapStartTick: 0,
    lapTimes: [],
    finished: false,
    finishTick: 0,
  };
}

/** Closest point on the centerline. Returns squared-free distance + segment. */
export function nearestOnTrack(track, x, y) {
  let best = Infinity;
  let bestIndex = 0;
  let bestX = 0;
  let bestY = 0;
  const segs = track.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    let t = 0;
    if (s.len2 > 0) {
      t = ((x - s.x) * s.dx + (y - s.y) * s.dy) / s.len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const px = s.x + s.dx * t;
    const py = s.y + s.dy * t;
    const dx = x - px;
    const dy = y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      bestIndex = i;
      bestX = px;
      bestY = py;
    }
  }
  return { dist: Math.sqrt(best), index: bestIndex, x: bestX, y: bestY };
}

/**
 * Advance the car by one tick.
 * @param {object} car   mutated in place
 * @param {number} input bitmask of INPUT flags
 * @param {object} track built track geometry
 * @returns {object} the same car
 */
export function step(car, input, track) {
  if (car.finished) return car;

  const throttle = (input & INPUT.THROTTLE) !== 0;
  const reverse = (input & INPUT.REVERSE) !== 0;
  const left = (input & INPUT.LEFT) !== 0;
  const right = (input & INPUT.RIGHT) !== 0;
  const handbrake = (input & INPUT.HANDBRAKE) !== 0;

  let fx = Math.cos(car.angle);
  let fy = Math.sin(car.angle);
  let forward = car.vx * fx + car.vy * fy;
  let lateral = -car.vx * fy + car.vy * fx;

  // Steering authority builds with speed so a parked car cannot pirouette.
  const steer = (right ? 1 : 0) - (left ? 1 : 0);
  if (steer !== 0) {
    const authority = Math.min(1, Math.abs(forward) / 90);
    const direction = forward < 0 ? -1 : 1;
    car.angle += steer * TURN_RATE * authority * direction * DT;
    fx = Math.cos(car.angle);
    fy = Math.sin(car.angle);
  }

  let accel = 0;
  if (throttle) accel += ENGINE;
  if (reverse) {
    // Tapping reverse while rolling forward acts as the brake pedal.
    accel -= forward > 20 ? BRAKE : REVERSE_ENGINE;
  }
  forward += accel * DT;

  const off = car.offTrack;
  const drag = ROLLING_DRAG + (off ? OFF_TRACK_DRAG : 0);
  forward -= forward * drag * DT;
  forward -= Math.sign(forward) * AIR_DRAG * forward * forward * DT;

  let grip = off ? OFF_TRACK_GRIP : GRIP;
  if (handbrake) {
    grip = HANDBRAKE_GRIP;
    forward -= forward * 1.6 * DT;
  }
  lateral -= lateral * grip * DT;

  const cap = off ? MAX_SPEED_OFF : MAX_SPEED;
  if (forward > cap) forward = cap;
  else if (forward < -MAX_REVERSE_SPEED) forward = -MAX_REVERSE_SPEED;

  car.vx = forward * fx - lateral * fy;
  car.vy = forward * fy + lateral * fx;
  car.x += car.vx * DT;
  car.y += car.vy * DT;

  // Surface + barrier response.
  const near = nearestOnTrack(track, car.x, car.y);
  car.offTrack = near.dist > track.halfWidth;
  const limit = track.halfWidth + WALL_MARGIN;
  if (near.dist > limit) {
    const nx = (car.x - near.x) / near.dist;
    const ny = (car.y - near.y) / near.dist;
    car.x = near.x + nx * limit;
    car.y = near.y + ny * limit;
    const into = car.vx * nx + car.vy * ny;
    if (into > 0) {
      car.vx -= nx * into * (1 + WALL_BOUNCE);
      car.vy -= ny * into * (1 + WALL_BOUNCE);
    }
    car.vx *= 0.9;
    car.vy *= 0.9;
  }

  car.speed = Math.hypot(car.vx, car.vy);
  car.tick += 1;
  advanceProgress(car, track);
  return car;
}

function advanceProgress(car, track) {
  const cps = track.checkpoints;
  const target = cps[car.nextCheckpoint];
  const dx = car.x - target.x;
  const dy = car.y - target.y;
  const reach = track.halfWidth + 16;
  if (dx * dx + dy * dy > reach * reach) return;

  // Checkpoint 0 sits on the start/finish line, so reaching it closes a lap.
  const crossedLine = car.nextCheckpoint === 0;
  car.nextCheckpoint = (car.nextCheckpoint + 1) % cps.length;
  if (!crossedLine) return;

  const lapTicks = car.tick - car.lapStartTick;
  car.lapTimes.push(ticksToMs(lapTicks));
  car.lapStartTick = car.tick;
  car.lap += 1;
  if (car.lap >= track.laps) {
    car.finished = true;
    car.finishTick = car.tick;
  }
}

export const ticksToMs = (ticks) => Math.round((ticks * 1000) / TICK_RATE);

/** Run-length encode a per-tick input array into [[mask, count], ...]. */
export function encodeInputs(masks) {
  const out = [];
  for (const mask of masks) {
    const last = out[out.length - 1];
    if (last && last[0] === mask) last[1] += 1;
    else out.push([mask, 1]);
  }
  return out;
}

/** Inverse of encodeInputs. Throws on malformed input. */
export function decodeInputs(rle, maxTicks = 60 * 60 * 20) {
  if (!Array.isArray(rle)) throw new TypeError('inputs must be an array');
  const out = [];
  for (const pair of rle) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('bad input pair');
    const [mask, count] = pair;
    if (!Number.isInteger(mask) || mask < 0 || mask > 31) throw new RangeError('bad input mask');
    if (!Number.isInteger(count) || count < 1) throw new RangeError('bad input count');
    if (out.length + count > maxTicks) throw new RangeError('replay too long');
    for (let i = 0; i < count; i++) out.push(mask);
  }
  return out;
}

export function countTicks(rle) {
  let total = 0;
  for (const [, count] of rle) total += count;
  return total;
}

/**
 * Replay an input trace from the grid. Used by the server to score a run and by
 * the client to play back a ghost.
 * @returns {{car: object, finished: boolean, timeMs: number, lapTimes: number[]}}
 */
export function simulate(track, inputs, { lane = 0, onTick } = {}) {
  const car = createCar(track, lane);
  for (let i = 0; i < inputs.length && !car.finished; i++) {
    step(car, inputs[i], track);
    if (onTick) onTick(car, i);
  }
  return {
    car,
    finished: car.finished,
    timeMs: car.finished ? ticksToMs(car.finishTick) : ticksToMs(car.tick),
    lapTimes: car.lapTimes.slice(),
  };
}
