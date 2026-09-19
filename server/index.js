import http from 'node:http';
import { createApp } from './app.js';
import { attachRealtime } from './realtime.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const app = createApp();
const server = http.createServer(app);
const realtime = attachRealtime(server, { secret: app.get('jwtSecret') });

server.listen(port, host, () => {
  console.log(`Apex Drift running on http://localhost:${port}`);
});

const shutdown = async (signal) => {
  console.log(`\n${signal} received, shutting down`);
  await realtime.close();
  server.close(() => {
    app.get('db').close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
