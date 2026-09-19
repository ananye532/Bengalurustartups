import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const TOKEN_TTL = '7d';

/**
 * In development a random secret is generated per boot (tokens simply expire on
 * restart). In production JWT_SECRET must be set explicitly.
 */
export function resolveSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  }
  return crypto.randomBytes(32).toString('hex');
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function issueToken(secret, user) {
  return jwt.sign({ sub: String(user.id), username: user.username }, secret, {
    expiresIn: TOKEN_TTL,
  });
}

export function readToken(secret, token) {
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

/** Express middleware factory: populates req.user or answers 401. */
export function requireAuth(secret, db) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = token ? readToken(secret, token) : null;
    if (!claims) return res.status(401).json({ error: 'authentication required' });
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(claims.sub));
    if (!user) return res.status(401).json({ error: 'account no longer exists' });
    req.user = user;
    return next();
  };
}

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

export function validateCredentials({ username, password }) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return '3-20 characters, letters, digits, underscore or dash only';
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return 'password must be 8-200 characters';
  }
  return null;
}
