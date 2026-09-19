import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { getTrack } from '../shared/tracks.js';
import { autopilot } from './helpers.js';

const TRACK = 'sunset-loop';

async function withServer(run) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body: payload };
  };

  try {
    await run({ call, db });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

const signUp = async (call, username = 'driver_one') => {
  const res = await call('POST', '/api/auth/register', {
    body: { username, password: 'fast-enough-1' },
  });
  assert.equal(res.status, 201);
  return res.body.token;
};

test('registration validates the driver name and password', async () => {
  await withServer(async ({ call }) => {
    const short = await call('POST', '/api/auth/register', { body: { username: 'ab', password: 'longenough' } });
    assert.equal(short.status, 400);

    const weak = await call('POST', '/api/auth/register', { body: { username: 'valid_name', password: 'short' } });
    assert.equal(weak.status, 400);

    await signUp(call, 'valid_name');
    const dupe = await call('POST', '/api/auth/register', { body: { username: 'VALID_NAME', password: 'fast-enough-1' } });
    assert.equal(dupe.status, 409, 'driver names are case-insensitively unique');
  });
});

test('login returns a token that /me accepts', async () => {
  await withServer(async ({ call }) => {
    await signUp(call);
    const bad = await call('POST', '/api/auth/login', { body: { username: 'driver_one', password: 'wrong-password' } });
    assert.equal(bad.status, 401);

    const good = await call('POST', '/api/auth/login', { body: { username: 'driver_one', password: 'fast-enough-1' } });
    assert.equal(good.status, 200);

    const me = await call('GET', '/api/auth/me', { token: good.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'driver_one');

    const anon = await call('GET', '/api/auth/me');
    assert.equal(anon.status, 401);
  });
});

test('tracks are public and unknown ids 404', async () => {
  await withServer(async ({ call }) => {
    const list = await call('GET', '/api/tracks');
    assert.equal(list.status, 200);
    assert.ok(list.body.tracks.length >= 3);

    const one = await call('GET', `/api/tracks/${TRACK}`);
    assert.equal(one.body.track.id, TRACK);

    const missing = await call('GET', '/api/tracks/nope');
    assert.equal(missing.status, 404);
  });
});

test('a valid replay is verified, ranked and becomes the ghost', async () => {
  await withServer(async ({ call }) => {
    const token = await signUp(call);
    const opened = await call('POST', '/api/races', { token, body: { trackId: TRACK } });
    assert.equal(opened.status, 201);

    const { inputs, car } = autopilot(getTrack(TRACK));
    const finish = await call('POST', `/api/races/${opened.body.race.id}/finish`, {
      token, body: { inputs },
    });

    assert.equal(finish.status, 200, JSON.stringify(finish.body));
    assert.equal(finish.body.personalBest, true);
    assert.equal(finish.body.rank, 1);
    assert.equal(finish.body.lapTimes.length, car.lapTimes.length);
    assert.ok(finish.body.timeMs > 0);

    const board = await call('GET', `/api/tracks/${TRACK}/leaderboard`);
    assert.equal(board.body.entries.length, 1);
    assert.equal(board.body.entries[0].time_ms, finish.body.timeMs);

    const ghost = await call('GET', `/api/tracks/${TRACK}/ghost`);
    assert.equal(ghost.body.ghost.username, 'driver_one');
    assert.deepEqual(ghost.body.ghost.inputs, inputs);
  });
});

test('a replay that never finishes the distance is rejected', async () => {
  await withServer(async ({ call }) => {
    const token = await signUp(call);
    const opened = await call('POST', '/api/races', { token, body: { trackId: TRACK } });

    // Full throttle in a straight line: into the barrier, never a lap.
    const res = await call('POST', `/api/races/${opened.body.race.id}/finish`, {
      token, body: { inputs: [[1, 600]] },
    });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /does not complete/);

    const board = await call('GET', `/api/tracks/${TRACK}/leaderboard`);
    assert.equal(board.body.entries.length, 0);
  });
});

test('a replay longer than the session it was opened for is rejected', async () => {
  await withServer(async ({ call, db }) => {
    const token = await signUp(call);
    const opened = await call('POST', '/api/races', { token, body: { trackId: TRACK } });
    // Pretend the session was opened one second ago; a 60s replay cannot fit.
    db.prepare('UPDATE races SET started_at = ? WHERE id = ?')
      .run(Date.now() - 1000, opened.body.race.id);

    const res = await call('POST', `/api/races/${opened.body.race.id}/finish`, {
      token, body: { inputs: [[1, 60 * 60]] },
    });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /longer than the session/);
  });
});

test('a race session can only be submitted once, and only by its owner', async () => {
  await withServer(async ({ call }) => {
    const mine = await signUp(call, 'driver_one');
    const theirs = await signUp(call, 'driver_two');
    const opened = await call('POST', '/api/races', { token: mine, body: { trackId: TRACK } });
    const { inputs } = autopilot(getTrack(TRACK));

    const stolen = await call('POST', `/api/races/${opened.body.race.id}/finish`, {
      token: theirs, body: { inputs },
    });
    assert.equal(stolen.status, 404);

    const first = await call('POST', `/api/races/${opened.body.race.id}/finish`, { token: mine, body: { inputs } });
    assert.equal(first.status, 200);

    const replayed = await call('POST', `/api/races/${opened.body.race.id}/finish`, { token: mine, body: { inputs } });
    assert.equal(replayed.status, 409);
  });
});

test('the leaderboard keeps one row per driver, their fastest', async () => {
  await withServer(async ({ call, db }) => {
    const token = await signUp(call);
    const { inputs } = autopilot(getTrack(TRACK));

    for (const [i, timeMs] of [9000, 7000, 8000].entries()) {
      const opened = await call('POST', '/api/races', { token, body: { trackId: TRACK } });
      const res = await call('POST', `/api/races/${opened.body.race.id}/finish`, { token, body: { inputs } });
      assert.equal(res.status, 200);
      // Force distinct stored times so the "best per driver" query is exercised.
      db.prepare('UPDATE races SET time_ms = ?, best_lap_ms = ? WHERE id = ?')
        .run(timeMs, timeMs / 2, opened.body.race.id);
      assert.ok(i >= 0);
    }

    const board = await call('GET', `/api/tracks/${TRACK}/leaderboard`);
    assert.equal(board.body.entries.length, 1);
    assert.equal(board.body.entries[0].time_ms, 7000);

    const mineList = await call('GET', '/api/races/mine', { token });
    assert.equal(mineList.body.races.length, 3);
  });
});

test('unauthenticated drivers cannot open a race', async () => {
  await withServer(async ({ call }) => {
    const res = await call('POST', '/api/races', { body: { trackId: TRACK } });
    assert.equal(res.status, 401);
  });
});

test('auth endpoints are rate limited', async () => {
  await withServer(async ({ call }) => {
    let limited = null;
    for (let i = 0; i < 45 && !limited; i++) {
      const res = await call('POST', '/api/auth/login', {
        body: { username: 'nobody', password: 'wrong-password' },
      });
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, 'expected repeated failed logins to hit the limiter');
    assert.match(limited.body.error, /too many requests/);
  });
});

test('unknown API routes answer with JSON, not the SPA', async () => {
  await withServer(async ({ call }) => {
    const res = await call('GET', '/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'unknown endpoint');
  });
});
