import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACK_DEFS, getTrack, listTracks } from '../shared/tracks.js';

test('track ids are unique', () => {
  const ids = TRACK_DEFS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every circuit closes into a loop with ordered checkpoints', () => {
  for (const def of TRACK_DEFS) {
    const track = getTrack(def.id);
    assert.equal(track.points.length, def.control.length * def.resolution);
    assert.equal(track.checkpoints.length, def.checkpoints);
    assert.ok(track.length > 1000, `${def.id} is suspiciously short`);

    const indices = track.checkpoints.map((c) => c.index);
    const sorted = [...indices].sort((a, b) => a - b);
    assert.deepEqual(indices, sorted, `${def.id} checkpoints are out of order`);
    assert.equal(track.checkpoints[0].index, 0, 'checkpoint 0 must sit on the start line');
  }
});

test('no circuit overlaps itself', () => {
  for (const def of TRACK_DEFS) {
    const track = getTrack(def.id);
    const { points, segments, length } = track;
    const corridor = def.halfWidth * 2;
    let worst = Infinity;

    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        // Points close together along the ribbon are the same corner, not an
        // overlap, so only compare parts of the track that are far apart.
        const along = Math.abs(segments[j].start - segments[i].start);
        if (Math.min(along, length - along) < def.halfWidth * 4) continue;
        worst = Math.min(worst, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
      }
    }
    assert.ok(worst > corridor, `${def.id} crosses itself (gap ${worst.toFixed(1)}px)`);
  }
});

test('listTracks exposes what the select screen needs', () => {
  for (const entry of listTracks()) {
    assert.ok(entry.id && entry.name && entry.description);
    assert.ok(entry.laps >= 1);
    assert.ok(entry.lengthPx > 0);
    assert.ok(entry.palette.road);
  }
});

test('unknown tracks resolve to null rather than throwing', () => {
  assert.equal(getTrack('does-not-exist'), null);
});
