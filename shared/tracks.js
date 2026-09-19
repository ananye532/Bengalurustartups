// Track data shared verbatim by the browser client and the Node server.
// The server re-simulates submitted replays against these exact definitions,
// so this file must stay free of environment-specific code.

/** Raw, hand-authored circuits. `control` points are smoothed into a closed loop. */
export const TRACK_DEFS = [
  {
    id: 'sunset-loop',
    name: 'Sunset Loop',
    description: 'Wide, flowing and forgiving. The place to learn where the grip ends.',
    laps: 2,
    halfWidth: 64,
    resolution: 14,
    checkpoints: 12,
    palette: { grass: '#2a1636', road: '#43414f', kerb: '#ff7043', line: '#f7e3b0' },
    // Index 0 is the start/finish line, so the loop is authored to begin
    // part-way down the main straight.
    control: [
      [820, 860], [560, 840], [300, 760], [180, 520], [260, 280],
      [520, 180], [820, 200], [1080, 300], [1240, 520], [1120, 760],
    ],
  },
  {
    id: 'harbor-sprint',
    name: 'Harbor Sprint',
    description: 'Tight chicane on the entry, long right-hander onto the straight.',
    laps: 3,
    halfWidth: 52,
    resolution: 14,
    checkpoints: 14,
    palette: { grass: '#10283a', road: '#3d444c', kerb: '#38bdf8', line: '#e2e8f0' },
    control: [
      [1040, 820], [700, 880], [460, 880], [260, 820], [180, 540],
      [300, 300], [560, 240], [700, 430], [860, 240], [1120, 300],
      [1220, 580],
    ],
  },
  {
    id: 'night-circuit',
    name: 'Night Circuit',
    description: 'The long one. Two technical sectors and almost no run-off.',
    laps: 2,
    halfWidth: 56,
    resolution: 14,
    checkpoints: 16,
    palette: { grass: '#101322', road: '#3a3d4d', kerb: '#a78bfa', line: '#cbd5f5' },
    control: [
      [1120, 840], [820, 900], [560, 900], [320, 860], [180, 620],
      [220, 360], [420, 220], [680, 260], [830, 450], [980, 290],
      [1240, 360], [1300, 620],
    ],
  },
];

const cubic = (p0, p1, p2, p3, t) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
};

/**
 * Expand a definition into the geometry both the renderer and the simulation use:
 * a resampled closed centerline, per-segment vectors and ordered checkpoints.
 */
export function buildTrack(def) {
  const n = def.control.length;
  const points = [];
  for (let i = 0; i < n; i++) {
    const p0 = def.control[(i - 1 + n) % n];
    const p1 = def.control[i];
    const p2 = def.control[(i + 1) % n];
    const p3 = def.control[(i + 2) % n];
    for (let s = 0; s < def.resolution; s++) {
      const t = s / def.resolution;
      points.push({
        x: cubic(p0[0], p1[0], p2[0], p3[0], t),
        y: cubic(p0[1], p1[1], p2[1], p3[1], t),
      });
    }
  }

  const segments = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const length = Math.sqrt(len2);
    segments.push({ x: a.x, y: a.y, dx, dy, len2, length, start: total });
    total += length;
  }

  const count = Math.min(def.checkpoints, points.length);
  const checkpoints = [];
  for (let k = 0; k < count; k++) {
    const i = Math.round((k * points.length) / count) % points.length;
    const a = points[i];
    const b = points[(i + 1) % points.length];
    checkpoints.push({ x: a.x, y: a.y, angle: Math.atan2(b.y - a.y, b.x - a.x), index: i });
  }

  const start = points[0];
  const next = points[1];
  const startAngle = Math.atan2(next.y - start.y, next.x - start.x);

  const bounds = points.reduce(
    (acc, p) => ({
      minX: Math.min(acc.minX, p.x), minY: Math.min(acc.minY, p.y),
      maxX: Math.max(acc.maxX, p.x), maxY: Math.max(acc.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    laps: def.laps,
    halfWidth: def.halfWidth,
    palette: def.palette,
    points,
    segments,
    checkpoints,
    length: total,
    start: { x: start.x, y: start.y, angle: startAngle },
    bounds,
  };
}

const cache = new Map();

/** Build (and memoize) a track by id. Returns null for unknown ids. */
export function getTrack(id) {
  if (cache.has(id)) return cache.get(id);
  const def = TRACK_DEFS.find((t) => t.id === id);
  if (!def) return null;
  const track = buildTrack(def);
  cache.set(id, track);
  return track;
}

/** Lightweight listing for the track-select screen. */
export function listTracks() {
  return TRACK_DEFS.map((def) => {
    const track = getTrack(def.id);
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      laps: def.laps,
      halfWidth: def.halfWidth,
      lengthPx: Math.round(track.length),
      palette: def.palette,
    };
  });
}
