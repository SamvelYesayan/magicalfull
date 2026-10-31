import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, migrate, withTransaction, isUnique } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { start, verifyTestDatabase } from './helpers.js';

const PIONEER = ['pioneer_announcements', 'pioneer_audit_log', 'pioneer_cards', 'pioneer_login_guard', 'pioneer_redemptions', 'pioneer_rewards', 'pioneer_sessions', 'pioneer_settings', 'pioneer_transactions', 'pioneer_transfers'];
const ALL = `admin_sessions, admins, contact_messages, registrations, events, schema_migrations, mig_t1, mig_t2, ${PIONEER.join(', ')}`;
async function pool() {
  const url = await verifyTestDatabase(); // refuses anything that is not the dedicated *_test database
  return createPool(loadConfig({ NODE_ENV: 'test', APP_SECRET: 's'.repeat(40), DATABASE_URL: url }));
}
const tables = async (p) => (await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1")).rows.map((r) => r.table_name);

test('migrations apply to an empty database, are idempotent, and safe when started concurrently', async () => {
  const p = await pool();
  try {
    await p.query(`DROP TABLE IF EXISTS ${ALL} CASCADE`);
    assert.deepEqual(await tables(p), []);
    const results = await Promise.all([migrate(p), migrate(p), migrate(p), migrate(p)]); // simultaneous "startups"
    assert.equal(results.filter((r) => r.length).length, 1, 'exactly one process applies the migration');
    assert.deepEqual(await tables(p), ['admin_sessions', 'admins', 'contact_messages', 'events', ...PIONEER, 'registrations', 'schema_migrations']);
    assert.deepEqual((await p.query('SELECT version FROM schema_migrations ORDER BY 1')).rows.map((r) => r.version), ['001_init.sql', '002_pioneer.sql', '003_pioneer_gift_card.sql', '004_pioneer_cvv_escrow.sql']);
    assert.deepEqual(await migrate(p), []);
    // constraints really exist
    await p.query("INSERT INTO events (slug, title) VALUES ('e', 't')");
    await assert.rejects(p.query("INSERT INTO events (slug, title) VALUES ('e', 't2')"), (e) => isUnique(e, 'events_slug'));
    await assert.rejects(p.query("INSERT INTO registrations (event_id, invitation_no, access_token_hash, dedupe_key, first_name, last_name, age, phone, search_text) VALUES (1, 'X', 'h', 'd', 'Aa', 'Bb', 0, '+37477123456', 'x')"), (e) => e.code === '23514');
    await p.query("INSERT INTO admins (username, password_hash) VALUES ('Magical', 'x')");
    await assert.rejects(p.query("INSERT INTO admins (username, password_hash) VALUES ('MAGICAL', 'x')"), (e) => isUnique(e));
  } finally { await p.end(); }
});

test('a failing migration is rolled back and its version is NOT recorded', async () => {
  const p = await pool();
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE mig_t1 (id int);');
  writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE mig_t2 (id int); SELECT no_such_function_xyz();');
  try {
    await p.query(`DROP TABLE IF EXISTS ${ALL} CASCADE`);
    await assert.rejects(migrate(p, dir), /Migration 002_bad\.sql failed/);
    assert.deepEqual((await p.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version), ['001_ok.sql']);
    assert.deepEqual(await tables(p), ['mig_t1', 'schema_migrations'], 'mig_t2 must have been rolled back');
    await assert.rejects(migrate(p, dir), /Migration 002_bad\.sql failed/, 'still failing, not silently skipped');
  } finally { await p.query(`DROP TABLE IF EXISTS ${ALL} CASCADE`); await migrate(p); await p.end(); }
});

test('transactions use one dedicated client, commit together and roll back together', async () => {
  const s = await start();
  const ins = (c, n) => c.query("INSERT INTO contact_messages (name, email, search_text) VALUES ($1, 'a@b.co', 'x')", [n]);
  const cnt = async () => (await s.q('SELECT COUNT(*)::int AS c FROM contact_messages')).rows[0].c;
  await assert.rejects(withTransaction(s.app.db, async (c) => { await ins(c, 'one'); await ins(c, 'two'); throw new Error('boom'); }), /boom/);
  assert.equal(await cnt(), 0, 'rolled back');
  await withTransaction(s.app.db, async (c) => { await ins(c, 'one'); await ins(c, 'two'); });
  assert.equal(await cnt(), 2, 'committed');
  const pids = await withTransaction(s.app.db, async (c) => [(await c.query('SELECT pg_backend_pid() AS p')).rows[0].p, (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p]);
  assert.equal(pids[0], pids[1], 'same connection for the whole transaction');
  assert.equal(s.app.db.totalCount, s.app.db.idleCount, 'every client was released back to the pool');
  await s.close();
});

test('concurrent inserts of the same unique value: exactly one wins, others get 23505', async () => {
  const s = await start();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => s.q("INSERT INTO events (slug, title) VALUES ('race', 't')")));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.ok(isUnique(r.reason, 'events_slug'));
  await s.q("DELETE FROM events WHERE slug = 'race'");
  await s.close();
});

test('closing the app drains and ends the pool', async () => {
  const s = await start();
  await s.api('/api/health');
  await s.close();
  await assert.rejects(s.app.db.query('SELECT 1'), /pool|ended|closed/i);
});
