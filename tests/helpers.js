import pg from 'pg';
import { after } from 'node:test';
import { createApp, ensureAdmin } from '../server/app.js';
import { loadConfig, loadEnvFile } from '../server/config.js';
import { assertSafeTestDatabase } from './db-guard.js';

loadEnvFile(); // lets TEST_DATABASE_URL live in .env

const openServers = new Set();
after(() => Promise.all([...openServers].map((c) => c())));

let verified; // checked once per process, before anything is created or wiped
function verifyTestDatabase() {
  verified ??= (async () => {
    const url = process.env.TEST_DATABASE_URL;
    const expected = assertSafeTestDatabase(url);
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT current_database() AS db');
      if (rows[0].db !== expected || !rows[0].db.endsWith('_test')) throw new Error(`Refusing to run: connected to "${rows[0].db}", expected "${expected}".`);
    } finally { await client.end(); }
    return url;
  })();
  return verified;
}

export async function start(extra = {}) {
  const url = await verifyTestDatabase();
  const config = { ...loadConfig({ NODE_ENV: 'test', APP_SECRET: 's'.repeat(40), DATABASE_URL: url, STATIC_DIR: '/nonexistent' }), rateLimits: false, ...extra };
  const app = await createApp(config); // applies migrations to the (verified) test database
  await app.db.query('TRUNCATE registrations, contact_messages, admin_sessions, admins, pioneer_cards, pioneer_login_guard, pioneer_rewards, pioneer_settings RESTART IDENTITY CASCADE');
  await app.db.query('INSERT INTO pioneer_settings (id) VALUES (TRUE)'); // default initial bonus (200)
  app.server.listen(0, '127.0.0.1');
  await new Promise((ok) => (app.server.listening ? ok() : app.server.once('listening', ok)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await ensureAdmin(app.db, 'magical', '321magical123');
  const api = async (path, { method = 'GET', body, headers = {}, cookie, csrf, raw } = {}) => {
    const h = { ...headers };
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    if (csrf) h['X-CSRF-Token'] = csrf;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : ct.includes('pdf') || ct.includes('csv') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, headers: res.headers, data };
  };
  const login = async (username = 'magical', password = '321magical123') => {
    const r = await api('/api/admin/login', { method: 'POST', body: { username, password } });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    return { ...r, cookie, csrf: r.data.csrfToken };
  };
  const q = (sql, params) => app.db.query(sql, params);
  const close = async () => { if (openServers.delete(close)) await app.close(); };
  openServers.add(close);
  return { app, base, api, login, q, close };
}

export { verifyTestDatabase };
