import { createCar, step, encodeInputs, INPUT } from '../shared/physics.js';

/**
 * Drive a lap the dumb way: aim at the next checkpoint, lift off for hairpins.
 * Used by the tests to produce a genuinely valid replay.
 */
export function autopilot(track, maxTicks = 20000) {
  const car = createCar(track);
  const masks = [];
  for (let t = 0; t < maxTicks && !car.finished; t++) {
    const cp = track.checkpoints[car.nextCheckpoint];
    let diff = Math.atan2(cp.y - car.y, cp.x - car.x) - car.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    let mask = Math.abs(diff) > 0.9 && car.speed > 300 ? INPUT.REVERSE : INPUT.THROTTLE;
    if (diff > 0.05) mask |= INPUT.RIGHT;
    else if (diff < -0.05) mask |= INPUT.LEFT;

    masks.push(mask);
    step(car, mask, track);
  }
  return { car, masks, inputs: encodeInputs(masks) };
}
