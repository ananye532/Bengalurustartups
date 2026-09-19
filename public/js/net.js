// Presence socket: publishes our car position and receives everyone else's.

const SEND_HZ = 15;

export class Presence {
  constructor(token) {
    this.token = token;
    this.socket = null;
    this.trackId = null;
    this.peers = [];
    this.timer = null;
    this.getState = null;
  }

  connect(trackId, getState) {
    this.close();
    this.trackId = trackId;
    this.getState = getState;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(this.token || '')}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', trackId }));
      this.timer = setInterval(() => this.publish(), 1000 / SEND_HZ);
    });
    socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'peers') this.peers = msg.peers;
      } catch { /* ignore malformed frames */ }
    });
    socket.addEventListener('close', () => {
      clearInterval(this.timer);
      this.peers = [];
    });
    // A dropped presence socket never affects the race itself.
    socket.addEventListener('error', () => {});
  }

  publish() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const state = this.getState?.();
    if (!state) return;
    this.socket.send(JSON.stringify({ type: 'state', ...state }));
  }

  close() {
    clearInterval(this.timer);
    this.peers = [];
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close();
    this.socket = null;
  }
}
