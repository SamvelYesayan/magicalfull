import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, databaseConfig } from '../server/config.js';
import { assertSafeTestDatabase } from './db-guard.js';

const base = { NODE_ENV: 'test', APP_SECRET: 's'.repeat(40) };

test('DATABASE_URL and PG* variables configure PostgreSQL', () => {
  const a = loadConfig({ ...base, DATABASE_URL: 'postgresql://u:p%40ss@db.example:6543/magical_web' }).db;
  assert.equal(a.database, 'magical_web'); assert.match(a.connectionString, /^postgresql:/);
  const b = loadConfig({ ...base, PGHOST: 'h', PGDATABASE: 'd', PGUSER: 'u', PGPASSWORD: 'secret', PGPORT: '5433' }).db;
  assert.deepEqual([b.host, b.port, b.database, b.user, b.password], ['h', 5433, 'd', 'u', 'secret']);
  assert.equal(databaseConfig({ DATABASE_URL: 'postgres://u@h/d', DATABASE_SSL: 'true' }).ssl.rejectUnauthorized, true);
  assert.equal(databaseConfig({ DATABASE_URL: 'postgres://u@h/d', PG_POOL_MAX: '3' }).max, 3);
});

test('missing or invalid configuration fails clearly and never falls back to SQLite', () => {
  assert.throws(() => loadConfig(base), /PostgreSQL is not configured.*DATABASE_URL/s);
  assert.throws(() => loadConfig({ ...base, DATABASE_PATH: 'data/magical.db' }), /PostgreSQL is not configured/, 'legacy DATABASE_PATH is ignored, not used');
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: 'sqlite:///data/magical.db' }), /SQLite is no longer supported/);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: 'data/magical.db' }), /not a valid URL/);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: 'postgresql://u:p@h:5432/' }), /database name/);
  assert.throws(() => loadConfig({ ...base, PGHOST: 'h' }), /PGDATABASE, PGUSER/);
  assert.throws(() => loadConfig({ ...base, PGHOST: 'h', PGDATABASE: 'd', PGUSER: 'u', PGPORT: '99999' }), /PGPORT/);
  try { loadConfig({ ...base, DATABASE_URL: 'sqlite://user:TOPSECRET@x/y' }); } catch (e) { assert.ok(!e.message.includes('TOPSECRET'), 'errors must not leak passwords'); }
});

test('production still requires APP_SECRET', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@h/d' }), /APP_SECRET/);
  assert.equal(loadConfig({ NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgresql://u@h/d' }).cookieSecure, true);
});

test('test-database guard refuses production and unrelated databases', () => {
  const ok = 'postgresql://u:p@localhost:5432/magical_web_test';
  assert.equal(assertSafeTestDatabase(ok, {}), 'magical_web_test');
  assert.throws(() => assertSafeTestDatabase(undefined, {}), /TEST_DATABASE_URL is not set/);
  assert.throws(() => assertSafeTestDatabase('postgresql://u:p@localhost/magical_web', {}), /ending in "_test"/);
  assert.throws(() => assertSafeTestDatabase('postgresql://u:p@localhost/postgres', {}), /ending in "_test"/);
  assert.throws(() => assertSafeTestDatabase('postgresql://u:p@localhost/prod_test', { DATABASE_URL: 'postgresql://u:p@x/prod_test' }), /same as the application database/);
  assert.throws(() => assertSafeTestDatabase('postgresql://u:p@localhost/app_test', { PGDATABASE: 'app_test' }), /same as the application database/);
  assert.throws(() => assertSafeTestDatabase('sqlite://magical_test', {}), /postgresql/);
  assert.throws(() => assertSafeTestDatabase('not a url', {}), /valid URL/);
  assert.throws(() => assertSafeTestDatabase('postgresql://u:p@localhost/', {}), /database name/);
});
