import { getTrack } from '../shared/tracks.js';
import { decodeInputs, countTicks, simulate, TICK_RATE } from '../shared/physics.js';

/** Hard ceiling on replay length: 12 minutes of ticks. */
export const MAX_TICKS = TICK_RATE * 60 * 12;

/** Grace added to the wall-clock window so lag never invalidates an honest run. */
const CLOCK_SLACK_MS = 15_000;

/**
 * Score a submitted replay. The server never trusts a client-reported time: it
 * re-runs the shared simulation and reports what that produces.
 *
 * @param {object} race     the open race row
 * @param {Array}  rle      run-length encoded inputs
 * @param {number} now      Date.now() at submission
 * @returns {{ok: true, timeMs, bestLapMs, lapTimes, tickCount} | {ok: false, reason}}
 */
export function verifyRun(race, rle, now = Date.now()) {
  const track = getTrack(race.track_id);
  if (!track) return { ok: false, reason: 'unknown track' };

  let ticks;
  try {
    ticks = countTicks(rle);
  } catch {
    return { ok: false, reason: 'malformed replay' };
  }
  if (!Number.isFinite(ticks) || ticks < 1) return { ok: false, reason: 'empty replay' };
  if (ticks > MAX_TICKS) return { ok: false, reason: 'replay too long' };

  // A replay can never contain more ticks than the race has existed for.
  const elapsedMs = now - race.started_at;
  const allowedTicks = ((elapsedMs + CLOCK_SLACK_MS) / 1000) * TICK_RATE;
  if (ticks > allowedTicks) return { ok: false, reason: 'replay longer than the session' };

  let inputs;
  try {
    inputs = decodeInputs(rle, MAX_TICKS);
  } catch (err) {
    return { ok: false, reason: `malformed replay: ${err.message}` };
  }

  const result = simulate(track, inputs);
  if (!result.finished) {
    return { ok: false, reason: 'replay does not complete the race distance' };
  }

  const lapTimes = result.lapTimes;
  return {
    ok: true,
    timeMs: result.timeMs,
    bestLapMs: Math.min(...lapTimes),
    lapTimes,
    tickCount: result.car.finishTick,
  };
}
