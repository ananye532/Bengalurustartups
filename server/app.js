import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDatabase } from './db.js';
import { resolveSecret } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { trackRoutes } from './routes/tracks.js';
import { raceRoutes } from './routes/races.js';
import { rateLimit } from './ratelimit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/**
 * Build the Express app.
 * @param {{db?: object, secret?: string, dbFile?: string}} options
 */
export function createApp(options = {}) {
  const db = options.db ?? openDatabase(options.dbFile);
  const secret = options.secret ?? resolveSecret();

  const app = express();
  app.set('db', db);
  app.set('jwtSecret', secret);
  // Only the standalone server can host the presence WebSocket; a serverless
  // deployment flips this on never, and the client skips connecting.
  app.set('realtime', false);
  app.use(express.json({ limit: '2mb' }));

  app.use('/api/auth', rateLimit({ windowMs: 5 * 60_000, max: 40 }), authRoutes(db, secret));
  app.use('/api/tracks', trackRoutes(db));
  app.use('/api/races', rateLimit({ windowMs: 60_000, max: 120 }), raceRoutes(db, secret));
  app.get('/api/health', (_req, res) => res.json({
    ok: true,
    uptime: process.uptime(),
    realtime: app.get('realtime') === true,
  }));

  // The browser imports the simulation straight from /shared, so client and
  // server always score with byte-identical code.
  app.use('/shared', express.static(path.join(root, 'shared'), {
    setHeaders: (res) => res.setHeader('Content-Type', 'text/javascript; charset=utf-8'),
  }));
  app.use(express.static(path.join(root, 'public')));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'unknown endpoint' }));

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'malformed JSON body' });
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  });

  return app;
}
