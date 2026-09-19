/**
 * Small in-process rate limiter. Enough to blunt credential stuffing and replay
 * spam on a single-instance deployment; a multi-instance setup wants a shared
 * store (Redis or similar) instead.
 */
export function rateLimit({ windowMs, max, key = (req) => req.ip || 'unknown' }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) if (now > entry.reset) hits.delete(k);
  }, windowMs);
  sweep.unref?.();

  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    const entry = hits.get(k);

    if (!entry || now > entry.reset) {
      hits.set(k, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: 'too many requests, slow down' });
    }
    return next();
  };
}
