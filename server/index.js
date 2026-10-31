import { loadEnvFile, loadConfig } from './config.js';
import { createApp } from './app.js';

// `npm start` passes --production so it works the same on Windows PowerShell and Linux.
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';

loadEnvFile();
let app;
try {
  const config = loadConfig();
  // createApp connects to PostgreSQL and applies pending migrations BEFORE we start listening.
  app = await createApp(config);
  if (config.ephemeralSecret) console.warn('[warn] APP_SECRET is not set: using a temporary secret (fine for development only).');
  await new Promise((ok, fail) => { app.server.once('error', fail); app.server.listen(config.port, config.host, ok); });
  console.log(`Magical server listening on http://${config.host}:${config.port} (${config.prod ? 'production' : 'development'}), database "${config.db.database}"`);
} catch (e) {
  console.error(`Startup failed: ${e.code ? `[${e.code}] ` : ''}${e.message}`); // message never contains the password
  if (app) await app.close().catch(() => {});
  process.exit(1);
}
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; try { await app.close(); } finally { process.exit(0); } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
