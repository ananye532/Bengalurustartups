import express from 'express';
import {
  hashPassword, verifyPassword, issueToken, validateCredentials, requireAuth,
} from '../auth.js';

export function authRoutes(db, secret) {
  const router = express.Router();

  router.post('/register', (req, res) => {
    const { username, password } = req.body ?? {};
    const problem = validateCredentials({ username, password });
    if (problem) return res.status(400).json({ error: problem });

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.status(409).json({ error: 'that driver name is taken' });

    const info = db.prepare(
      'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
    ).run(username, hashPassword(password), Date.now());

    const user = { id: Number(info.lastInsertRowid), username };
    return res.status(201).json({ token: issueToken(secret, user), user });
  });

  router.post('/login', (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password required' });
    }
    const row = db.prepare(
      'SELECT id, username, password_hash FROM users WHERE username = ?',
    ).get(username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: 'wrong driver name or password' });
    }
    const user = { id: row.id, username: row.username };
    return res.json({ token: issueToken(secret, user), user });
  });

  router.get('/me', requireAuth(secret, db), (req, res) => {
    const stats = db.prepare(`
      SELECT COUNT(*) AS races, MIN(time_ms) AS best_any
      FROM races WHERE user_id = ? AND status = 'verified'
    `).get(req.user.id);
    return res.json({ user: req.user, stats });
  });

  return router;
}
