// Canvas renderer + input capture. The driving itself comes from the shared
// simulation, so what the player feels here is exactly what the server scores.

import { buildTrack } from '/shared/tracks.js';
import {
  INPUT, DT, PX_PER_METRE, createCar, step, simulate, encodeInputs, decodeInputs, ticksToMs,
} from '/shared/physics.js';

const FIXED_MS = DT * 1000;
const KEY_MAP = {
  ArrowUp: INPUT.THROTTLE, KeyW: INPUT.THROTTLE,
  ArrowDown: INPUT.REVERSE, KeyS: INPUT.REVERSE,
  ArrowLeft: INPUT.LEFT, KeyA: INPUT.LEFT,
  ArrowRight: INPUT.RIGHT, KeyD: INPUT.RIGHT,
  Space: INPUT.HANDBRAKE,
};

export function formatTime(ms) {
  if (ms == null) return '—';
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = ((total % 60000) / 1000).toFixed(3).padStart(6, '0');
  return minutes > 0 ? `${minutes}:${seconds}` : seconds;
}

export function formatDelta(ms) {
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(2)}`;
}

/**
 * Replay a ghost's run-length encoded trace up front so playback during the
 * race is a plain array lookup.
 */
function bakeGhost(track, rle) {
  const frames = [];
  const checkpointTicks = [];
  let seen = 1;
  simulate(track, decodeInputs(rle), {
    onTick: (car) => {
      frames.push({ x: car.x, y: car.y, angle: car.angle });
      if (car.nextCheckpoint !== seen) {
        checkpointTicks.push(car.tick);
        seen = car.nextCheckpoint;
      }
    },
  });
  return { frames, checkpointTicks };
}

export class Race {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} trackDef raw definition from /api/tracks/:id
   * @param {object} hooks {onFinish, onTelemetry, onCountdown, ghostInputs, ghostName}
   */
  constructor(canvas, trackDef, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.track = buildTrack(trackDef);
    this.hooks = hooks;
    this.peers = [];
    this.ghost = null;
    if (hooks.ghostInputs) {
      // A corrupt ghost is not worth losing the race over.
      try {
        this.ghost = bakeGhost(this.track, hooks.ghostInputs);
      } catch (err) {
        console.warn('ignoring unusable ghost replay', err);
      }
    }
    this.ghostName = hooks.ghostName || 'ghost';
    this.keys = new Set();
    this.marks = [];
    this.running = false;
    this.countdown = 3;

    this.onKeyDown = (e) => {
      if (KEY_MAP[e.code] !== undefined) {
        e.preventDefault();
        this.keys.add(e.code);
      }
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);
    this.onBlur = () => this.keys.clear();
    this.onResize = () => this.resize();
  }

  start() {
    this.car = createCar(this.track);
    this.inputs = [];
    this.marks = [];
    this.myCheckpointTicks = [];
    this.seenCheckpoint = 1;
    this.finished = false;
    this.running = true;
    this.countdown = 3;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('resize', this.onResize);
    this.resize();

    const tickCountdown = () => {
      if (!this.running) return;
      this.countdown -= 1;
      this.hooks.onCountdown?.(this.countdown > 0 ? String(this.countdown) : 'GO');
      if (this.countdown > -1) {
        this.countdownTimer = setTimeout(tickCountdown, 1000);
      } else {
        this.hooks.onCountdown?.(null);
      }
    };
    this.hooks.onCountdown?.('3');
    this.countdownTimer = setTimeout(tickCountdown, 1000);

    this.last = performance.now();
    this.acc = 0;
    this.frame = requestAnimationFrame(this.loop.bind(this));
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.countdownTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('resize', this.onResize);
  }

  setPeers(peers) { this.peers = peers; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
  }

  currentInput() {
    let mask = 0;
    for (const code of this.keys) mask |= KEY_MAP[code] || 0;
    return mask;
  }

  loop(now) {
    if (!this.running) return;
    this.acc += Math.min(now - this.last, 250);
    this.last = now;

    const racing = this.countdown <= 0 && !this.finished;
    while (this.acc >= FIXED_MS) {
      this.acc -= FIXED_MS;
      if (!racing) continue;
      const mask = this.currentInput();
      this.inputs.push(mask);
      const before = this.car.nextCheckpoint;
      step(this.car, mask, this.track);
      if (this.car.nextCheckpoint !== before) this.myCheckpointTicks.push(this.car.tick);
      this.recordSkid();
      if (this.car.finished) this.finish();
    }

    this.render();
    this.hooks.onTelemetry?.(this.telemetry());
    this.frame = requestAnimationFrame(this.loop.bind(this));
  }

  recordSkid() {
    const fx = Math.cos(this.car.angle);
    const fy = Math.sin(this.car.angle);
    const lateral = Math.abs(-this.car.vx * fy + this.car.vy * fx);
    if (lateral > 70 || this.car.offTrack) {
      this.marks.push({ x: this.car.x, y: this.car.y, a: this.car.angle, life: 1 });
      if (this.marks.length > 420) this.marks.shift();
    }
  }

  telemetry() {
    const t = {
      timeMs: ticksToMs(this.car.tick),
      lap: Math.min(this.car.lap + 1, this.track.laps),
      laps: this.track.laps,
      bestLapMs: this.car.lapTimes.length ? Math.min(...this.car.lapTimes) : null,
      speedKmh: Math.round((this.car.speed / PX_PER_METRE) * 3.6),
      offTrack: this.car.offTrack,
      ghostDeltaMs: null,
      ghostName: this.ghostName,
      car: this.car,
    };
    if (this.ghost && this.myCheckpointTicks.length) {
      const i = Math.min(this.myCheckpointTicks.length, this.ghost.checkpointTicks.length) - 1;
      if (i >= 0) {
        t.ghostDeltaMs = ticksToMs(this.myCheckpointTicks[i] - this.ghost.checkpointTicks[i]);
      }
    }
    return t;
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.render();
    this.hooks.onFinish?.({
      inputs: encodeInputs(this.inputs),
      timeMs: ticksToMs(this.car.finishTick),
      lapTimes: this.car.lapTimes.slice(),
    });
  }

  // ---------- rendering ----------

  render() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const scale = this.dpr * 0.95;
    const p = this.track.palette;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = p.grass;
    ctx.fillRect(0, 0, width, height);

    ctx.translate(width / 2, height / 2);
    ctx.scale(scale, scale);
    ctx.translate(-this.car.x, -this.car.y);

    this.drawTrack(ctx);
    this.drawMarks(ctx);
    if (this.ghost) this.drawGhost(ctx);
    for (const peer of this.peers) {
      this.drawCar(ctx, peer.x, peer.y, peer.angle, '#7c8cff', 0.55, peer.name);
    }
    this.drawCar(ctx, this.car.x, this.car.y, this.car.angle, '#ff5f4d', 1);
    this.drawMinimap();
  }

  tracePath(ctx) {
    const pts = this.track.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  drawTrack(ctx) {
    const p = this.track.palette;
    const w = this.track.halfWidth * 2;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    this.tracePath(ctx);
    ctx.strokeStyle = p.kerb;
    ctx.lineWidth = w + 16;
    ctx.stroke();

    this.tracePath(ctx);
    ctx.strokeStyle = p.road;
    ctx.lineWidth = w;
    ctx.stroke();

    this.tracePath(ctx);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 3;
    ctx.setLineDash([26, 26]);
    ctx.stroke();
    ctx.setLineDash([]);

    this.drawStartLine(ctx);
  }

  drawStartLine(ctx) {
    const { x, y, angle } = this.track.start;
    const half = this.track.halfWidth;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const cell = 12;
    for (let i = -half; i < half; i += cell) {
      for (let j = 0; j < 2; j++) {
        ctx.fillStyle = (Math.round(i / cell) + j) % 2 === 0 ? '#f4f6ff' : '#1b2033';
        ctx.fillRect(j * cell - cell, i, cell, cell);
      }
    }
    ctx.restore();
  }

  drawMarks(ctx) {
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (const m of this.marks) {
      const dx = Math.cos(m.a) * 9;
      const dy = Math.sin(m.a) * 9;
      ctx.moveTo(m.x - dx, m.y - dy);
      ctx.lineTo(m.x + dx, m.y + dy);
    }
    ctx.stroke();
  }

  drawGhost(ctx) {
    const frames = this.ghost.frames;
    if (!frames.length) return;
    const f = frames[Math.min(Math.max(this.car.tick - 1, 0), frames.length - 1)];
    this.drawCar(ctx, f.x, f.y, f.angle, '#4dd0ff', 0.4, this.ghostName);
  }

  drawCar(ctx, x, y, angle, color, alpha = 1, label = null) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-17, -10, 36, 20);

    ctx.fillStyle = '#10131f';
    ctx.fillRect(-14, -12, 9, 5);
    ctx.fillRect(-14, 7, 9, 5);
    ctx.fillRect(8, -12, 9, 5);
    ctx.fillRect(8, 7, 9, 5);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-18, -9);
    ctx.lineTo(12, -9);
    ctx.lineTo(19, 0);
    ctx.lineTo(12, 9);
    ctx.lineTo(-18, 9);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(10,15,28,0.85)';
    ctx.fillRect(-4, -6, 9, 12);
    ctx.restore();

    if (label) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha + 0.3);
      ctx.fillStyle = '#cbd5f5';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - 24);
      ctx.restore();
    }
  }

  drawMinimap() {
    const ctx = this.ctx;
    const size = 150 * this.dpr;
    const pad = 16 * this.dpr;
    const b = this.track.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const s = (size - 20 * this.dpr) / Math.max(w, h);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const ox = this.canvas.width - size - pad;
    const oy = pad;

    ctx.fillStyle = 'rgba(10,13,24,0.8)';
    ctx.strokeStyle = '#2a3350';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(ox, oy, size, size, 10 * this.dpr);
    ctx.fill();
    ctx.stroke();

    const map = (p) => [
      ox + size / 2 + (p.x - (b.minX + w / 2)) * s,
      oy + size / 2 + (p.y - (b.minY + h / 2)) * s,
    ];

    const pts = this.track.points;
    ctx.beginPath();
    let [mx, my] = map(pts[0]);
    ctx.moveTo(mx, my);
    for (let i = 1; i < pts.length; i++) {
      [mx, my] = map(pts[i]);
      ctx.lineTo(mx, my);
    }
    ctx.closePath();
    ctx.strokeStyle = '#4b5578';
    ctx.lineWidth = Math.max(2, this.track.halfWidth * s * 0.9);
    ctx.stroke();

    const dot = (p, color, r = 3.5) => {
      const [px, py] = map(p);
      ctx.beginPath();
      ctx.arc(px, py, r * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    for (const peer of this.peers) dot(peer, '#7c8cff', 2.6);
    if (this.ghost) {
      const f = this.ghost.frames[Math.min(this.car.tick, this.ghost.frames.length - 1)];
      if (f) dot(f, '#4dd0ff', 2.6);
    }
    dot(this.car, '#ff5f4d');
  }
}

/** Static preview used on the track-select cards. */
export function drawTrackThumb(canvas, trackDef) {
  const track = buildTrack(trackDef);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 160;
  const h = canvas.clientHeight || 110;
  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext('2d');
  const b = track.bounds;
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const s = Math.min((w - 18) / bw, (h - 18) / bh) * dpr;

  ctx.fillStyle = track.palette.grass;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(s, s);
  ctx.translate(-(b.minX + bw / 2), -(b.minY + bh / 2));

  const pts = track.points;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  trace();
  ctx.strokeStyle = track.palette.kerb;
  ctx.lineWidth = track.halfWidth * 2 + 14;
  ctx.stroke();
  trace();
  ctx.strokeStyle = track.palette.road;
  ctx.lineWidth = track.halfWidth * 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(track.start.x, track.start.y, track.halfWidth * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = '#f4f6ff';
  ctx.fill();
}
