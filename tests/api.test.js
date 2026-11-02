import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './helpers.js';

const TABLES = new Set(['registrations', 'contact_messages']);
const count = async (s, t) => { assert.ok(TABLES.has(t)); return (await s.q(`SELECT COUNT(*)::int AS c FROM ${t}`)).rows[0].c; };

test('seminar registration is removed: its API is gone, old invitation links go home, stored registrations stay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>home</title>');
  const s = await start({ staticDir: dir });
  const ev = (await s.q("INSERT INTO events (slug, title) VALUES ('old-seminar', 'Old seminar') ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title RETURNING id")).rows[0].id;
  await s.q("INSERT INTO registrations (event_id, invitation_no, access_token_hash, dedupe_key, first_name, last_name, age, phone, search_text) VALUES ($1, 'MGC-ABCDEF', 'h', 'd', 'Աննա', 'Գրիգորյան', 25, '+37477123456', 'x')", [ev]);
  assert.equal((await s.api('/api/registrations', { method: 'POST', body: { firstName: 'Աննա', lastName: 'Գրիգորյան', age: '25', phone: '+374 77 123456' } })).status, 404);
  for (const p of ['/api/event', '/api/invitations/' + 'a'.repeat(43), '/api/invitations/' + 'a'.repeat(43) + '/pdf']) assert.equal((await s.api(p)).status, 404, p);
  const a = await s.login();
  for (const p of ['registrations', 'registrations/1', 'registrations/1/pdf', 'registrations/export.csv', 'registrations/pdf'])
    assert.equal((await s.api('/api/admin/' + p, { cookie: a.cookie })).status, 404, p);
  const r = await s.api('/invitation');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/');
  assert.equal((await s.api('/')).status, 200);
  assert.equal(await count(s, 'registrations'), 1, 'historical seminar data is left untouched');
  await s.close();
});

test('contact form: saves message; honeypot, speed trap, bad email and bad phone are rejected', async () => {
  const s = await start();
  const ok = { name: 'Արամ Սարգսյան', email: 'Aram@Example.com', phone: '077 123456', service: 'Web Development', message: 'Բարև ձեզ', website: '', ts: Date.now() - 5000 };
  const r = await s.api('/api/contact', { method: 'POST', body: ok });
  assert.equal(r.status, 201);
  const row = (await s.q('SELECT * FROM contact_messages')).rows[0];
  assert.equal(row.email, 'aram@example.com'); assert.equal(row.phone, '+37477123456'); assert.equal(row.status, 'new'); assert.equal(row.message, 'Բարև ձեզ');
  assert.equal((await s.api('/api/contact', { method: 'POST', body: { ...ok, website: 'http://spam' } })).status, 400);
  assert.equal((await s.api('/api/contact', { method: 'POST', body: { ...ok, ts: Date.now() } })).status, 400);
  assert.equal((await s.api('/api/contact', { method: 'POST', body: { ...ok, ts: undefined } })).status, 400);
  const bad = await s.api('/api/contact', { method: 'POST', body: { ...ok, email: 'nope', phone: '1' } });
  assert.equal(bad.status, 422); assert.deepEqual(Object.keys(bad.data.error.fields).sort(), ['email', 'phone']);
  assert.equal((await s.api('/api/contact', { method: 'POST', body: { ...ok, message: 'x'.repeat(3001) } })).status, 422);
  assert.equal(await count(s, 'contact_messages'), 1);
  await s.close();
});

test('every admin endpoint rejects unauthenticated requests', async () => {
  const s = await start();
  await s.api('/api/contact', { method: 'POST', body: { name: 'A', email: 'a@b.co', ts: Date.now() - 9000 } });
  const gets = ['me', 'stats', 'messages', 'messages/1'];
  for (const p of gets) assert.equal((await s.api('/api/admin/' + p)).status, 401, p);
  for (const [m, p] of [['POST', 'logout'], ['POST', 'password'], ['PATCH', 'messages/1']]) assert.equal((await s.api('/api/admin/' + p, { method: m, body: { status: 'read' } })).status, 401, p);
  assert.equal((await s.api('/api/admin/me', { cookie: 'mg_admin=forged' })).status, 401);
  await s.close();
});

test('admin login: wrong credentials rejected, cookie flags, CSRF enforced, logout revokes session', async () => {
  const s = await start({ cookieSecure: true });
  assert.equal((await s.login('magical', 'wrong')).status, 401);
  assert.equal((await s.login('nobody', '321magical123')).status, 401);
  const l = await s.login();
  assert.equal(l.status, 200);
  const sc = l.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Secure/);
  assert.ok(!JSON.stringify(l.data).includes('321magical123'));
  assert.equal((await s.api('/api/admin/me', { cookie: l.cookie })).data.username, 'magical');
  await s.api('/api/contact', { method: 'POST', body: { name: 'A', email: 'a@b.co', ts: Date.now() - 9000 } });
  assert.equal((await s.api('/api/admin/messages/1', { method: 'PATCH', cookie: l.cookie, body: { status: 'read' } })).status, 403, 'no CSRF header');
  assert.equal((await s.api('/api/admin/messages/1', { method: 'PATCH', cookie: l.cookie, csrf: 'wrong', body: { status: 'read' } })).status, 403);
  const ok = await s.api('/api/admin/messages/1', { method: 'PATCH', cookie: l.cookie, csrf: l.csrf, body: { status: 'processed' } });
  assert.equal(ok.status, 200); assert.equal(ok.data.message.status, 'processed');
  assert.equal((await s.api('/api/admin/messages/1', { method: 'PATCH', cookie: l.cookie, csrf: l.csrf, body: { status: 'bogus' } })).status, 422);
  assert.equal((await s.api('/api/admin/logout', { method: 'POST', cookie: l.cookie, csrf: l.csrf })).status, 200);
  assert.equal((await s.api('/api/admin/me', { cookie: l.cookie })).status, 401);
  const stored = (await s.q('SELECT password_hash AS h FROM admins')).rows[0].h;
  assert.match(stored, /^scrypt\$/); assert.ok(!stored.includes('321magical123'));
  await s.close();
});

test('login rate limiting locks out brute force', async () => {
  const s = await start({ rateLimits: true });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await s.login('magical', 'bad' + i)).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[5], 429);
  const r = await s.login(); // correct password is also blocked while locked
  assert.equal(r.status, 429); assert.ok(r.headers.get('retry-after'));
  await s.close();
});

test('public submissions are rate limited', async () => {
  const s = await start({ rateLimits: true });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await s.api('/api/contact', { method: 'POST', body: { name: 'Թեստ ' + i, email: `t${i}@x.co`, ts: Date.now() - 9000 } })).status);
  assert.equal(codes.filter((c) => c === 201).length, 6); assert.equal(codes[6], 429);
  await s.close();
});

test('admin messages: list, filter, search, mark read/processed', async () => {
  const s = await start();
  for (const n of ['Արամ', 'Anna', 'Bob']) await s.api('/api/contact', { method: 'POST', body: { name: n, email: `${n.length}@x.co`, service: 'UI/UX Design', message: 'Hello ' + n, ts: Date.now() - 9000 } });
  const a = await s.login();
  const get = (p) => s.api('/api/admin/' + p, { cookie: a.cookie });
  const l = await get('messages');
  assert.equal(l.data.total, 3);
  assert.deepEqual(Object.keys(l.data.items[0]).sort(), ['createdAt', 'email', 'id', 'message', 'name', 'phone', 'service', 'status', 'updatedAt']);
  assert.equal((await get('messages?q=' + encodeURIComponent('արամ'))).data.total, 1);
  await s.api('/api/admin/messages/2', { method: 'PATCH', cookie: a.cookie, csrf: a.csrf, body: { status: 'read' } });
  assert.equal((await get('messages?status=read')).data.total, 1);
  assert.equal((await get('messages?status=new')).data.total, 2);
  assert.equal((await get('messages?status=' + encodeURIComponent("new' OR '1'='1"))).data.total, 3, 'invalid filter ignored, not injected');
  await s.close();
});

test('origin check blocks cross-site state changes; headers and errors are safe', async () => {
  const s = await start();
  const a = await s.login();
  const evil = await s.api('/api/contact', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { name: 'A', email: 'a@b.co', ts: Date.now() - 9000 } });
  assert.equal(evil.status, 403);
  const same = await s.api('/api/contact', { method: 'POST', headers: { Origin: s.base }, body: { name: 'A', email: 'a@b.co', ts: Date.now() - 9000 } });
  assert.equal(same.status, 201);
  const r = await s.api('/api/admin/me', { cookie: a.cookie });
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const nf = await s.api('/api/nope'); assert.equal(nf.status, 404); assert.deepEqual(Object.keys(nf.data), ['error']);
  await s.close();
});

test('password change: needs current password, revokes other sessions', async () => {
  const s = await start();
  const a = await s.login(), b = await s.login();
  const bad = await s.api('/api/admin/password', { method: 'POST', cookie: a.cookie, csrf: a.csrf, body: { currentPassword: 'nope', newPassword: 'a-new-long-password' } });
  assert.equal(bad.status, 422);
  assert.equal((await s.api('/api/admin/password', { method: 'POST', cookie: a.cookie, csrf: a.csrf, body: { currentPassword: '321magical123', newPassword: 'short' } })).status, 422);
  assert.equal((await s.api('/api/admin/password', { method: 'POST', cookie: a.cookie, csrf: a.csrf, body: { currentPassword: '321magical123', newPassword: 'a-new-long-password' } })).status, 200);
  assert.equal((await s.api('/api/admin/me', { cookie: b.cookie })).status, 401);
  assert.equal((await s.api('/api/admin/me', { cookie: a.cookie })).status, 200);
  assert.equal((await s.login('magical', '321magical123')).status, 401);
  assert.equal((await s.login('magical', 'a-new-long-password')).status, 200);
  await s.close();
});

test('admin username is case-insensitive; NUL bytes in input never cause a database error', async () => {
  const s = await start();
  assert.equal((await s.login('MAGICAL', '321magical123')).status, 200);
  assert.equal((await s.login('magi\u0000cal', 'x')).status, 401);
  const a = await s.login();
  assert.equal((await s.api('/api/admin/messages?q=' + encodeURIComponent('a\u0000b'), { cookie: a.cookie })).status, 200);
  const r = await s.api('/api/contact', { method: 'POST', body: { name: 'Աննա\u0000', email: 'a@b.co', ts: Date.now() - 9000 } });
  assert.ok([201, 422].includes(r.status), 'NUL must be stripped or rejected, never a 500: ' + r.status);
  await s.close();
});

test('expired admin sessions are rejected (timestamptz comparison)', async () => {
  const s = await start();
  const a = await s.login();
  assert.equal((await s.api('/api/admin/me', { cookie: a.cookie })).status, 200);
  await s.q("UPDATE admin_sessions SET expires_at = now() - interval '1 minute'");
  assert.equal((await s.api('/api/admin/me', { cookie: a.cookie })).status, 401);
  assert.equal((await s.login()).status, 200); // login also purges expired rows
  assert.equal((await s.q('SELECT COUNT(*)::int AS c FROM admin_sessions')).rows[0].c, 1);
  await s.close();
});

test('timestamps are returned as ISO-8601 UTC strings and counts as numbers', async () => {
  const s = await start();
  await s.api('/api/contact', { method: 'POST', body: { name: 'A', email: 'a@b.co', ts: Date.now() - 9000 } });
  const a = await s.login();
  const m = (await s.api('/api/admin/messages', { cookie: a.cookie })).data;
  assert.match(m.items[0].createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(m.items[0].updatedAt, null);
  assert.equal(typeof m.total, 'number');
  assert.deepEqual((await s.api('/api/admin/stats', { cookie: a.cookie })).data, { messages: 1, newMessages: 1 });
  await s.close();
});
