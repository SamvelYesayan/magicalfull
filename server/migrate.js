// Applies pending PostgreSQL migrations (server/migrations-postgres/*.sql). Safe to run repeatedly and concurrently.
import { loadEnvFile, loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

loadEnvFile();
let pool, code = 0;
try {
  const cfg = loadConfig({ ...process.env, APP_SECRET: process.env.APP_SECRET || 'x'.repeat(32) });
  pool = createPool(cfg);
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (e) {
  console.error(`Migration failed: ${e.code ? `[${e.code}] ` : ''}${e.message}`);
  code = 1;
} finally { if (pool) await pool.end(); }
process.exit(code);
