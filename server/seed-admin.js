// Creates the initial administrator from environment variables (never from source code).
//   ADMIN_USERNAME=... ADMIN_PASSWORD='...' npm run seed:admin
//   add --reset to overwrite the password of an existing admin
import { loadEnvFile, loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { ensureAdmin } from './app.js';

loadEnvFile();
const username = (process.env.ADMIN_USERNAME || '').trim();
const password = process.env.ADMIN_PASSWORD || '';
if (!username || password.length < 8) {
  console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD (at least 8 characters) in the environment or .env, then run again.');
  process.exit(1);
}
let pool, code = 0;
try {
  const cfg = loadConfig({ ...process.env, APP_SECRET: process.env.APP_SECRET || 'x'.repeat(32) });
  pool = createPool(cfg);
  await migrate(pool);
  const result = await ensureAdmin(pool, username, password, { reset: process.argv.includes('--reset') });
  console.log({ created: `Administrator "${username}" created.`, reset: `Password for "${username}" reset; existing sessions revoked.`, exists: `Administrator "${username}" already exists (use --reset to change the password).` }[result]);
} catch (e) {
  console.error(`Seeding failed: ${e.code ? `[${e.code}] ` : ''}${e.message}`);
  code = 1;
} finally { if (pool) await pool.end(); }
process.exit(code);
