// Serverless entry point for Vercel.
//
// Vercel routes every /api/* request here, so the Express app sees the original
// path and its own routers do the rest. The standalone server in server/index.js
// is still the way to run this app anywhere that allows a long-lived process —
// it is the only one that can host the presence WebSocket.

import { createApp } from '../server/app.js';

export default createApp();
