import { api, session, ApiError } from './api.js';
import { Race, drawTrackThumb, formatTime, formatDelta } from './game.js';
import { PX_PER_METRE } from '/shared/physics.js';
import { Presence } from './net.js';

const $ = (sel) => document.querySelector(sel);
const screens = {
  auth: $('#screen-auth'),
  garage: $('#screen-garage'),
  race: $('#screen-race'),
};

const state = {
  user: null,
  tracks: [],
  selected: null,
  race: null,
  raceSession: null,
  presence: null,
  trackDefs: new Map(),
};

// Handy from the browser console (and for end-to-end tests) — read-only view of
// what the client is currently doing.
window.apexDrift = state;

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.classList.toggle('active', key === name);
}

let toastTimer;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------- auth ----------

let authMode = 'login';

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#auth-form button.primary').textContent =
      authMode === 'login' ? 'Enter the paddock' : 'Create driver';
  });
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const username = String(form.get('username')).trim();
  const password = String(form.get('password'));
  const error = $('#auth-error');
  error.hidden = true;

  try {
    const result = authMode === 'login'
      ? await api.login(username, password)
      : await api.register(username, password);
    session.token = result.token;
    state.user = result.user;
    await enterGarage();
  } catch (err) {
    error.textContent = err instanceof ApiError ? err.message : 'could not reach the server';
    error.hidden = false;
  }
});

$('#logout').addEventListener('click', () => {
  session.token = null;
  state.user = null;
  show('auth');
});

// ---------- garage ----------

async function enterGarage() {
  $('#driver-name').textContent = state.user.username;
  show('garage');
  const { tracks } = await api.tracks();
  state.tracks = tracks;
  renderTracks();
  await selectTrack(state.selected?.id || tracks[0].id);
  refreshRecent();
}

function renderTracks() {
  const list = $('#track-list');
  list.replaceChildren();

  for (const track of state.tracks) {
    const card = document.createElement('article');
    card.className = 'track-card';
    card.dataset.id = track.id;
    card.innerHTML = `
      <canvas></canvas>
      <div>
        <h3></h3>
        <p></p>
        <div class="meta"></div>
      </div>
      <button class="primary">Race</button>
    `;
    card.querySelector('h3').textContent = track.name;
    card.querySelector('p').textContent = track.description;
    card.querySelector('.meta').textContent =
      `${track.laps} laps · ${Math.round(track.lengthPx / PX_PER_METRE)} m per lap`;

    card.addEventListener('click', () => selectTrack(track.id));
    card.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      startRace(track.id);
    });
    list.append(card);

    loadTrackDef(track.id).then((def) => drawTrackThumb(card.querySelector('canvas'), def));
  }
}

async function loadTrackDef(id) {
  if (state.trackDefs.has(id)) return state.trackDefs.get(id);
  const { track } = await api.track(id);
  state.trackDefs.set(id, track);
  return track;
}

async function selectTrack(id) {
  state.selected = state.tracks.find((t) => t.id === id) || null;
  if (!state.selected) return;
  document.querySelectorAll('.track-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.id === id);
  });
  $('#lb-track').textContent = state.selected.name;
  await refreshLeaderboard(id);
}

async function refreshLeaderboard(id) {
  const list = $('#leaderboard');
  list.replaceChildren();
  const { entries } = await api.leaderboard(id);
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No verified times yet. Go set one.';
    list.append(li);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement('li');
    li.classList.toggle('you', entry.username === state.user?.username);
    const name = document.createElement('span');
    name.textContent = entry.username;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(entry.time_ms);
    li.append(name, time);
    list.append(li);
  }
}

async function refreshRecent() {
  const list = $('#recent');
  list.replaceChildren();
  const { races } = await api.myRaces();
  if (!races.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing on the sheet yet.';
    list.append(li);
    return;
  }
  const byId = new Map(state.tracks.map((t) => [t.id, t.name]));
  for (const race of races.slice(0, 8)) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = byId.get(race.track_id) || race.track_id;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(race.time_ms);
    li.append(name, time);
    list.append(li);
  }
}

// ---------- racing ----------

// Opening a race takes a round trip. Without this guard a double-click would
// open two server sessions and leave the live race and the session it submits
// against out of step, depending on which response landed last.
let startInFlight = false;

async function startRace(trackId) {
  if (startInFlight) return;
  startInFlight = true;
  try {
    const [def, opened, ghostRes] = await Promise.all([
      loadTrackDef(trackId),
      api.startRace(trackId),
      api.ghost(trackId).catch(() => ({ ghost: null })),
    ]);
    state.raceSession = opened.race;
    show('race');
    $('#results').hidden = true;

    const ghost = ghostRes.ghost;
    $('#hud-ghost-block').hidden = !ghost;
    if (ghost) $('#hud-ghost-name').textContent = ghost.username;

    state.race?.destroy();
    state.race = new Race($('#stage'), def, {
      ghostInputs: ghost?.inputs,
      ghostName: ghost?.username,
      onCountdown: renderCountdown,
      onTelemetry: renderHud,
      onFinish: submitRun,
    });
    state.race.start();

    state.presence?.close();
    state.presence = new Presence(session.token);
    state.presence.connect(trackId, () => {
      const car = state.race?.car;
      if (!car) return null;
      return {
        x: car.x, y: car.y, angle: car.angle, lap: car.lap, speed: car.speed,
      };
    });
    pumpPeers();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'could not start the race', true);
    if (err instanceof ApiError && err.status === 401) show('auth');
  } finally {
    startInFlight = false;
  }
}

let peerTimer;
function pumpPeers() {
  clearInterval(peerTimer);
  peerTimer = setInterval(() => {
    if (!state.race || !state.presence) return;
    const peers = state.presence.peers;
    state.race.setPeers(peers);
    $('#peer-list').replaceChildren(
      ...peers.map((p) => {
        const span = document.createElement('span');
        span.textContent = `${p.name} · lap ${p.lap + 1}`;
        return span;
      }),
    );
  }, 200);
}

function renderCountdown(value) {
  const el = $('#countdown');
  el.hidden = value === null;
  if (value !== null) el.textContent = value;
}

function renderHud(t) {
  $('#hud-time').textContent = formatTime(t.timeMs);
  $('#hud-lap').textContent = `${t.lap}/${t.laps}`;
  $('#hud-best').textContent = formatTime(t.bestLapMs);
  $('#hud-speed').textContent = t.speedKmh;
  const ghost = $('#hud-ghost');
  if (t.ghostDeltaMs === null) {
    ghost.textContent = '—';
    ghost.className = '';
  } else {
    ghost.textContent = formatDelta(t.ghostDeltaMs);
    ghost.className = t.ghostDeltaMs <= 0 ? 'ahead' : 'behind';
  }
}

async function submitRun({ inputs, timeMs, lapTimes }) {
  state.presence?.close();
  clearInterval(peerTimer);

  const panel = $('#results');
  const title = $('#results-title');
  const note = $('#results-note');
  $('#results-time').textContent = formatTime(timeMs);

  const best = Math.min(...lapTimes);
  $('#results-laps').replaceChildren(
    ...lapTimes.map((ms, i) => {
      const li = document.createElement('li');
      li.classList.toggle('best', ms === best);
      const label = document.createElement('span');
      label.textContent = `Lap ${i + 1}`;
      const time = document.createElement('span');
      time.textContent = formatTime(ms);
      li.append(label, time);
      return li;
    }),
  );

  title.textContent = 'Verifying…';
  note.textContent = 'Re-running your inputs on the server.';
  panel.hidden = false;

  try {
    const result = await api.finishRace(state.raceSession.id, inputs);
    title.textContent = result.personalBest ? 'Personal best!' : 'Race complete';
    $('#results-time').textContent = formatTime(result.timeMs);
    const parts = [`P${result.rank} on this circuit`];
    if (!result.personalBest && result.previousBestMs != null) {
      parts.push(`your best is ${formatTime(result.previousBestMs)}`);
    }
    note.textContent = `${parts.join(' · ')} · verified by the server`;
  } catch (err) {
    title.textContent = 'Not counted';
    note.textContent = err instanceof ApiError ? err.message : 'could not reach the server';
  }
}

function leaveRace() {
  state.race?.destroy();
  state.race = null;
  state.presence?.close();
  clearInterval(peerTimer);
  $('#peer-list').replaceChildren();
  renderCountdown(null);
}

$('#quit').addEventListener('click', async () => {
  leaveRace();
  await enterGarage();
});

$('#restart').addEventListener('click', () => {
  const trackId = state.raceSession?.trackId;
  leaveRace();
  if (trackId) startRace(trackId);
});

$('#results-again').addEventListener('click', () => {
  const trackId = state.raceSession?.trackId;
  leaveRace();
  if (trackId) startRace(trackId);
});

$('#results-back').addEventListener('click', async () => {
  leaveRace();
  await enterGarage();
});

window.addEventListener('keydown', (event) => {
  if (!screens.race.classList.contains('active')) return;
  if (event.code === 'Escape') $('#quit').click();
  else if (event.code === 'KeyR') $('#restart').click();
});

// ---------- boot ----------

(async function boot() {
  if (!session.token) { show('auth'); return; }
  try {
    const { user } = await api.me();
    state.user = user;
    await enterGarage();
  } catch {
    session.token = null;
    show('auth');
  }
})();
