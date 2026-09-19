import express from 'express';
import { TRACK_DEFS, listTracks } from '../../shared/tracks.js';
import { leaderboard, fastestRun } from '../db.js';

export function trackRoutes(db) {
  const router = express.Router();

  router.get('/', (_req, res) => res.json({ tracks: listTracks() }));

  router.get('/:id', (req, res) => {
    const def = TRACK_DEFS.find((t) => t.id === req.params.id);
    if (!def) return res.status(404).json({ error: 'no such track' });
    return res.json({ track: def });
  });

  router.get('/:id/leaderboard', (req, res) => {
    const def = TRACK_DEFS.find((t) => t.id === req.params.id);
    if (!def) return res.status(404).json({ error: 'no such track' });
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    return res.json({ entries: leaderboard(db, def.id, limit) });
  });

  // The record holder's input trace, replayed client-side as a ghost car.
  router.get('/:id/ghost', (req, res) => {
    const def = TRACK_DEFS.find((t) => t.id === req.params.id);
    if (!def) return res.status(404).json({ error: 'no such track' });
    const run = fastestRun(db, def.id);
    if (!run) return res.json({ ghost: null });
    return res.json({
      ghost: {
        raceId: run.id,
        username: run.username,
        timeMs: run.time_ms,
        inputs: JSON.parse(run.replay),
      },
    });
  });

  return router;
}
