import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

const valid = { firstName: 'Աննա', lastName: 'Գրիգորյան', age: '25', phone: '+374 77 123456' };
const TABLES = new Set(['registrations', 'contact_messages']);
const count = async (s, t) => { assert.ok(TABLES.has(t)); return (await s.q(`SELECT COUNT(*)::int AS c FROM ${t}`)).rows[0].c; };

test('registration: saved in DB, returns secret-link invitation, public view exposes no phone/age', async () => {
  const s = await start();
  const r = await s.api('/api/registrations', { method: 'POST', body: valid });
  assert.equal(r.status, 201);
  const inv = r.data.invitation;
  assert.match(inv.number, /^MGC-[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(inv.token.length >= 40);
  assert.equal(inv.firstName, 'Աննա');
  const row = (await s.q('SELECT * FROM registrations')).rows[0];
  assert.equal(row.phone, '+37477123456');
  assert.equal(row.age, 25);
  assert.notEqual(row.access_token_hash, inv.token, 'token must not be stored in clear');
  const pub = await s.api(`/api/invitations/${inv.token}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(Object.keys(pub.data.invitation).sort(), ['createdAt', 'event', 'firstName', 'lastName', 'number']);
  assert.ok(!JSON.stringify(pub.data).includes('37477'));
  await s.close();
});

test('invitation access: wrong token / numeric ID / invitation number do not work (no IDOR)', async () => {
  const s = await start();
  const inv = (await s.api('/api/registrations', { method: 'POST', body: valid })).data.invitation;
  for (const bad of ['1', inv.number, 'A'.repeat(43), 'x'.repeat(10)]) {
    assert.equal((await s.api(`/api/invitations/${bad}`)).status, 404, bad);
    assert.equal((await s.api(`/api/invitations/${bad}/pdf`)).status, 404, bad);
  }
  assert.equal((await s.api('/api/invitations')).status, 404);
  await s.close();
});

test('registration validation (server side) rejects bad input with Armenian messages and stores nothing', async () => {
  const s = await start();
  const cases = [
    [{}, ['firstName', 'lastName', 'age', 'phone']],
    [{ ...valid, age: '0' }, ['age']], [{ ...valid, age: '121' }, ['age']], [{ ...valid, age: '12.5' }, ['age']], [{ ...valid, age: -3 }, ['age']],
    [{ ...valid, phone: '12345' }, ['phone']], [{ ...valid, phone: 'abc' }, ['phone']],
    [{ ...valid, firstName: 'A' }, ['firstName']], [{ ...valid, lastName: '<script>alert(1)</script>' }, ['lastName']],
    [{ ...valid, firstName: 'x'.repeat(51) }, ['firstName']],
  ];
  for (const [body, fields] of cases) {
    const r = await s.api('/api/registrations', { method: 'POST', body });
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.deepEqual(Object.keys(r.data.error.fields).sort(), fields.sort());
    for (const m of Object.values(r.data.error.fields)) assert.match(m, /[\u0531-\u058f]/);
  }
  assert.equal(await count(s, 'registrations'), 0);
  assert.equal((await s.api('/api/registrations', { method: 'POST', body: '{bad', raw: true, headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await s.api('/api/registrations', { method: 'POST', body: 'a=b', raw: true, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  await s.close();
});

test('Armenian phone formats are accepted and normalised', async () => {
  const s = await start();
  const formats = ['+37477123456', '077123456', '(077) 12-34-56', '77123456', '00374 77 123456', '374-77-123456'];
  for (const [i, phone] of formats.entries()) {
    const r = await s.api('/api/registrations', { method: 'POST', body: { ...valid, lastName: 'Ստուգում' + 'աբգդեզ'[i], phone } });
    assert.equal(r.status, i === 0 ? 201 : r.status, phone);
    assert.ok([201].includes(r.status), `${phone} -> ${r.status}`);
  }
  assert.deepEqual((await s.q('SELECT DISTINCT phone AS p FROM registrations')).rows.map((x) => x.p), ['+37477123456']);
  await s.close();
});

test('duplicate protection: same Idempotency-Key replays; parallel retries create one row; same person again -> 409', async () => {
  const s = await start();
  const h = { 'Idempotency-Key': 'key-' + 'a'.repeat(20) };
  const rs = await Promise.all(Array.from({ length: 6 }, () => s.api('/api/registrations', { method: 'POST', body: valid, headers: h })));
  assert.ok(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => r.status).join());
  assert.equal(new Set(rs.map((r) => r.data.invitation.number)).size, 1);
  assert.equal(new Set(rs.map((r) => r.data.invitation.token)).size, 1);
  assert.equal(await count(s, 'registrations'), 1);
  const again = await s.api('/api/registrations', { method: 'POST', body: valid, headers: { 'Idempotency-Key': 'key-' + 'b'.repeat(20) } });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'duplicate_registration');
  assert.equal(await count(s, 'registrations'), 1);
  // different people sharing a phone is allowed
  assert.equal((await s.api('/api/registrations', { method: 'POST', body: { ...valid, firstName: 'Արամ' } })).status, 201);
  await s.close();
});

test('invitation PDF is a real PDF with embedded Armenian-capable fonts and the person\'s name', async () => {
  const s = await start();
  const inv = (await s.api('/api/registrations', { method: 'POST', body: valid })).data.invitation;
  const r = await s.api(`/api/invitations/${inv.token}/pdf`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/pdf/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="magical-invitation-MGC-[A-Z0-9]{6}\.pdf"/);
  const b = r.data;
  assert.equal(b.subarray(0, 5).toString(), '%PDF-');
  assert.ok(b.toString('latin1').includes('%%EOF'));
  assert.ok(b.toString('latin1').includes('/FontFile2'), 'fonts must be embedded');
  assert.ok(b.length > 20_000);
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
  await s.api('/api/registrations', { method: 'POST', body: valid });
  await s.api('/api/contact', { method: 'POST', body: { name: 'A', email: 'a@b.co', ts: Date.now() - 9000 } });
  const gets = ['me', 'stats', 'registrations', 'registrations/1', 'registrations/1/pdf', 'registrations/export.csv', 'registrations/pdf', 'messages', 'messages/1'];
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
  for (let i = 0; i < 9; i++) codes.push((await s.api('/api/registrations', { method: 'POST', body: { ...valid, phone: `07712${3400 + i}`, lastName: 'Թեստ' + 'աբգդեզէըթ'[i] } })).status);
  assert.equal(codes.filter((c) => c === 201).length, 8); assert.equal(codes[8], 429);
  await s.close();
});

test('admin registrations: list, Unicode search, sort, pagination, CSV (injection-safe), PDFs', async () => {
  const s = await start();
  const names = [['Արամ', 'Սարգսյան'], ['Անի', 'Ավետիսյան'], ['Ivan', 'Petrov'], ['Иван', 'Иванов'], ['=cmd', 'Evil']];
  for (const [i, [f, l]] of names.entries()) {
    const r = await s.api('/api/registrations', { method: 'POST', body: { firstName: f === '=cmd' ? 'Cmd' : f, lastName: l, age: 20 + i, phone: `09${1000000 + i * 11}` } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  await s.q("UPDATE registrations SET first_name = '=HYPERLINK(1)' WHERE last_name = 'Evil'");
  const a = await s.login();
  const get = (p) => s.api('/api/admin/' + p, { cookie: a.cookie });
  const all = await get('registrations');
  assert.equal(all.data.total, 5); assert.equal(all.data.items[0].lastName, 'Evil', 'newest first');
  assert.ok(all.data.items[0].phone.startsWith('+374'));
  assert.equal((await get('registrations?q=' + encodeURIComponent('ԱՐԱՄ'))).data.total, 1, 'case-insensitive Armenian');
  assert.equal((await get('registrations?q=' + encodeURIComponent('иванов'))).data.total, 1);
  assert.equal((await get('registrations?q=091000044')).data.total, 1, 'national phone format');
  const inv = all.data.items[2].invitationNo;
  assert.equal((await get('registrations?q=' + inv.toLowerCase())).data.items[0].invitationNo, inv);
  assert.equal((await get('registrations?q=%25')).data.total, 0, 'LIKE wildcards are escaped');
  assert.equal((await get("registrations?q=' OR 1=1 --")).data.total, 0);
  const sorted = await get('registrations?sort=age&dir=asc&pageSize=2&page=2');
  assert.deepEqual(sorted.data.items.map((x) => x.age), [22, 23]); assert.equal(sorted.data.total, 5);
  assert.equal((await get('registrations?sort=password;DROP')).status, 200, 'unknown sort falls back safely');
  const one = await get('registrations/' + all.data.items[1].id);
  assert.equal(one.data.registration.age, all.data.items[1].age);
  assert.equal((await get('registrations/99999')).status, 404); assert.equal((await get('registrations/abc')).status, 404);
  const pdf = await get(`registrations/${all.data.items[1].id}/pdf`);
  assert.equal(pdf.status, 200); assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  const csv = await get('registrations/export.csv');
  assert.equal(csv.status, 200); assert.deepEqual([...csv.data.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel reads Armenian');
  const csvText = csv.data.toString('utf8').slice(1);
  assert.ok(csvText.startsWith('invitation_no,first_name'));
  assert.ok(csvText.includes("'=HYPERLINK(1)"), 'formula cells neutralised'); assert.equal(csvText.trim().split('\r\n').length, 6);
  assert.ok(csvText.includes('Սարգսյան') && csvText.includes('Иванов'));
  const bundle = await get('registrations/pdf');
  assert.equal(bundle.status, 200);
  assert.equal((bundle.data.toString('latin1').match(/\/Type \/Page /g) || []).length, 5, 'one page per participant');
  assert.equal((await get('stats')).data.registrations, 5);
  await s.close();
});

test('combined PDF streams 450 invitations (keyset paging across >200 rows) with bounded memory', async () => {
  const s = await start();
  const { rows: [ev] } = await s.q('SELECT id FROM events LIMIT 1');
  await s.q(`INSERT INTO registrations (event_id, invitation_no, access_token_hash, dedupe_key, first_name, last_name, age, phone, search_text)
             SELECT $1, 'MGC-T' || (10000 + g), 'h' || g, 'd' || g, 'Աննա', 'Տեստյան' || g, 30, '+3747' || (1000000 + g), 'x' FROM generate_series(0, 449) AS g`, [ev.id]);
  assert.equal(await count(s, 'registrations'), 450);
  const a = await s.login();
  global.gc?.();
  const before = process.memoryUsage().rss;
  const r = await s.api('/api/admin/registrations/pdf', { cookie: a.cookie });
  assert.equal(r.status, 200);
  const txt = r.data.toString('latin1');
  assert.equal((txt.match(/\/Type \/Page /g) || []).length, 450);
  assert.match(txt, /\/Count 450/);
  const grew = (process.memoryUsage().rss - before) / 1e6;
  assert.ok(grew < 150, `rss grew ${grew.toFixed(0)}MB`);
  await s.close();
});

test('admin messages: list, filter, search, mark read/processed; contact stays separate from registrations', async () => {
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
  assert.equal((await get('registrations')).data.total, 0);
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
  assert.equal((await s.api('/api/registrations')).status, 405);
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

test('sorting and search are case-insensitive for Armenian and Russian text', async () => {
  const s = await start();
  const people = [['Արամ', 'Բարսեղյան'], ['Անի', 'ավետիսյան'], ['Գոռ', 'Գրիգորյան'], ['Иван', 'Яковлев'], ['Пётр', 'иванов'], ['Олег', 'Петров']];
  for (const [i, [f, l]] of people.entries()) assert.equal((await s.api('/api/registrations', { method: 'POST', body: { firstName: f, lastName: l, age: 30, phone: `0771${20000 + i}` } })).status, 201);
  const a = await s.login();
  const order = async (q) => (await s.api('/api/admin/registrations?sort=last_name&dir=asc' + q, { cookie: a.cookie })).data.items.map((x) => x.lastName);
  const all = await order('');
  const arm = all.filter((x) => /[\u0531-\u058f]/.test(x)), rus = all.filter((x) => /[\u0400-\u04ff]/.test(x));
  assert.deepEqual(arm, ['ավետիսյան', 'Բարսեղյան', 'Գրիգորյան'], 'Armenian ordering must ignore case (PostgreSQL needs a UTF-8 database locale)');
  assert.deepEqual(rus, ['иванов', 'Петров', 'Яковлев']);
  assert.deepEqual(await order('&q=' + encodeURIComponent('ЯКОВЛЕВ')), ['Яковлев']);
  assert.deepEqual(await order('&q=' + encodeURIComponent('բարսեղյան')), ['Բարսեղյան']);
  const fn = (await s.api('/api/admin/registrations?sort=first_name&dir=desc', { cookie: a.cookie })).data.items.map((x) => x.firstName);
  assert.equal(fn.length, 6);
  await s.close();
});

test('admin username is case-insensitive; NUL bytes in input never cause a database error', async () => {
  const s = await start();
  assert.equal((await s.login('MAGICAL', '321magical123')).status, 200);
  assert.equal((await s.login('magi\u0000cal', 'x')).status, 401);
  const a = await s.login();
  assert.equal((await s.api('/api/admin/registrations?q=' + encodeURIComponent('a\u0000b'), { cookie: a.cookie })).status, 200);
  assert.equal((await s.api('/api/admin/messages?q=' + encodeURIComponent('a\u0000b'), { cookie: a.cookie })).status, 200);
  const r = await s.api('/api/registrations', { method: 'POST', body: { firstName: 'Աննա\u0000', lastName: 'Գրիգորյան', age: 20, phone: '077123450' } });
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
  assert.deepEqual((await s.api('/api/admin/stats', { cookie: a.cookie })).data, { registrations: 0, messages: 1, newMessages: 1 });
  await s.close();
});
