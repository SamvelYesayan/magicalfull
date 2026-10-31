import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';
import { createPool, migrate } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { verifyTestDatabase } from './helpers.js';
import { HARD_LOCK_AFTER, LOCK_AFTER } from '../server/pioneer.js';

const A = '/api/admin/pioneer';
const key = () => 'k' + Math.random().toString(36).slice(2).padEnd(12, 'x') + Date.now().toString(36);

async function admin(s) {
  const l = await s.login();
  const call = (path, opts = {}) => s.api(A + path, { cookie: l.cookie, csrf: l.csrf, ...opts });
  return { ...l, call };
}
async function newCard(ad, holder = {}) {
  const r = await ad.call('/cards', { method: 'POST', body: holder });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...r.data.card, cvv: r.data.cvv };
}
const wrongCvv = (cvv) => String((Number(cvv) + 1) % 1000).padStart(3, '0');
async function holder(s, number, cvv) {
  const r = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: number, cvv } });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const call = (path, opts = {}) => s.api('/api/pioneer' + path, { cookie, csrf: r.data.csrfToken, ...opts });
  return { ...r, cookie, csrf: r.data.csrfToken, call };
}
const balanceOf = async (s, id) => (await s.q('SELECT balance FROM pioneer_cards WHERE id = $1', [id])).rows[0].balance;
const ledgerConsistent = async (s) => (await s.q('SELECT COUNT(*)::int AS c FROM pioneer_cards c WHERE c.balance <> COALESCE((SELECT SUM(amount) FROM pioneer_transactions t WHERE t.card_id = c.id), 0)')).rows[0].c === 0;

test('pioneer migration is additive: existing records survive, re-running is a no-op', async () => {
  const s = await start();
  await s.api('/api/registrations', { method: 'POST', body: { firstName: 'Աննա', lastName: 'Գրիգորյան', age: '25', phone: '+374 77 123456' } });
  await s.close();
  const url = await verifyTestDatabase();
  const p = createPool(loadConfig({ NODE_ENV: 'test', APP_SECRET: 's'.repeat(40), DATABASE_URL: url }));
  try {
    // Simulate an existing production database that only has 001 applied, then upgrade it.
    await p.query('DROP TABLE IF EXISTS pioneer_transactions, pioneer_redemptions, pioneer_transfers, pioneer_sessions, pioneer_login_guard, pioneer_audit_log, pioneer_announcements, pioneer_rewards, pioneer_cards, pioneer_settings CASCADE');
    await p.query("DELETE FROM schema_migrations WHERE version IN ('002_pioneer.sql', '003_pioneer_gift_card.sql', '004_pioneer_cvv_escrow.sql')");
    const before = (await p.query('SELECT invitation_no, first_name, phone FROM registrations ORDER BY id')).rows;
    const admins = (await p.query('SELECT id, username, password_hash FROM admins ORDER BY id')).rows;
    assert.equal(before.length, 1);
    assert.deepEqual(await migrate(p), ['002_pioneer.sql', '003_pioneer_gift_card.sql', '004_pioneer_cvv_escrow.sql']);
    assert.deepEqual(await migrate(p), []);
    assert.deepEqual((await p.query('SELECT invitation_no, first_name, phone FROM registrations ORDER BY id')).rows, before);
    assert.deepEqual((await p.query('SELECT id, username, password_hash FROM admins ORDER BY id')).rows, admins, 'admin credentials untouched');
    assert.equal((await p.query('SELECT initial_bonus FROM pioneer_settings')).rows[0].initial_bonus, 200);
  } finally { await p.end(); }
});

test('admin card endpoints require an admin session + CSRF; a cardholder session is not an admin session', async () => {
  const s = await start();
  for (const p of ['/stats', '/cards', '/cards/1', '/cards/1/transactions', '/cards/1/pdf', '/transactions', '/redemptions', '/rewards', '/audit', '/settings', '/announcements'])
    assert.equal((await s.api(A + p)).status, 401, p);
  for (const [m, p] of [['POST', '/cards'], ['PATCH', '/cards/1'], ['POST', '/cards/1/status'], ['POST', '/cards/1/cvv'], ['POST', '/cards/1/adjust'], ['POST', '/cards/1/unlock'], ['POST', '/rewards'], ['PATCH', '/rewards/1'], ['DELETE', '/rewards/1'], ['PUT', '/settings'], ['POST', '/redemptions/1/status']])
    assert.equal((await s.api(A + p, { method: m, body: {} })).status, 401, `${m} ${p}`);
  const ad = await admin(s);
  assert.equal((await s.api(A + '/cards', { method: 'POST', body: {}, cookie: ad.cookie })).status, 403, 'CSRF token required');
  const c = await newCard(ad);
  const h = await holder(s, c.number, c.cvv);
  assert.equal(h.status, 200);
  assert.equal((await s.api(A + '/cards', { cookie: h.cookie })).status, 401, 'cardholder cookie cannot reach admin API');
  assert.equal((await s.api('/api/admin/me', { cookie: h.cookie })).status, 401);
  for (const p of ['/me', '/transactions', '/rewards', '/redemptions', '/announcements']) assert.equal((await s.api('/api/pioneer' + p)).status, 401, p);
  assert.equal((await s.api('/api/pioneer/transfers', { method: 'POST', body: {}, cookie: h.cookie, headers: { 'Idempotency-Key': key() } })).status, 403, 'cardholder CSRF enforced');
  await s.close();
});

test('card creation: unique 8-digit number, private 3-digit CVV stored only as a hash, exactly 200 initial points', async () => {
  const s = await start();
  const ad = await admin(s);
  const c = await newCard(ad); // no name, no phone
  assert.match(c.number, /^[1-9]\d{7}$/);
  assert.match(c.cvv, /^\d{3}$/);
  assert.equal(c.firstName, null); assert.equal(c.phone, null);
  assert.equal(c.balance, 200);
  const row = (await s.q('SELECT * FROM pioneer_cards WHERE id = $1', [c.id])).rows[0];
  assert.match(row.cvv_hash, /^scrypt\$/);
  assert.ok(!row.cvv_hash.includes(`${c.number}:${c.cvv}`));
  const tx = (await s.q('SELECT type, amount, balance_after FROM pioneer_transactions WHERE card_id = $1', [c.id])).rows;
  assert.deepEqual(tx, [{ type: 'initial_bonus', amount: 200, balance_after: 200 }]);
  // The CVV and its hash never appear in list/detail responses.
  const list = await ad.call('/cards');
  const detail = await ad.call(`/cards/${c.id}`);
  for (const r of [list, detail]) { const t = JSON.stringify(r.data); assert.ok(!/cvv_?hash|scrypt/i.test(t)); assert.ok(!('cvv' in (r.data.card || r.data.items[0]))); }
  // Uniqueness: DB constraint + many generated numbers are all different.
  await assert.rejects(s.q("INSERT INTO pioneer_cards (card_no, cvv_hash, search_text) VALUES ($1, 'x', 'x')", [c.number]), (e) => e.code === '23505');
  const many = await Promise.all(Array.from({ length: 40 }, () => newCard(ad)));
  assert.equal(new Set([c.number, ...many.map((x) => x.number)]).size, 41);
  // A second initial bonus is impossible even at the database level.
  await assert.rejects(s.q("INSERT INTO pioneer_transactions (card_id, type, amount) VALUES ($1, 'initial_bonus', 200)", [c.id]), (e) => e.code === '23505');
  assert.ok(await ledgerConsistent(s));
  await s.close();
});

test('login: nameless card opens as "Pioneer Member"; repeated logins never add points; session id rotates', async () => {
  const s = await start({ cookieSecure: true });
  const ad = await admin(s);
  const c = await newCard(ad);
  const first = await holder(s, `${c.number.slice(0, 4)} ${c.number.slice(4)}`, c.cvv); // spaces are accepted
  assert.equal(first.status, 200);
  const sc = first.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(sc.includes(flag), flag);
  const me = await first.call('/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.card.displayName, 'Pioneer Member');
  assert.equal(me.data.card.hasName, false);
  assert.equal(me.data.balance, 200);
  for (let i = 0; i < 4; i++) assert.equal((await holder(s, c.number, c.cvv)).status, 200);
  assert.equal(await balanceOf(s, c.id), 200);
  assert.equal((await s.q('SELECT COUNT(*)::int AS c FROM pioneer_transactions WHERE card_id = $1', [c.id])).rows[0].c, 1);
  // Logging in with an existing cookie revokes it and issues a new one.
  const again = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: c.number, cvv: c.cvv }, cookie: first.cookie });
  assert.notEqual(again.headers.get('set-cookie').split(';')[0], first.cookie);
  assert.equal((await first.call('/me')).status, 401, 'old session id is no longer valid');
  // logout
  const h = await holder(s, c.number, c.cvv);
  assert.equal((await h.call('/logout', { method: 'POST' })).status, 200);
  assert.equal((await h.call('/me')).status, 401);
  assert.ok((await s.q('SELECT activated_at FROM pioneer_cards WHERE id = $1', [c.id])).rows[0].activated_at);
  await s.close();
});

test('invalid credentials: identical generic response for wrong CVV and unknown card; format errors rejected', async () => {
  const s = await start();
  const ad = await admin(s);
  const c = await newCard(ad);
  let unknown; do unknown = String(10_000_000 + Math.floor(Math.random() * 89_999_999)); while (unknown === c.number);
  const a = await holder(s, c.number, wrongCvv(c.cvv));
  const b = await holder(s, unknown, '123');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.data, b.data, 'no difference between existing and non-existing cards');
  assert.equal(a.headers.get('set-cookie'), null);
  for (const [n, v] of [['1234567', '123'], ['123456789', '123'], ['abcdefgh', '123'], [c.number, '12'], [c.number, '1234'], [c.number, 'abc'], [null, null]])
    assert.equal((await holder(s, n, v)).status, 422, `${n}/${v}`);
  await s.close();
});

test('per-card lockout: progressive, same for real and unknown numbers, blocks even the right CVV, hard lock needs admin', async () => {
  const s = await start();
  const ad = await admin(s);
  const c = await newCard(ad);
  const unknown = c.number === '99999999' ? '99999998' : '99999999';
  for (const n of [c.number, unknown]) {
    for (let i = 1; i < LOCK_AFTER; i++) assert.equal((await holder(s, n, wrongCvv(c.cvv))).status, 401);
    const locking = await holder(s, n, wrongCvv(c.cvv));
    assert.equal(locking.status, 401);
    const locked = await holder(s, n, c.cvv); // correct CVV, but the number is locked now
    assert.equal(locked.status, 429, n);
    assert.equal(locked.data.error.code, 'too_many_attempts');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  }
  const lockedReal = await holder(s, c.number, c.cvv), lockedUnknown = await holder(s, unknown, c.cvv);
  assert.deepEqual(lockedReal.data, lockedUnknown.data);
  // When the lock expires, the right CVV works and the counter is cleared.
  await s.q("UPDATE pioneer_login_guard SET locked_until = now() - interval '1 second'");
  assert.equal((await holder(s, c.number, c.cvv)).status, 200);
  assert.equal((await s.q('SELECT COUNT(*)::int AS c FROM pioneer_login_guard WHERE card_no = $1', [c.number])).rows[0].c, 0);
  // Keep failing (expiring each temporary lock) until the hard lock.
  for (let i = 1; i <= HARD_LOCK_AFTER; i++) {
    await s.q("UPDATE pioneer_login_guard SET locked_until = now() - interval '1 second' WHERE locked_until <> 'infinity'");
    assert.equal((await holder(s, c.number, wrongCvv(c.cvv))).status, 401, `attempt ${i}`);
  }
  const hard = await holder(s, c.number, c.cvv);
  assert.equal(hard.status, 429); assert.equal(hard.data.error.code, 'card_locked');
  const d = await ad.call(`/cards/${c.id}`);
  assert.equal(d.data.login.hardLocked, true);
  assert.equal((await ad.call(`/cards/${c.id}/unlock`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await holder(s, c.number, c.cvv)).status, 200);
  // Parallel guessing cannot slip past the lock (attempts are counted atomically before verification).
  const c2 = await newCard(ad);
  const burst = await Promise.all(Array.from({ length: 12 }, () => holder(s, c2.number, wrongCvv(c2.cvv))));
  assert.equal(burst.filter((r) => r.status === 401).length, LOCK_AFTER);
  assert.equal(burst.filter((r) => r.status === 429).length, 12 - LOCK_AFTER);
  await s.close();
});

test('login is rate limited per IP', async () => {
  const s = await start({ rateLimits: true });
  const statuses = [];
  for (let i = 0; i < 18; i++) statuses.push((await holder(s, String(20_000_000 + i), '123')).status);
  assert.ok(statuses.slice(0, 15).every((x) => x === 401), statuses.join());
  assert.ok(statuses.slice(15).every((x) => x === 429), statuses.join());
  await s.close();
});

test('admin can name a card later and add a phone; phone never reaches cardholders; CVV reset is one-time and revokes sessions', async () => {
  const s = await start();
  const ad = await admin(s);
  const c = await newCard(ad);
  const other = await newCard(ad, { firstName: 'Արամ', lastName: 'Պետրոսյան', phone: '077 123456' });
  assert.equal(other.phone, '+37477123456');
  const bad = await ad.call(`/cards/${c.id}`, { method: 'PATCH', body: { firstName: '<b>', phone: '12' } });
  assert.equal(bad.status, 422); assert.deepEqual(Object.keys(bad.data.error.fields).sort(), ['firstName', 'phone']);
  const up = await ad.call(`/cards/${c.id}`, { method: 'PATCH', body: { firstName: 'Աննա', lastName: 'Գրիգորյան', phone: '+374 91 000111' } });
  assert.equal(up.status, 200); assert.equal(up.data.card.firstName, 'Աննա'); assert.equal(up.data.card.phone, '+37491000111');
  assert.equal((await ad.call('/cards?q=' + encodeURIComponent('գրիգոր'))).data.total, 1, 'search by name');
  assert.equal((await ad.call('/cards?q=091000111')).data.total, 1, 'search by phone');
  assert.equal((await ad.call('/cards?q=' + c.number.slice(0, 4) + '%20' + c.number.slice(4))).data.total, 1, 'search by spaced number');
  const h = await holder(s, c.number, c.cvv);
  const me = await h.call('/me');
  assert.equal(me.data.card.displayName, 'Աննա Գրիգորյան');
  const lookup = await h.call('/recipient', { method: 'POST', body: { cardNumber: other.number } });
  assert.equal(lookup.data.recipient.name, 'Արամ Պետրոսյան');
  await h.call('/transfers', { method: 'POST', body: { cardNumber: other.number, amount: 5 }, headers: { 'Idempotency-Key': key() } });
  const everything = JSON.stringify([me.data, lookup.data, (await h.call('/transactions')).data, (await h.call('/me')).data]);
  for (const secret of ['37477123456', '77123456', '37491000111', '91000111', 'cvv']) assert.ok(!everything.toLowerCase().includes(secret.toLowerCase()), secret);
  // Clearing the name again is allowed (card stays valid).
  assert.equal((await ad.call(`/cards/${c.id}`, { method: 'PATCH', body: { firstName: '', lastName: '' } })).data.card.firstName, null);
  // CVV reset
  const reset = await ad.call(`/cards/${c.id}/cvv`, { method: 'POST', body: {} });
  assert.equal(reset.status, 200); assert.match(reset.data.cvv, /^\d{3}$/);
  assert.equal((await h.call('/me')).status, 401, 'sessions revoked');
  if (reset.data.cvv !== c.cvv) assert.equal((await holder(s, c.number, c.cvv)).status, 401, 'old CVV no longer works');
  assert.equal((await holder(s, c.number, reset.data.cvv)).status, 200);
  const log = await ad.call('/audit');
  assert.ok(log.data.items.some((x) => x.action === 'card.cvv_reset'));
  assert.ok(!JSON.stringify(log.data.items.map((x) => x.details)).includes(`"${reset.data.cvv}"`), 'audit never stores the CVV');
  await s.close();
});

test('deactivated cards cannot log in, keep sessions, receive or send points, or redeem', async () => {
  const s = await start();
  const ad = await admin(s);
  const a = await newCard(ad), b = await newCard(ad);
  const ha = await holder(s, a.number, a.cvv);
  const hb = await holder(s, b.number, b.cvv);
  assert.equal((await ad.call(`/cards/${b.id}/status`, { method: 'POST', body: { status: 'inactive' } })).status, 200);
  assert.equal((await hb.call('/me')).status, 401, 'existing session is dead');
  const login = await holder(s, b.number, b.cvv);
  assert.equal(login.status, 403); assert.equal(login.data.error.code, 'card_inactive');
  assert.equal((await holder(s, b.number, wrongCvv(b.cvv))).status, 401, 'wrong CVV still looks generic');
  assert.equal((await ha.call('/recipient', { method: 'POST', body: { cardNumber: b.number } })).status, 404);
  assert.equal((await ha.call('/transfers', { method: 'POST', body: { cardNumber: b.number, amount: 10 }, headers: { 'Idempotency-Key': key() } })).status, 404);
  await ad.call(`/cards/${b.id}/status`, { method: 'POST', body: { status: 'active' } });
  assert.equal((await holder(s, b.number, b.cvv)).status, 200, 'reactivated');
  assert.equal(await balanceOf(s, a.id), 200);
  await s.close();
});

test('transfers: recipient name shown first, self/zero/negative/over-balance rejected, both sides recorded with one reference', async () => {
  const s = await start();
  const ad = await admin(s);
  const a = await newCard(ad, { firstName: 'Լիլիթ', lastName: 'Սարգսյան' });
  const b = await newCard(ad); // nameless
  const ha = await holder(s, a.number, a.cvv), hb = await holder(s, b.number, b.cvv);
  const look = await ha.call('/recipient', { method: 'POST', body: { cardNumber: b.number } });
  assert.equal(look.status, 200);
  assert.deepEqual(look.data.recipient, { name: 'Pioneer Member', hasName: false, number: '•••• ' + b.number.slice(4) });
  assert.equal((await hb.call('/recipient', { method: 'POST', body: { cardNumber: a.number } })).data.recipient.name, 'Լիլիթ Սարգսյան');
  assert.equal((await ha.call('/recipient', { method: 'POST', body: { cardNumber: a.number } })).status, 422, 'self lookup');
  assert.equal((await ha.call('/recipient', { method: 'POST', body: { cardNumber: '12' } })).status, 422);
  const send = (amount, k = key(), to = b.number) => ha.call('/transfers', { method: 'POST', body: { cardNumber: to, amount }, headers: { 'Idempotency-Key': k } });
  assert.equal((await send(10, key(), a.number)).data.error.code, 'self_transfer');
  for (const bad of [0, -5, 1.5, '1e3', 'abc', null, 1_000_001]) assert.equal((await send(bad)).status, 422, String(bad));
  const over = await send(201);
  assert.equal(over.status, 422); assert.equal(over.data.error.code, 'insufficient_points');
  assert.equal((await ha.call('/transfers', { method: 'POST', body: { cardNumber: b.number, amount: 5 } })).status, 400, 'Idempotency-Key required');
  const ok = await send(75);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.balance, 125);
  assert.match(ok.data.transfer.reference, /^TR-[A-Z2-9]{10}$/);
  assert.equal(ok.data.transfer.recipient.name, 'Pioneer Member');
  assert.equal(await balanceOf(s, a.id), 125);
  assert.equal(await balanceOf(s, b.id), 275);
  const ta = (await ha.call('/transactions')).data.items, tb = (await hb.call('/transactions')).data.items;
  assert.equal(ta[0].type, 'transfer_out'); assert.equal(ta[0].amount, -75); assert.equal(ta[0].balanceAfter, 125);
  assert.equal(tb[0].type, 'transfer_in'); assert.equal(tb[0].amount, 75); assert.equal(tb[0].counterparty.name, 'Լիլիթ Սարգսյան');
  assert.equal(ta[0].reference, tb[0].reference);
  const me = (await ha.call('/me')).data;
  assert.equal(me.stats.transferred, 75); assert.equal(me.stats.earned, 200);
  assert.equal((await hb.call('/me')).data.stats.received, 75);
  assert.ok(await ledgerConsistent(s));
  await s.close();
});

test('transfers: duplicate submissions do not duplicate; concurrent transfers never overdraw', async () => {
  const s = await start();
  const ad = await admin(s);
  const a = await newCard(ad), b = await newCard(ad), c = await newCard(ad);
  const ha = await holder(s, a.number, a.cvv), hb = await holder(s, b.number, b.cvv);
  const k = key();
  const dup = await Promise.all(Array.from({ length: 6 }, () => ha.call('/transfers', { method: 'POST', body: { cardNumber: b.number, amount: 50 }, headers: { 'Idempotency-Key': k } })));
  assert.ok(dup.every((r) => r.status === 201 || r.status === 200), dup.map((r) => r.status).join());
  assert.equal(dup.filter((r) => r.status === 201).length, 1);
  assert.equal(new Set(dup.map((r) => r.data.transfer.reference)).size, 1);
  assert.equal((await s.q('SELECT COUNT(*)::int AS c FROM pioneer_transfers')).rows[0].c, 1);
  assert.equal(await balanceOf(s, a.id), 150);
  // Same key, different amount -> conflict, nothing happens.
  assert.equal((await ha.call('/transfers', { method: 'POST', body: { cardNumber: b.number, amount: 51 }, headers: { 'Idempotency-Key': k } })).status, 409);
  // 10 parallel transfers of 40 from a balance of 150: at most 3 succeed, never negative.
  const race = await Promise.all(Array.from({ length: 10 }, () => ha.call('/transfers', { method: 'POST', body: { cardNumber: c.number, amount: 40 }, headers: { 'Idempotency-Key': key() } })));
  assert.equal(race.filter((r) => r.status === 201).length, 3);
  assert.ok(race.filter((r) => r.status !== 201).every((r) => r.data.error.code === 'insufficient_points'));
  assert.equal(await balanceOf(s, a.id), 30);
  // Opposite-direction transfers at the same time do not deadlock.
  const cross = await Promise.all([
    ...Array.from({ length: 5 }, () => ha.call('/transfers', { method: 'POST', body: { cardNumber: b.number, amount: 1 }, headers: { 'Idempotency-Key': key() } })),
    ...Array.from({ length: 5 }, () => hb.call('/transfers', { method: 'POST', body: { cardNumber: a.number, amount: 1 }, headers: { 'Idempotency-Key': key() } })),
  ]);
  assert.ok(cross.every((r) => r.status === 201), cross.map((r) => r.status).join());
  const total = (await s.q('SELECT SUM(balance)::int AS t FROM pioneer_cards')).rows[0].t;
  assert.equal(total, 600, 'points are conserved by transfers');
  assert.ok(await ledgerConsistent(s));
  await s.close();
});

test('rewards: admin CRUD, redeem eligible, reject ineligible, idempotent, quota + per-card limit under concurrency, refunds', async () => {
  const s = await start();
  const ad = await admin(s);
  const bad = await ad.call('/rewards', { method: 'POST', body: { title: 'x', pointsCost: 0, discountPercent: 150 } });
  assert.equal(bad.status, 422); assert.deepEqual(Object.keys(bad.data.error.fields).sort(), ['discountPercent', 'pointsCost', 'title']);
  const mk = async (body) => { const r = await ad.call('/rewards', { method: 'POST', body: { title: 'Web Programming', pointsCost: 100, discountPercent: 10, status: 'published', ...body } }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.reward; };
  const course = await mk({});
  const draft = await mk({ title: 'Draft reward', status: 'draft' });
  const pricey = await mk({ title: 'Big reward', pointsCost: 5000 });
  const future = await mk({ title: 'Upcoming', availableFrom: new Date(Date.now() + 86400_000).toISOString() });
  const limited = await mk({ title: 'Limited', pointsCost: 10, maxRedemptions: 3, perCardLimit: 1 });
  const a = await newCard(ad), b = await newCard(ad);
  const ha = await holder(s, a.number, a.cvv);
  const list = (await ha.call('/rewards')).data.items;
  assert.deepEqual(list.map((x) => x.title).sort(), ['Big reward', 'Limited', 'Upcoming', 'Web Programming']);
  assert.equal(list.find((x) => x.id === future.id).upcoming, true);
  assert.equal(list.find((x) => x.id === future.id).available, false);
  const redeem = (id, k = key(), h = ha) => h.call('/redemptions', { method: 'POST', body: { rewardId: id }, headers: { 'Idempotency-Key': k } });
  assert.equal((await redeem(draft.id)).data.error.code, 'reward_unavailable');
  assert.equal((await redeem(future.id)).data.error.code, 'reward_unavailable');
  assert.equal((await redeem(pricey.id)).data.error.code, 'insufficient_points');
  assert.equal((await redeem(999999)).data.error.code, 'reward_unavailable');
  const k = key();
  const twice = await Promise.all([redeem(course.id, k), redeem(course.id, k), redeem(course.id, k)]);
  assert.equal(twice.filter((r) => r.status === 201).length, 1);
  assert.equal(new Set(twice.map((r) => r.data.redemption.reference)).size, 1);
  assert.equal(await balanceOf(s, a.id), 100);
  assert.match(twice[0].data.redemption.reference, /^RD-/);
  assert.equal(twice[0].data.redemption.rewardBenefit, '10% զեղչ');
  // per-card limit = 1 even with parallel requests
  const lim = await Promise.all(Array.from({ length: 4 }, () => redeem(limited.id)));
  assert.equal(lim.filter((r) => r.status === 201).length, 1);
  assert.ok(lim.filter((r) => r.status !== 201).every((r) => r.data.error.code === 'reward_limit'));
  // quota = 3 across cards
  const others = await Promise.all(Array.from({ length: 4 }, () => newCard(ad)));
  const hs = await Promise.all(others.map((c) => holder(s, c.number, c.cvv)));
  const q = await Promise.all(hs.map((h) => redeem(limited.id, key(), h)));
  assert.equal(q.filter((r) => r.status === 201).length, 2);
  assert.ok(q.filter((r) => r.status !== 201).every((r) => r.data.error.code === 'reward_sold_out'));
  // archived rewards cannot be redeemed; rewards with redemptions cannot be hard-deleted
  assert.equal((await ad.call(`/rewards/${course.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await ad.call(`/rewards/${course.id}`, { method: 'PATCH', body: { status: 'archived' } })).status, 200);
  assert.equal((await redeem(course.id)).data.error.code, 'reward_unavailable');
  assert.equal((await ad.call(`/rewards/${draft.id}`, { method: 'DELETE' })).status, 200, 'unused rewards can be deleted');
  // admin: list, fulfil, cancel (refund through the ledger)
  const reds = (await ad.call('/redemptions?status=pending')).data.items;
  assert.ok(reds.length >= 4);
  const mine = reds.filter((r) => r.cardId === a.id);
  assert.equal((await ad.call(`/redemptions/${mine[0].id}/status`, { method: 'POST', body: { status: 'cancelled', note: 'test' } })).status, 200);
  assert.equal((await ad.call(`/redemptions/${mine[0].id}/status`, { method: 'POST', body: { status: 'fulfilled' } })).status, 409, 'handled once');
  assert.equal((await ad.call(`/redemptions/${mine[1].id}/status`, { method: 'POST', body: { status: 'fulfilled' } })).status, 200);
  const back = mine[0].points;
  assert.equal(await balanceOf(s, a.id), 90 + back);
  assert.equal((await ha.call('/redemptions')).data.items.length, 2);
  assert.equal((await ha.call('/me')).data.stats.spent, 110 - back);
  assert.equal((await redeem(999, key(), await holder(s, b.number, b.cvv))).status, 422);
  assert.ok(await ledgerConsistent(s));
  await s.close();
});

test('admin adjustments: mandatory reason, admin identity, cannot overdraw; the ledger is the only way to change a balance', async () => {
  const s = await start();
  const ad = await admin(s);
  const c = await newCard(ad);
  assert.equal((await ad.call(`/cards/${c.id}/adjust`, { method: 'POST', body: { amount: 50 } })).status, 422, 'reason required');
  assert.equal((await ad.call(`/cards/${c.id}/adjust`, { method: 'POST', body: { amount: 0, reason: 'zero' } })).status, 422);
  assert.equal((await ad.call(`/cards/${c.id}/adjust`, { method: 'POST', body: { amount: -201, reason: 'too much' } })).status, 422);
  assert.equal((await ad.call(`/cards/${c.id}/adjust`, { method: 'POST', body: { amount: 50, reason: 'Hackathon winner' } })).data.card.balance, 250);
  assert.equal((await ad.call(`/cards/${c.id}/adjust`, { method: 'POST', body: { amount: '-30', reason: 'Correction of duplicate award' } })).data.card.balance, 220);
  const tx = (await ad.call(`/cards/${c.id}/transactions`)).data.items;
  assert.deepEqual(tx.map((t) => [t.type, t.amount, t.balanceAfter, t.admin]), [['admin_debit', -30, 220, 'magical'], ['admin_credit', 50, 250, 'magical'], ['initial_bonus', 200, 200, null]]);
  assert.equal(tx[1].description, 'Hackathon winner');
  // Direct SQL cannot bypass the ledger, and ledger rows are immutable.
  await assert.rejects(s.q('UPDATE pioneer_cards SET balance = 99999 WHERE id = $1', [c.id]), /only change through pioneer_transactions/);
  await assert.rejects(s.q("INSERT INTO pioneer_cards (card_no, cvv_hash, search_text, balance) VALUES ('12121212', 'x', 'x', 500)"), /start at 0/);
  await assert.rejects(s.q('UPDATE pioneer_transactions SET amount = 1'), /append-only/);
  await assert.rejects(s.q('DELETE FROM pioneer_transactions'), /append-only/);
  await assert.rejects(s.q("INSERT INTO pioneer_transactions (card_id, type, amount) VALUES ($1, 'admin_debit', -999)", [c.id]), (e) => e.code === '23514');
  assert.equal(await balanceOf(s, c.id), 220);
  const log = (await ad.call('/audit')).data.items;
  assert.deepEqual(log.filter((x) => x.action === 'points.adjust').map((x) => [x.admin, x.details.amount]), [['magical', -30], ['magical', 50]]);
  const ledger = await ad.call(`/transactions?type=admin_credit&card=${c.number}`);
  assert.equal(ledger.data.total, 1);
  assert.ok(await ledgerConsistent(s));
  await s.close();
});

test('initial bonus is configurable and applies to new cards only', async () => {
  const s = await start();
  const ad = await admin(s);
  const before = await newCard(ad);
  assert.equal((await ad.call('/settings', { method: 'PUT', body: { initialBonus: -1 } })).status, 422);
  assert.equal((await ad.call('/settings', { method: 'PUT', body: { initialBonus: 300 } })).data.initialBonus, 300);
  const after = await newCard(ad);
  assert.equal(after.balance, 300);
  assert.equal(await balanceOf(s, before.id), 200);
  await ad.call('/settings', { method: 'PUT', body: { initialBonus: 0 } });
  assert.equal((await newCard(ad)).balance, 0);
  await s.close();
});

test('printable card PDF has the exact ID-1 card size (85.60 x 53.98 mm)', async () => {
  const s = await start();
  const ad = await admin(s);
  const c = await newCard(ad);
  const r = await ad.call(`/cards/${c.id}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const text = r.data.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.7'));
  const [, w, h] = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text);
  assert.ok(Math.abs((Number(w) * 25.4) / 72 - 85.6) < 0.01, `width ${w}pt`);
  assert.ok(Math.abs((Number(h) * 25.4) / 72 - 53.98) < 0.01, `height ${h}pt`);
  assert.equal((text.match(/\/Type \/Page /g) || []).length, 1);
  await s.close();
});

test('announcements: only published ones reach cardholders', async () => {
  const s = await start();
  const ad = await admin(s);
  const c = await newCard(ad);
  const h = await holder(s, c.number, c.cvv);
  assert.deepEqual((await h.call('/announcements')).data.items, []);
  const d = await ad.call('/announcements', { method: 'POST', body: { title: 'Draft news', body: 'x' } });
  const p = await ad.call('/announcements', { method: 'POST', body: { title: 'Open day', body: 'Details soon', status: 'published' } });
  assert.equal(d.status, 201); assert.equal(p.status, 201);
  assert.deepEqual((await h.call('/announcements')).data.items.map((x) => x.title), ['Open day']);
  await ad.call(`/announcements/${p.data.announcement.id}`, { method: 'PATCH', body: { status: 'archived' } });
  assert.deepEqual((await h.call('/announcements')).data.items, []);
  await s.close();
});

test('gift card: issued once on approval, owner-only, no second deduction, never for pending/cancelled', async () => {
  const s = await start();
  const ad = await admin(s);
  const rw = (await ad.call('/rewards', { method: 'POST', body: { title: 'Վեբ ծրագրավորում', pointsCost: 50, discountPercent: 20, status: 'published' } })).data.reward;
  const a = await newCard(ad, { firstName: 'Աննա', lastName: 'Գրիգորյան' }), b = await newCard(ad);
  const ha = await holder(s, a.number, a.cvv), hb = await holder(s, b.number, b.cvv);
  const redeem = () => ha.call('/redemptions', { method: 'POST', body: { rewardId: rw.id }, headers: { 'Idempotency-Key': key() } });
  const r1 = (await redeem()).data.redemption, r2 = (await redeem()).data.redemption, r3 = (await redeem()).data.redemption;
  assert.equal(await balanceOf(s, a.id), 50);
  const mineNow = async () => Object.fromEntries((await ha.call('/redemptions')).data.items.map((x) => [x.reference, x]));

  // pending: no gift card anywhere
  assert.equal(r1.status, 'pending'); assert.equal(r1.giftCard, null);
  assert.equal((await mineNow())[r1.reference].giftCard, null);
  assert.equal((await s.q('SELECT COUNT(*)::int AS c FROM pioneer_redemptions WHERE gift_code IS NOT NULL')).rows[0].c, 0);

  // approve: parallel + repeated approvals produce exactly one code, one audit entry, no ledger change
  const status = (id, st) => ad.call(`/redemptions/${id}/status`, { method: 'POST', body: { status: st } });
  const ap = await Promise.all([status(r1.id, 'approved'), status(r1.id, 'approved'), status(r1.id, 'approved')]);
  assert.ok(ap.every((x) => x.status === 200), ap.map((x) => x.status).join());
  const code = ap[0].data.redemption.giftCard.code;
  assert.match(code, /^MG-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(ap.every((x) => x.data.redemption.giftCard.code === code));
  assert.equal((await status(r1.id, 'approved')).data.redemption.giftCard.code, code, 'retry returns the same card');
  assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_audit_log WHERE action = 'redemption.approve'")).rows[0].c, 1);
  assert.equal(await balanceOf(s, a.id), 50, 'approval never deducts again');
  assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_transactions WHERE card_id = $1 AND type = 'redemption'", [a.id])).rows[0].c, 3);

  // owner sees it; another cardholder does not; there is no by-id route to guess
  const g = (await mineNow())[r1.reference];
  assert.equal(g.status, 'approved');
  assert.deepEqual(Object.keys(g.giftCard).sort(), ['approvedAt', 'code', 'collectedAt', 'state']);
  assert.equal(g.giftCard.code, code); assert.equal(g.giftCard.state, 'ready'); assert.ok(g.giftCard.approvedAt);
  const other = await hb.call('/redemptions');
  assert.equal(other.status, 200); assert.equal(other.data.items.length, 0);
  assert.ok(!JSON.stringify(other.data).includes(code));
  assert.equal((await hb.call(`/redemptions/${r1.id}`)).status, 404);
  assert.equal((await s.api('/api/pioneer/redemptions')).status, 401);

  // admins can find the request by gift code (with or without dashes)
  for (const q of [code, code.replace(/-/g, '').toLowerCase()]) {
    const found = (await ad.call('/redemptions?' + new URLSearchParams({ q }))).data.items;
    assert.deepEqual(found.map((x) => x.reference), [r1.reference], q);
  }
  assert.equal((await ad.call('/redemptions?status=approved')).data.items.length, 1);
  assert.equal((await ad.call('/stats')).data.approvedRedemptions, 1);

  // hand over: separate action; the card turns into "collected"; cannot go back to approved
  assert.equal((await status(r1.id, 'fulfilled')).status, 200);
  const c1 = (await mineNow())[r1.reference];
  assert.equal(c1.giftCard.state, 'collected'); assert.equal(c1.giftCard.code, code); assert.ok(c1.giftCard.collectedAt);
  assert.equal((await status(r1.id, 'approved')).status, 409);
  assert.equal((await status(r1.id, 'cancelled')).status, 409);

  // cancelled (from pending, and after approval): no gift card, refunded exactly once
  assert.equal((await status(r2.id, 'cancelled')).status, 200);
  assert.equal((await status(r3.id, 'approved')).status, 200);
  assert.equal((await status(r3.id, 'cancelled')).status, 200);
  assert.equal((await status(r3.id, 'cancelled')).status, 200, 'repeated cancel is a no-op');
  const after = await mineNow();
  assert.equal(after[r2.reference].giftCard, null); assert.equal(after[r3.reference].giftCard, null);
  assert.equal(await balanceOf(s, a.id), 150);
  assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_transactions WHERE card_id = $1 AND type = 'redemption_refund'", [a.id])).rows[0].c, 2);
  assert.equal((await status(r2.id, 'approved')).status, 409, 'a cancelled request cannot get a card');

  // pending -> fulfilled (older clients) still works and also issues a code
  const r4 = (await redeem()).data.redemption;
  const f4 = await status(r4.id, 'fulfilled');
  assert.equal(f4.status, 200); assert.equal(f4.data.redemption.giftCard.state, 'collected');
  assert.equal((await status(r4.id, 'bogus')).status, 422);
  assert.equal((await status(r4.id, 'constructor')).status, 422);
  // database guarantees: unique codes, approved rows always carry one
  await assert.rejects(s.q('UPDATE pioneer_redemptions SET gift_code = $1, approved_at = now() WHERE id = $2', [code, r2.id]), /gift_code_key|unique/);
  await assert.rejects(s.q("UPDATE pioneer_redemptions SET status = 'approved' WHERE id = $1", [r2.id]), /approved_has_gift/);
  assert.ok(await ledgerConsistent(s));
  await s.close();
});


test('gift card migration keeps existing redemption requests and statuses unchanged', async () => {
  const s = await start();
  const ad = await admin(s);
  const rw = (await ad.call('/rewards', { method: 'POST', body: { title: 'Course', pointsCost: 10, status: 'published' } })).data.reward;
  const a = await newCard(ad), ha = await holder(s, a.number, a.cvv);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await ha.call('/redemptions', { method: 'POST', body: { rewardId: rw.id }, headers: { 'Idempotency-Key': key() } })).data.redemption.id);
  await s.close();
  const url = await verifyTestDatabase();
  const p = createPool(loadConfig({ NODE_ENV: 'test', APP_SECRET: 's'.repeat(40), DATABASE_URL: url }));
  try {
    // Roll the test database back to "002 only" with requests in every old status, then upgrade.
    await p.query(`ALTER TABLE pioneer_redemptions DROP CONSTRAINT pioneer_redemptions_approved_has_gift, DROP CONSTRAINT pioneer_redemptions_gift_issued,
      DROP CONSTRAINT pioneer_redemptions_gift_code_format, DROP CONSTRAINT pioneer_redemptions_gift_code_key, DROP COLUMN gift_code, DROP COLUMN approved_at, DROP COLUMN approved_by,
      DROP CONSTRAINT pioneer_redemptions_status_check, ADD CONSTRAINT pioneer_redemptions_status_check CHECK (status IN ('pending','fulfilled','cancelled'))`);
    await p.query("DELETE FROM schema_migrations WHERE version = '003_pioneer_gift_card.sql'");
    await p.query("UPDATE pioneer_redemptions SET status = 'fulfilled', handled_at = now() WHERE id = $1", [ids[0]]);
    await p.query("UPDATE pioneer_redemptions SET status = 'cancelled', handled_at = now() WHERE id = $1", [ids[1]]);
    const snap = async () => (await p.query('SELECT id, reference, card_id, reward_id, points, status, handled_at, created_at FROM pioneer_redemptions ORDER BY id')).rows;
    const before = await snap(), bal = (await p.query('SELECT balance FROM pioneer_cards WHERE id = $1', [a.id])).rows[0].balance;
    assert.deepEqual(await migrate(p), ['003_pioneer_gift_card.sql']);
    assert.deepEqual(await migrate(p), []);
    assert.deepEqual(await snap(), before);
    assert.equal((await p.query('SELECT COUNT(*)::int AS c FROM pioneer_redemptions WHERE gift_code IS NOT NULL OR approved_at IS NOT NULL')).rows[0].c, 0);
    assert.equal((await p.query('SELECT balance FROM pioneer_cards WHERE id = $1', [a.id])).rows[0].balance, bal);
  } finally { await p.end(); }
});
