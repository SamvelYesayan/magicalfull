import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations-postgres');
const MIGRATION_LOCK = 7_461_902_511; // arbitrary constant: serialises migrations across processes

// timestamptz -> ISO-8601 UTC string, the same format the API has always returned.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());

/** Creates the shared connection pool. Connections are opened lazily on first use. */
export function createPool(config) {
  const pool = new pg.Pool(config.db);
  pool.on('error', (e) => console.error('[db] idle client error:', e.code || e.message)); // never crash on a dropped idle connection
  return pool;
}

/** Runs fn(client) inside BEGIN/COMMIT on ONE dedicated client; rolls back and rethrows on any error. */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw e;
  } finally { client.release(); }
}

/**
 * Applies pending *.sql files from server/migrations-postgres in name order.
 * Each file runs in its own transaction together with its schema_migrations row, so a version is
 * recorded only if its SQL succeeded. A session-level advisory lock makes concurrent startups safe.
 */
export async function migrate(pool, dir = MIGRATIONS) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
      const applied = [];
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
        if (done.has(f)) continue;
        try {
          await client.query('BEGIN');
          await client.query(readFileSync(resolve(dir, f), 'utf8'));
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
          await client.query('COMMIT');
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch { /* ignore */ }
          e.message = `Migration ${f} failed: ${e.message}`;
          throw e;
        }
        applied.push(f);
      }
      return applied;
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); } catch { /* lock is released when the session ends anyway */ }
    }
  } finally { client.release(); }
}

/** Names of *.sql files not yet recorded in schema_migrations (all of them on an empty database). Read-only. */
export async function pendingMigrations(pool, dir = MIGRATIONS) {
  const has = (await pool.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS t")).rows[0].t;
  const done = has ? new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)) : new Set();
  return readdirSync(dir).filter((x) => x.endsWith('.sql')).sort().filter((f) => !done.has(f));
}

/** True for a PostgreSQL unique violation (23505), optionally on a constraint whose name contains `part`. */
export const isUnique = (e, part) => e?.code === '23505' && (!part || String(e.constraint || '').includes(part));
export const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
