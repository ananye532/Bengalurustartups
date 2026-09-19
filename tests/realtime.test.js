import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { attachRealtime } from '../server/realtime.js';
import { issueToken } from '../server/auth.js';

const SECRET = 'test-secret';

async function withRealtime(run) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: SECRET });
  const server = http.createServer(app);
  const realtime = attachRealtime(server, { secret: SECRET });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const sockets = [];
  const connect = async (username) => {
    const token = issueToken(SECRET, { id: sockets.length + 1, username });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  };

  // Resolve on the first 'peers' frame that satisfies `predicate`.
  const waitForPeers = (ws, predicate, timeoutMs = 4000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for a matching peers frame'));
    }, timeoutMs);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'peers' || !predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    }
    ws.on('message', onMessage);
  });

  try {
    await run({ connect, waitForPeers });
  } finally {
    for (const ws of sockets) ws.terminate();
    await realtime.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

test('drivers on the same track are broadcast to each other', async () => {
  await withRealtime(async ({ connect, waitForPeers }) => {
    const a = await connect('driver_a');
    const b = await connect('driver_b');

    a.send(JSON.stringify({ type: 'join', trackId: 'sunset-loop' }));
    b.send(JSON.stringify({ type: 'join', trackId: 'sunset-loop' }));
    a.send(JSON.stringify({ type: 'state', x: 10, y: 20, angle: 0.5, lap: 0, speed: 100 }));
    b.send(JSON.stringify({ type: 'state', x: 30, y: 40, angle: 1.5, lap: 1, speed: 200 }));

    const seenByA = await waitForPeers(a, (m) => m.peers.length > 0);
    assert.equal(seenByA.trackId, 'sunset-loop');
    assert.equal(seenByA.peers.length, 1, 'a driver is never shown to themselves');
    assert.equal(seenByA.peers[0].name, 'driver_b');
    assert.equal(seenByA.peers[0].x, 30);
    assert.equal(seenByA.peers[0].lap, 1);

    const seenByB = await waitForPeers(b, (m) => m.peers.length > 0);
    assert.equal(seenByB.peers[0].name, 'driver_a');
  });
});

test('drivers on different tracks never see each other', async () => {
  await withRealtime(async ({ connect, waitForPeers }) => {
    const a = await connect('driver_a');
    const b = await connect('driver_b');

    a.send(JSON.stringify({ type: 'join', trackId: 'sunset-loop' }));
    b.send(JSON.stringify({ type: 'join', trackId: 'night-circuit' }));
    a.send(JSON.stringify({ type: 'state', x: 1, y: 2, angle: 0, lap: 0, speed: 0 }));
    b.send(JSON.stringify({ type: 'state', x: 3, y: 4, angle: 0, lap: 0, speed: 0 }));

    const frame = await waitForPeers(a, (m) => m.trackId === 'sunset-loop');
    assert.deepEqual(frame.peers, []);
  });
});

test('leaving a track removes the driver from the broadcast', async () => {
  await withRealtime(async ({ connect, waitForPeers }) => {
    const a = await connect('driver_a');
    const b = await connect('driver_b');

    for (const ws of [a, b]) ws.send(JSON.stringify({ type: 'join', trackId: 'harbor-sprint' }));
    a.send(JSON.stringify({ type: 'state', x: 1, y: 1, angle: 0, lap: 0, speed: 0 }));
    b.send(JSON.stringify({ type: 'state', x: 2, y: 2, angle: 0, lap: 0, speed: 0 }));
    await waitForPeers(a, (m) => m.peers.length === 1);

    b.send(JSON.stringify({ type: 'leave' }));
    await waitForPeers(a, (m) => m.peers.length === 0);
  });
});

test('garbled frames and bad coordinates are ignored, not fatal', async () => {
  await withRealtime(async ({ connect, waitForPeers }) => {
    const a = await connect('driver_a');
    const b = await connect('driver_b');

    for (const ws of [a, b]) ws.send(JSON.stringify({ type: 'join', trackId: 'sunset-loop' }));
    b.send('not json at all');
    b.send(JSON.stringify({ type: 'state', x: 'over there', y: null, angle: 0 }));
    a.send(JSON.stringify({ type: 'state', x: 5, y: 5, angle: 0, lap: 0, speed: 0 }));

    // b published nothing usable, so a must still see an empty grid.
    const frame = await waitForPeers(a, () => true);
    assert.deepEqual(frame.peers, []);

    b.send(JSON.stringify({ type: 'state', x: 7, y: 7, angle: 0, lap: 0, speed: 0 }));
    const later = await waitForPeers(a, (m) => m.peers.length === 1);
    assert.equal(later.peers[0].x, 7);
  });
});
