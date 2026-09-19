import { WebSocketServer } from 'ws';
import { readToken } from './auth.js';

const BROADCAST_HZ = 15;
const STALE_MS = 5000;
const MAX_MESSAGES_PER_SECOND = 90;

/**
 * Presence relay so drivers on the same track see each other live.
 * Positions are cosmetic only — nothing here feeds the leaderboard, which is
 * scored exclusively from verified replays.
 */
export function attachRealtime(server, { secret, path = '/ws' } = {}) {
  const wss = new WebSocketServer({ server, path });
  const rooms = new Map(); // trackId -> Set<ws>

  const join = (ws, trackId) => {
    leave(ws);
    if (!rooms.has(trackId)) rooms.set(trackId, new Set());
    rooms.get(trackId).add(ws);
    ws.trackId = trackId;
  };

  const leave = (ws) => {
    if (!ws.trackId) return;
    const room = rooms.get(ws.trackId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) rooms.delete(ws.trackId);
    }
    ws.trackId = null;
  };

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const claims = readToken(secret, url.searchParams.get('token') || '');
    ws.driver = claims?.username || 'guest';
    ws.driverId = claims?.sub || `anon-${Math.random().toString(36).slice(2, 8)}`;
    ws.trackId = null;
    ws.state = null;
    ws.budget = MAX_MESSAGES_PER_SECOND;

    ws.on('message', (raw) => {
      if (ws.budget-- <= 0) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'join' && typeof msg.trackId === 'string') {
        join(ws, msg.trackId);
      } else if (msg.type === 'leave') {
        leave(ws);
        ws.state = null;
      } else if (msg.type === 'state' && ws.trackId) {
        const { x, y, angle, lap, speed } = msg;
        if (![x, y, angle].every(Number.isFinite)) return;
        ws.state = {
          id: ws.driverId,
          name: ws.driver,
          x, y, angle,
          lap: Number(lap) || 0,
          speed: Number(speed) || 0,
          at: Date.now(),
        };
      }
    });

    ws.on('close', () => leave(ws));
    ws.on('error', () => leave(ws));
  });

  const refill = setInterval(() => {
    for (const ws of wss.clients) ws.budget = MAX_MESSAGES_PER_SECOND;
  }, 1000);

  const pump = setInterval(() => {
    const now = Date.now();
    for (const [trackId, room] of rooms) {
      const states = [];
      for (const ws of room) {
        if (ws.state && now - ws.state.at < STALE_MS) states.push(ws.state);
      }
      for (const ws of room) {
        if (ws.readyState !== ws.OPEN) continue;
        const peers = states.filter((s) => s.id !== ws.driverId);
        ws.send(JSON.stringify({ type: 'peers', trackId, peers }));
      }
    }
  }, 1000 / BROADCAST_HZ);

  const close = () => {
    clearInterval(pump);
    clearInterval(refill);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(resolve));
  };

  return { wss, close };
}
