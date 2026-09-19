import crypto from 'node:crypto';
import express from 'express';
import { getTrack } from '../../shared/tracks.js';
import { requireAuth } from '../auth.js';
import { personalBest, rankOf } from '../db.js';
import { verifyRun } from '../verify.js';

/** An open race that is never submitted is abandoned after this long. */
const SESSION_TTL_MS = 60 * 60 * 1000;

export function raceRoutes(db, secret) {
  const router = express.Router();
  const auth = requireAuth(secret, db);

  // Open a server-side race session. The id returned here is what a finished
  // run is submitted against, which stops replays being re-submitted forever.
  router.post('/', auth, (req, res) => {
    const trackId = req.body?.trackId;
    const track = getTrack(trackId);
    if (!track) return res.status(400).json({ error: 'no such track' });

    const id = crypto.randomUUID();
    const startedAt = Date.now();
    db.prepare(`
      INSERT INTO races (id, user_id, track_id, status, started_at)
      VALUES (?, ?, ?, 'open', ?)
    `).run(id, req.user.id, track.id, startedAt);

    const pb = personalBest(db, req.user.id, track.id);
    return res.status(201).json({
      race: { id, trackId: track.id, startedAt, laps: track.laps },
      personalBest: pb ? { timeMs: pb.time_ms, bestLapMs: pb.best_lap_ms } : null,
    });
  });

  router.post('/:id/finish', auth, (req, res) => {
    const race = db.prepare('SELECT * FROM races WHERE id = ?').get(req.params.id);
    if (!race || race.user_id !== req.user.id) {
      return res.status(404).json({ error: 'no such race session' });
    }
    if (race.status !== 'open') {
      return res.status(409).json({ error: 'race session already submitted' });
    }
    if (Date.now() - race.started_at > SESSION_TTL_MS) {
      db.prepare("UPDATE races SET status = 'expired' WHERE id = ?").run(race.id);
      return res.status(410).json({ error: 'race session expired' });
    }

    const inputs = req.body?.inputs;
    if (!Array.isArray(inputs)) return res.status(400).json({ error: 'inputs required' });

    const result = verifyRun(race, inputs, Date.now());
    if (!result.ok) {
      db.prepare(`
        UPDATE races SET status = 'rejected', finished_at = ?, reject_reason = ?
        WHERE id = ?
      `).run(Date.now(), result.reason, race.id);
      return res.status(422).json({ error: result.reason });
    }

    const previous = personalBest(db, req.user.id, race.track_id);
    db.prepare(`
      UPDATE races
      SET status = 'verified', finished_at = ?, time_ms = ?, best_lap_ms = ?,
          lap_times = ?, tick_count = ?, replay = ?
      WHERE id = ?
    `).run(
      Date.now(), result.timeMs, result.bestLapMs,
      JSON.stringify(result.lapTimes), result.tickCount,
      JSON.stringify(inputs), race.id,
    );

    return res.json({
      raceId: race.id,
      timeMs: result.timeMs,
      bestLapMs: result.bestLapMs,
      lapTimes: result.lapTimes,
      rank: rankOf(db, race.track_id, result.timeMs),
      personalBest: !previous || result.timeMs < previous.time_ms,
      previousBestMs: previous ? previous.time_ms : null,
    });
  });

  router.get('/mine', auth, (req, res) => {
    const rows = db.prepare(`
      SELECT id, track_id, time_ms, best_lap_ms, lap_times, finished_at
      FROM races
      WHERE user_id = ? AND status = 'verified'
      ORDER BY finished_at DESC
      LIMIT 25
    `).all(req.user.id);
    return res.json({
      races: rows.map((r) => ({ ...r, lap_times: JSON.parse(r.lap_times || '[]') })),
    });
  });

  router.get('/:id/replay', (req, res) => {
    const row = db.prepare(`
      SELECT r.id, r.track_id, r.time_ms, r.replay, r.status, u.username
      FROM races r JOIN users u ON u.id = r.user_id
      WHERE r.id = ?
    `).get(req.params.id);
    if (!row || row.status !== 'verified') return res.status(404).json({ error: 'no such replay' });
    return res.json({
      replay: {
        raceId: row.id,
        trackId: row.track_id,
        username: row.username,
        timeMs: row.time_ms,
        inputs: JSON.parse(row.replay),
      },
    });
  });

  return router;
}
