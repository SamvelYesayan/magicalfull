import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';
import { generateKey, hashKey } from '../server/integration.js';

const B = '/api/integration/v1';
const A = '/api/admin/pioneer';

async function admin(s) {
  const l = await s.login();
  return (path, opts = {}) => s.api(A + path, { cookie: l.cookie, csrf: l.csrf, ...opts });
}
async function newCard(ad, holder = {}) {
  const r = await ad('/cards', { method: 'POST', body: holder });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...r.data.card, cvv: r.data.cvv };
}
const wrongCvv = (cvv) => String((Number(cvv) + 1) % 1000).padStart(3, '0');
async function client(s, name = 'christmas-store', scopes = ['cards:verify', 'cards:link', 'cards:read', 'rewards:read']) {
  const k = generateKey();
  await s.q('INSERT INTO integration_clients (name, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4)', [name, k.prefix, k.hash, scopes]);
  const call = (path, opts = {}) => s.api(B + path, { ...opts, headers: { Authorization: `Bearer ${k.key}`, ...(opts.headers || {}) } });
  return { key: k.key, call };
}
// No response may ever carry a CVV, its hash or the admin-only phone number.
const assertNoSecrets = (data, card) => {
  const j = JSON.stringify(data);
  for (const bad of ['cvv', 'Cvv', 'cvv_hash', 'scrypt$', 'phone', card?.cvv && `"${card.cvv}"`].filter(Boolean)) assert.ok(!j.includes(bad), `response leaks ${bad}: ${j}`);
};

test('integration auth: Bearer API key required, revoked/unknown keys refused, scopes enforced, browsers refused', async () => {
  const s = await start();
  const c = await client(s);
  assert.equal((await s.api(B + '/me')).status, 401);
  for (const h of ['Bearer nope', 'Basic abc', `Bearer ${'mgpc_' + 'A'.repeat(43)}`, `Token ${c.key}`])
    assert.equal((await s.api(B + '/me', { headers: { Authorization: h } })).status, 401, h);
  const me = await c.call('/me');
  assert.equal(me.status, 200); assert.equal(me.data.client.name, 'christmas-store');
  assert.equal(me.headers.get('cache-control'), 'no-store');
  // key stored only as a hash
  const row = (await s.q('SELECT key_hash, key_prefix FROM integration_clients')).rows[0];
  assert.equal(row.key_hash, hashKey(c.key)); assert.ok(!JSON.stringify(row).includes(c.key));
  // browser requests (any Origin header) are refused and get no CORS headers, even for an allowed origin
  const br = await c.call('/me', { headers: { Origin: 'https://shop.example' } });
  assert.equal(br.status, 403); assert.equal(br.data.error.code, 'browser_requests_not_allowed');
  const s2 = await start({ allowedOrigins: ['https://shop.example'] });
  const c2 = await client(s2);
  const br2 = await c2.call('/me', { headers: { Origin: 'https://shop.example' } });
  assert.equal(br2.status, 403); assert.equal(br2.headers.get('access-control-allow-origin'), null);
  await s2.close();
  // scope enforcement
  const ro = await client(s, 'read-only', ['rewards:read']);
  assert.equal((await ro.call('/rewards')).status, 200);
  const denied = await ro.call('/cards/verify', { method: 'POST', body: { cardNumber: '12345678', cvv: '123' } });
  assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'insufficient_scope');
  // revoked key stops working at once
  await s.q("UPDATE integration_clients SET status = 'revoked', revoked_at = now() WHERE name = 'christmas-store'");
  assert.equal((await c.call('/me')).status, 401);
  await s.close();
});

test('card verification: valid / invalid result, never echoes the code, shares the website lockout', async () => {
  const s = await start();
  const ad = await admin(s), c = await client(s);
  const card = await newCard(ad, { firstName: 'Աննա', lastName: 'Գրիգորյան', phone: '+374 77 123456' });
  const ok = await c.call('/cards/verify', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { valid: true, card: { number: '•••• ' + card.number.slice(4), last4: card.number.slice(4), firstName: 'Աննա', lastName: 'Գրիգորյան', displayName: 'Աննա Գրիգորյան', status: 'active', memberSince: ok.data.card.memberSince, linked: false } });
  assertNoSecrets(ok.data, card);
  // formatted input is accepted like on the website
  assert.equal((await c.call('/cards/verify', { method: 'POST', body: { cardNumber: `${card.number.slice(0, 4)} ${card.number.slice(4)}`, cvv: card.cvv } })).data.valid, true);
  const bad = await c.call('/cards/verify', { method: 'POST', body: { cardNumber: card.number, cvv: wrongCvv(card.cvv) } });
  assert.equal(bad.status, 200); assert.deepEqual(bad.data, { valid: false, reason: 'invalid_credentials', attemptsBeforeLock: 2 });
  const unknown = await c.call('/cards/verify', { method: 'POST', body: { cardNumber: '99999999', cvv: '123' } });
  assert.deepEqual(unknown.data, { valid: false, reason: 'invalid_credentials', attemptsBeforeLock: 2 }, 'unknown numbers look exactly like wrong codes');
  const v = await c.call('/cards/verify', { method: 'POST', body: { cardNumber: '123', cvv: 'abc' } });
  assert.equal(v.status, 422); assert.deepEqual(Object.keys(v.data.error.fields).sort(), ['cardNumber', 'cvv']);
  assert.equal((await c.call('/cards/verify', { method: 'POST', body: 'x', raw: true, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  // two more wrong codes through the API lock the number for the website login too (one shared budget)
  await c.call('/cards/verify', { method: 'POST', body: { cardNumber: card.number, cvv: wrongCvv(card.cvv) } });
  await c.call('/cards/verify', { method: 'POST', body: { cardNumber: card.number, cvv: wrongCvv(card.cvv) } });
  const locked = await c.call('/cards/verify', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } });
  assert.equal(locked.status, 429); assert.equal(locked.data.error.code, 'too_many_attempts'); assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } })).status, 429, 'website login is locked as well');
  // after an admin unlock both work again
  await ad(`/cards/${card.id}/unlock`, { method: 'POST', body: {} });
  assert.equal((await c.call('/cards/verify', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } })).data.valid, true);
  assert.equal((await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } })).status, 200);
  await s.close();
});

test('card linking: proof of ownership, one account per card, one card per customer, unlink keeps history', async () => {
  const s = await start();
  const ad = await admin(s), c = await client(s), other = await client(s, 'other-shop');
  const a = await newCard(ad, { firstName: 'Արամ' }), b = await newCard(ad);
  const link = (cl, customerId, card, cvv = card.cvv) => cl.call('/links', { method: 'POST', body: { customerId, cardNumber: card.number, cvv } });
  assert.equal((await link(c, 'bad id with spaces', a)).status, 422);
  const wrong = await link(c, 'cust-1', a, wrongCvv(a.cvv));
  assert.equal(wrong.status, 422); assert.equal(wrong.data.error.code, 'invalid_card_credentials');
  const first = await link(c, 'cust-1', a);
  assert.equal(first.status, 201);
  assert.equal(first.data.link.customerId, 'cust-1'); assert.equal(first.data.link.balance, 200); assert.equal(first.data.link.card.displayName, 'Արամ');
  assertNoSecrets(first.data, a);
  assert.equal((await link(c, 'cust-1', a)).status, 200, 'repeating the same link is idempotent');
  const taken = await link(c, 'cust-2', a);
  assert.equal(taken.status, 409); assert.equal(taken.data.error.code, 'card_already_linked');
  const takenOther = await link(other, 'someone', a);
  assert.equal(takenOther.status, 409); assert.equal(takenOther.data.error.code, 'card_already_linked', 'a card can be linked to only one external account across all clients');
  const second = await link(c, 'cust-1', b);
  assert.equal(second.status, 409); assert.equal(second.data.error.code, 'customer_already_linked');
  // another client cannot read this client's customers
  assert.equal((await other.call('/customers/cust-1/card')).status, 404);
  // verify now reports the card as linked
  assert.equal((await c.call('/cards/verify', { method: 'POST', body: { cardNumber: a.number, cvv: a.cvv } })).data.card.linked, true);
  // unlink, then the card is free again; the old row stays as history
  assert.equal((await c.call('/customers/cust-1/link', { method: 'DELETE' })).status, 200);
  assert.equal((await c.call('/customers/cust-1/card')).status, 404);
  assert.equal((await c.call('/customers/cust-1/link', { method: 'DELETE' })).status, 404);
  assert.equal((await link(other, 'someone', a)).status, 201);
  assert.deepEqual((await s.q('SELECT status, unlinked_by FROM pioneer_card_links ORDER BY id')).rows, [{ status: 'unlinked', unlinked_by: 'client' }, { status: 'active', unlinked_by: null }]);
  // deactivated cards cannot be linked
  await ad(`/cards/${b.id}/status`, { method: 'POST', body: { status: 'inactive' } });
  const inactive = await link(c, 'cust-3', b);
  assert.equal(inactive.status, 403); assert.equal(inactive.data.error.code, 'card_inactive');
  await s.close();
});

test('card linking under concurrency: parallel attempts for one card create exactly one link', async () => {
  const s = await start();
  const ad = await admin(s), c = await client(s);
  const card = await newCard(ad);
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => c.call('/links', { method: 'POST', body: { customerId: 'race-' + i, cardNumber: card.number, cvv: card.cvv } })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
  // the others are refused as already linked, or briefly locked: the shared lockout counts every attempt before checking it
  assert.ok(rs.every((r) => r.status === 201 || (r.status === 409 && r.data.error.code === 'card_already_linked') || (r.status === 429 && r.data.error.code === 'too_many_attempts')), JSON.stringify(rs.map((r) => r.data.error?.code)));
  assert.equal((await s.q("SELECT COUNT(*)::int AS n FROM pioneer_card_links WHERE status = 'active'")).rows[0].n, 1);
  await s.close();
});

test('card info, balance and transaction history follow the real ledger', async () => {
  const s = await start();
  const ad = await admin(s), c = await client(s);
  const card = await newCard(ad, { phone: '+374 77 123456' });
  const other = await newCard(ad);
  await c.call('/links', { method: 'POST', body: { customerId: 'cust-1', cardNumber: card.number, cvv: card.cvv } });
  await ad(`/cards/${card.id}/adjust`, { method: 'POST', body: { amount: 55, reason: 'Christmas gift' } });
  await ad(`/cards/${card.id}/adjust`, { method: 'POST', body: { amount: -5, reason: 'Correction' } });
  const h = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } });
  const cookie = h.headers.get('set-cookie').split(';')[0];
  assert.equal((await s.api('/api/pioneer/transfers', { method: 'POST', cookie, csrf: h.data.csrfToken, headers: { 'Idempotency-Key': 'transfer-key-' + Date.now() }, body: { cardNumber: other.number, amount: 30 } })).status, 201);
  const info = await c.call('/customers/cust-1/card');
  assert.equal(info.status, 200);
  assert.equal(info.data.link.balance, 220); assert.equal(info.data.link.card.status, 'active'); assert.equal(info.data.link.card.displayName, 'Pioneer Member');
  assertNoSecrets(info.data, card);
  const tx = await c.call('/customers/cust-1/transactions?pageSize=2');
  assert.equal(tx.status, 200); assert.equal(tx.data.balance, 220); assert.equal(tx.data.total, 4); assert.equal(tx.data.items.length, 2);
  assert.deepEqual(tx.data.items.map((t) => [t.type, t.amount, t.balanceAfter]), [['transfer_out', -30, 220], ['admin_debit', -5, 250]]);
  assert.match(tx.data.items[0].createdAt, /^\d{4}-\d\d-\d\dT/); assert.ok(tx.data.items[0].label);
  const all = (await c.call('/customers/cust-1/transactions?page=2&pageSize=2')).data.items;
  assert.deepEqual(all.map((t) => [t.type, t.amount]), [['admin_credit', 55], ['initial_bonus', 200]]);
  assert.equal(all[0].description, 'Christmas gift');
  assert.ok(!JSON.stringify(tx.data).includes(other.number.slice(4)), 'counterparty card numbers are not exposed');
  // deactivation shows up in the status
  await ad(`/cards/${card.id}/status`, { method: 'POST', body: { status: 'inactive' } });
  assert.equal((await c.call('/customers/cust-1/card')).data.link.card.status, 'inactive');
  assert.equal((await c.call('/customers/does-not-exist/card')).status, 404);
  await s.close();
});

test('rewards: public catalog, per-card eligibility with reasons, single-reward check', async () => {
  const s = await start();
  const ad = await admin(s), c = await client(s);
  const mk = async (body) => (await ad('/rewards', { method: 'POST', body: { title: 'Web Programming', pointsCost: 100, discountPercent: 10, status: 'published', ...body } })).data.reward;
  const cheap = await mk({ title: 'Cheap', pointsCost: 50 });
  const pricey = await mk({ title: 'Pricey', pointsCost: 5000 });
  await mk({ title: 'Draft', status: 'draft' });
  const future = await mk({ title: 'Upcoming', availableFrom: new Date(Date.now() + 86400_000).toISOString() });
  const once = await mk({ title: 'Once', pointsCost: 10, perCardLimit: 1 });
  const catalog = await c.call('/rewards');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.items.map((r) => r.title).sort(), ['Cheap', 'Once', 'Pricey', 'Upcoming']);
  assert.equal(catalog.data.items.find((r) => r.id === pricey.id).pointsCost, 5000);
  const card = await newCard(ad);
  await c.call('/links', { method: 'POST', body: { customerId: 'cust-1', cardNumber: card.number, cvv: card.cvv } });
  // redeem "Once" on the website so the per-card limit is reached
  const h = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } });
  const cookie = h.headers.get('set-cookie').split(';')[0];
  assert.equal((await s.api('/api/pioneer/redemptions', { method: 'POST', cookie, csrf: h.data.csrfToken, headers: { 'Idempotency-Key': 'redeem-key-' + Date.now() }, body: { rewardId: once.id } })).status, 201);
  const mine = await c.call('/customers/cust-1/rewards');
  assert.equal(mine.status, 200); assert.equal(mine.data.balance, 190);
  const by = (id) => mine.data.items.find((r) => r.id === id);
  assert.deepEqual([by(cheap.id).eligible, by(cheap.id).reasons], [true, []]);
  assert.deepEqual([by(pricey.id).eligible, by(pricey.id).reasons, by(pricey.id).shortfall], [false, ['insufficient_points'], 4810]);
  assert.deepEqual(by(future.id).reasons, ['not_yet_available']);
  assert.deepEqual(by(once.id).reasons, ['per_card_limit_reached']);
  const e1 = await c.call(`/customers/cust-1/rewards/${pricey.id}/eligibility`);
  assert.deepEqual(e1.data, { rewardId: pricey.id, title: 'Pricey', pointsCost: 5000, balance: 190, eligible: false, affordable: false, shortfall: 4810, reasons: ['insufficient_points'] });
  assert.equal((await c.call(`/customers/cust-1/rewards/${cheap.id}/eligibility`)).data.eligible, true);
  assert.equal((await c.call('/customers/cust-1/rewards/999999/eligibility')).status, 404);
  assert.equal((await c.call('/customers/cust-1/rewards/abc/eligibility')).status, 404);
  await ad(`/cards/${card.id}/status`, { method: 'POST', body: { status: 'inactive' } });
  assert.deepEqual((await c.call(`/customers/cust-1/rewards/${cheap.id}/eligibility`)).data.reasons, ['card_inactive']);
  await s.close();
});

test('request log records client, route and status, but never keys, card numbers or codes', async () => {
  const s = await start();
  const ad = await admin(s), c = await client(s);
  const card = await newCard(ad);
  await c.call('/cards/verify', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } });
  await c.call('/links', { method: 'POST', body: { customerId: 'cust-1', cardNumber: card.number, cvv: wrongCvv(card.cvv) } });
  await s.api(B + '/me', { headers: { Authorization: 'Bearer wrong' } });
  const rows = (await s.q('SELECT * FROM integration_request_log ORDER BY id')).rows;
  assert.deepEqual(rows.map((r) => [r.method, r.route, r.status, r.error_code, r.client_id !== null]), [
    ['POST', '/api/integration/v1/cards/verify', 200, null, true],
    ['POST', '/api/integration/v1/links', 422, 'invalid_card_credentials', true],
    ['GET', '/api/integration/v1/me', 401, 'invalid_api_key', false],
  ]);
  const dump = JSON.stringify(rows);
  for (const secret of [c.key, card.number, `"${card.cvv}"`]) assert.ok(!dump.includes(secret), 'log leaks ' + secret);
  await s.close();
});

test('integration rate limits and HTTPS requirement', async () => {
  const s = await start({ rateLimits: true });
  const codes = [];
  for (let i = 0; i < 32; i++) codes.push((await s.api(B + '/me', { headers: { Authorization: 'Bearer bad' } })).status);
  assert.equal(codes.filter((x) => x === 401).length, 30); assert.equal(codes.at(-1), 429);
  await s.close();
  const h = await start({ integrationRequireHttps: true, trustProxy: true });
  const c = await client(h);
  const plain = await c.call('/me');
  assert.equal(plain.status, 403); assert.equal(plain.data.error.code, 'https_required');
  assert.equal((await c.call('/me', { headers: { 'X-Forwarded-Proto': 'https' } })).status, 200);
  await h.close();
});
