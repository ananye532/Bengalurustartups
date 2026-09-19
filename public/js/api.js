// Thin fetch wrapper: attaches the bearer token and unwraps API errors.

const TOKEN_KEY = 'apex-drift.token';

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(value) {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  if (res.status !== 204) {
    try { payload = await res.json(); } catch { payload = null; }
  }
  if (!res.ok) throw new ApiError(payload?.error || `request failed (${res.status})`, res.status);
  return payload;
}

export const api = {
  register: (username, password) => request('POST', '/api/auth/register', { username, password }),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  me: () => request('GET', '/api/auth/me'),
  tracks: () => request('GET', '/api/tracks'),
  track: (id) => request('GET', `/api/tracks/${id}`),
  leaderboard: (id) => request('GET', `/api/tracks/${id}/leaderboard`),
  ghost: (id) => request('GET', `/api/tracks/${id}/ghost`),
  startRace: (trackId) => request('POST', '/api/races', { trackId }),
  finishRace: (raceId, inputs) => request('POST', `/api/races/${raceId}/finish`, { inputs }),
  myRaces: () => request('GET', '/api/races/mine'),
};
