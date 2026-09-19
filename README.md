# Apex Drift

A full-stack top-down racing game. Accounts, three circuits, lap timing, ghost
cars, leaderboards and live presence — with every lap time re-simulated on the
server before it is allowed onto the board.

No build step, no frontend framework: the browser loads ES modules directly, and
the client and the server import the *same* physics file.

```
shared/     deterministic simulation + track geometry (runs in both places)
server/     Express API, SQLite storage, replay verification, WebSocket presence
public/     canvas renderer, input capture, UI
tests/      node:test suite (physics, geometry, HTTP API)
```

## Quick start

```bash
npm install
npm start           # http://localhost:3000
npm test            # 28 tests
npm run dev         # same, with --watch
```

Create a driver on the first screen, pick a circuit, race. Configuration is in
`.env.example`; `JWT_SECRET` is required when `NODE_ENV=production`.

## Controls

| Action | Keys |
| --- | --- |
| Throttle | `W` / `↑` |
| Brake, then reverse | `S` / `↓` |
| Steer | `A` `D` / `←` `→` |
| Handbrake (kills lateral grip — use it to rotate the car) | `Space` |
| Restart / back to garage | `R` / `Esc` |

Running off the tarmac costs grip and caps your speed; the barrier past the kerb
scrubs most of your momentum. Checkpoints must be taken in order, so cutting the
course does nothing.

## How a lap time is decided

The client never reports a time. It records the input bitmask for every one of
the 60 simulated ticks per second, run-length encodes it, and posts it:

1. `POST /api/races` opens a server-side session (id + `started_at`).
2. You drive. `public/js/game.js` steps `shared/physics.js` on a fixed timestep
   and stores one mask per tick.
3. `POST /api/races/:id/finish` sends the trace.
4. `server/verify.js` re-runs that trace through the identical simulation. The
   time it produces is the time that gets stored.

Consequences worth knowing:

- A doctored time is pointless — the number in the request is ignored.
- A trace that never completes the required laps is rejected (`422`).
- A trace longer than the session has existed for is rejected, so you cannot
  submit a leisurely ten-minute run as a hot lap.
- A session is single-use and expires after an hour.

**The honest caveat:** determinism relies on both sides evaluating the same
floating-point arithmetic. `Math.cos`/`Math.sin` are not guaranteed to be
bit-identical across JavaScript engines, so a browser whose trig differs from
the server's V8 in the last bit could, in principle, diverge over a few thousand
ticks and have an honest run rejected. Checkpoint radii are generous to absorb
small drift, and in testing (Chromium client, Node server) client and server
agree exactly, but this is a real limitation of the approach rather than
something the code papers over. The fallback is a clear "replay does not
complete the race distance" error rather than a wrong time.

Live positions on the WebSocket are cosmetic — presence only. Nothing arriving
over that socket can influence a leaderboard entry.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | — | Create a driver, returns a JWT |
| `POST` | `/api/auth/login` | — | Exchange credentials for a JWT |
| `GET` | `/api/auth/me` | ✓ | Current driver + career stats |
| `GET` | `/api/tracks` | — | Circuit list for the select screen |
| `GET` | `/api/tracks/:id` | — | Full definition (control points, palette) |
| `GET` | `/api/tracks/:id/leaderboard` | — | Best verified time per driver |
| `GET` | `/api/tracks/:id/ghost` | — | Record holder's input trace |
| `POST` | `/api/races` | ✓ | Open a race session |
| `POST` | `/api/races/:id/finish` | ✓ | Submit a replay for verification |
| `GET` | `/api/races/mine` | ✓ | Your recent verified runs |
| `GET` | `/api/races/:id/replay` | — | A specific verified replay |
| `GET` | `/api/health` | — | Liveness |

Tokens go in `Authorization: Bearer <token>`. Passwords are bcrypt hashed.
`/api/auth/*` and `/api/races/*` are rate limited per IP (in-process, so a
multi-instance deployment needs a shared store instead).

## Adding a circuit

Append an entry to `TRACK_DEFS` in `shared/tracks.js`. The `control` points are
smoothed into a closed Catmull-Rom loop, checkpoints are spaced evenly around it
and index 0 becomes the start/finish line — so author the loop to *begin*
part-way down a straight. `tests/tracks.test.js` will fail the build if the
resulting ribbon overlaps itself.

## Tests

`npm test` covers the simulation (determinism, braking, checkpoint ordering,
encode/decode edge cases), track geometry (every circuit is completable and does
not cross itself), the HTTP API end to end against an in-memory database (auth,
validation, verification rejections, session reuse, leaderboard shape, rate
limiting), and the presence socket with two live clients (room isolation,
leaving, malformed frames).

The canvas layer is not covered by the automated suite. It was exercised
manually with a headless browser: register → race a full distance with real
keyboard input → server verification → leaderboard.

## Known limitations

- Single-process SQLite; fine for a handful of drivers, not for scale.
- No email, password reset or account deletion.
- Presence shows other cars but there is no true synchronous racing — no
  collisions between players, and no server-side authority over live positions.
- Mobile is unsupported: keyboard only.
