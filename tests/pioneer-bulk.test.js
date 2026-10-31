import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

const A = '/api/admin/pioneer';
const key = () => 'k' + Math.random().toString(36).slice(2).padEnd(12, 'x') + Date.now().toString(36);

async function admin(s) {
  const l = await s.login();
  return { ...l, call: (path, opts = {}) => s.api(A + path, { cookie: l.cookie, csrf: l.csrf, ...opts }) };
}
async function newCard(ad, holder = {}) {
  const r = await ad.call('/cards', { method: 'POST', body: holder });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...r.data.card, cvv: r.data.cvv };
}
async function holder(s, number, cvv) {
  const r = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: number, cvv } });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { cookie, call: (path, opts = {}) => s.api('/api/pioneer' + path, { cookie, csrf: r.data.csrfToken, ...opts }) };
}
const preview = (ad, body) => ad.call('/cards/bulk-preview', { method: 'POST', body });
const retire = (ad, body, p) => ad.call('/cards/bulk-retire', { method: 'POST', body: { ...body, token: p.token, confirmCount: p.cards.selected } });
// everything that must survive a retire untouched
const history = async (s) => ({
  balances: (await s.q('SELECT id, balance FROM pioneer_cards ORDER BY id')).rows,
  ledger: (await s.q('SELECT id, card_id, type, amount, balance_after, counterparty_card_id, transfer_id, redemption_id FROM pioneer_transactions ORDER BY id')).rows,
  transfers: (await s.q('SELECT * FROM pioneer_transfers ORDER BY id')).rows,
  redemptions: (await s.q('SELECT * FROM pioneer_redemptions ORDER BY id')).rows,
  cards: (await s.q('SELECT id, card_no, cvv_hash, first_name, last_name, phone FROM pioneer_cards ORDER BY id')).rows,
});
const statusOf = async (s) => Object.fromEntries((await s.q('SELECT id, status FROM pioneer_cards ORDER BY id')).rows.map((r) => [r.id, r.status]));

// a small world: a <-> b transfers, a has an approved gift card and a pending request, c and d untouched
async function world(s, ad) {
  const a = await newCard(ad, { firstName: 'Anna' }), b = await newCard(ad, { firstName: 'Boris' }), c = await newCard(ad, { firstName: 'Cara' }), d = await newCard(ad, { firstName: 'Dina' });
  const ha = await holder(s, a.number, a.cvv), hb = await holder(s, b.number, b.cvv);
  assert.equal((await ha.call('/transfers', { method: 'POST', body: { cardNumber: b.number, amount: 30 }, headers: { 'Idempotency-Key': key() } })).status, 201);
  assert.equal((await hb.call('/transfers', { method: 'POST', body: { cardNumber: a.number, amount: 5 }, headers: { 'Idempotency-Key': key() } })).status, 201);
  const rw = (await ad.call('/rewards', { method: 'POST', body: { title: 'Course', pointsCost: 20, discountPercent: 10, status: 'published' } })).data.reward;
  const r1 = (await ha.call('/redemptions', { method: 'POST', body: { rewardId: rw.id }, headers: { 'Idempotency-Key': key() } })).data.redemption;
  await ha.call('/redemptions', { method: 'POST', body: { rewardId: rw.id }, headers: { 'Idempotency-Key': key() } });
  assert.equal((await ad.call(`/redemptions/${r1.id}/status`, { method: 'POST', body: { status: 'approved' } })).status, 200);
  return { a, b, c, d, ha, hb };
}

test('bulk retire: admin session + CSRF required; cardholders and anonymous callers are refused', async () => {
  const s = await start();
  const ad = await admin(s);
  const a = await newCard(ad);
  for (const p of ['/cards/bulk-preview', '/cards/bulk-retire']) {
    assert.equal((await s.api(A + p, { method: 'POST', body: { ids: [a.id] } })).status, 401, p);
    assert.equal((await s.api(A + p, { method: 'POST', body: { ids: [a.id] }, cookie: ad.cookie })).status, 403, `${p} needs CSRF`);
  }
  const h = await holder(s, a.number, a.cvv);
  assert.equal((await s.api(A + '/cards/bulk-retire', { method: 'POST', body: { all: true }, cookie: h.cookie })).status, 401, 'cardholder session is not an admin session');
  assert.equal((await statusOf(s))[a.id], 'active');
  await s.close();
});

test('bulk retire: ids are validated server-side; unknown, duplicate, malformed and empty selections change nothing', async () => {
  const s = await start();
  const ad = await admin(s);
  const a = await newCard(ad);
  for (const body of [{}, { ids: [] }, { ids: ['x'] }, { ids: [a.id, a.id] }, { ids: [-1] }, { ids: [1.5] }, { ids: 'all' }, { ids: Array.from({ length: 5001 }, (_, i) => i + 1) }])
    assert.equal((await preview(ad, body)).status, 422, JSON.stringify(body).slice(0, 40));
  const ghost = await preview(ad, { ids: [a.id, 999999] });
  assert.equal(ghost.status, 404); assert.match(ghost.data.error.fields.ids, /999999/);
  const p = (await preview(ad, { ids: [a.id] })).data;
  assert.equal((await ad.call('/cards/bulk-retire', { method: 'POST', body: { ids: [a.id, 999999], token: p.token, confirmCount: 2 } })).status, 404);
  assert.equal((await ad.call('/cards/bulk-retire', { method: 'POST', body: { ids: [a.id], token: 'forged', confirmCount: 1 } })).status, 409, 'token required');
  assert.equal((await ad.call('/cards/bulk-retire', { method: 'POST', body: { ids: [a.id], token: p.token, confirmCount: 2 } })).status, 422, 'typed count must match');
  assert.equal((await ad.call('/cards/bulk-retire', { method: 'POST', body: { ids: [a.id], token: p.token } })).status, 422);
  assert.equal((await statusOf(s))[a.id], 'active');
  assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_audit_log WHERE action LIKE 'cards.bulk%' OR (action = 'card.deactivate')")).rows[0].c, 0);
  await s.close();
});

test('bulk preview: counts every related record; permanent deletion blocked; opening and cancelling changes nothing', async () => {
  const s = await start();
  const ad = await admin(s);
  const { a, b, c } = await world(s, ad);
  const before = await history(s), st = await statusOf(s);
  const p = await preview(ad, { ids: [a.id, c.id] });
  assert.equal(p.status, 200);
  const d = p.data;
  assert.deepEqual(d.cards, { selected: 2, active: 2, alreadyInactive: 0, withBalance: 2, balanceTotal: 200 - 30 + 5 - 40 + 200 });
  assert.equal(d.history.transfers, 2, 'a<->b, both directions');
  assert.equal(d.history.transfersWithOtherCards, 2, 'b is not selected');
  assert.equal(d.history.otherCardsHistoryRefs, 2, "b's ledger rows name a as counterparty");
  assert.deepEqual(d.history.redemptions, { pending: 1, approved: 1, fulfilled: 0, cancelled: 0 });
  assert.equal(d.history.giftCodes, 1);
  assert.ok(d.history.transactions >= 6 && d.history.auditEntries >= 2);
  assert.equal(d.activeSessions, 1, "a's login");
  assert.equal(d.permanentDelete.allowed, false);
  assert.ok(d.permanentDelete.blockedBy.transactions > 0 && d.permanentDelete.blockedBy.auditEntries > 0);
  assert.ok(!JSON.stringify(d).includes(`"${a.cvv}"`) && !JSON.stringify(d).includes(a.number), 'no codes or card numbers in the preview');
  assert.ok(!/cvv_hash|scrypt\$|cvv_enc/.test(JSON.stringify(d)));
  // "cancel" = preview only: nothing changed
  assert.deepEqual(await history(s), before); assert.deepEqual(await statusOf(s), st);
  assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_audit_log WHERE action = 'cards.bulk_retire'")).rows[0].c, 0);

  await s.close();
});

test('bulk retire one card with transfers and redemptions: only that card is deactivated, every record is preserved', async () => {
  const s = await start();
  const ad = await admin(s);
  const { a, b, ha, hb } = await world(s, ad);
  const before = await history(s);
  const p = (await preview(ad, { ids: [a.id] })).data;
  const r = await retire(ad, { ids: [a.id] }, p);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.result, { scope: 'selection', selected: 1, retired: 1, alreadyInactive: 0, sessionsEnded: 1, retiredIds: [a.id] });
  const st = await statusOf(s);
  assert.equal(st[a.id], 'inactive');
  assert.equal(st[b.id], 'active', 'the other side of the transfers is untouched');
  assert.deepEqual(await history(s), before, 'balances, ledger, transfers, redemptions, gift codes and card data unchanged');
  assert.equal((await ha.call('/me')).status, 401, 'retired cardholder signed out');
  assert.equal((await hb.call('/me')).status, 200, 'other cardholder still signed in');
  const bTx = (await hb.call('/transactions')).data.items;
  assert.ok(bTx.some((t) => t.counterparty?.number?.endsWith(a.number.slice(-4))), "b's history still names a");
  // audit: one summary event (admin, ids, outcome) plus one per card; never a secret
  const log = (await s.q("SELECT admin_name, action, card_id, details FROM pioneer_audit_log WHERE action IN ('cards.bulk_retire', 'card.deactivate') ORDER BY id")).rows;
  assert.deepEqual(log.map((x) => [x.action, x.card_id]), [['card.deactivate', a.id], ['cards.bulk_retire', null]]);
  assert.equal(log[1].admin_name, 'magical');
  assert.deepEqual(log[1].details, { scope: 'selection', selected: 1, retired: 1, alreadyInactive: 0, sessionsEnded: 1, ids: [a.id], outcome: 'ok' });
  assert.ok(!JSON.stringify(log).includes(a.cvv));
  // the same request again (double click, replay): refused, nothing more happens
  assert.equal((await retire(ad, { ids: [a.id] }, p)).status, 409);
  assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_audit_log WHERE action = 'cards.bulk_retire'")).rows[0].c, 1);
  // reversible with the existing activation
  assert.equal((await ad.call(`/cards/${a.id}/status`, { method: 'POST', body: { status: 'active' } })).status, 200);
  assert.equal((await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: a.number, cvv: a.cvv } })).status, 200, 'same card, same CVV, works again');
  assert.deepEqual((await history(s)).balances, before.balances);
  await s.close();
});

test('bulk retire several, then all cards; already inactive cards are counted, not changed; parallel duplicates run once', async () => {
  const s = await start();
  const ad = await admin(s);
  const { a, b, c, d } = await world(s, ad);
  const before = await history(s);
  // several
  const p1 = (await preview(ad, { ids: [b.id, d.id] })).data;
  const [x, y] = await Promise.all([retire(ad, { ids: [b.id, d.id] }, p1), retire(ad, { ids: [b.id, d.id] }, p1)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409], 'row locks: exactly one of two parallel requests runs');
  assert.deepEqual(await statusOf(s), { [a.id]: 'active', [b.id]: 'inactive', [c.id]: 'active', [d.id]: 'inactive' });
  // all cards (Delete all): the two retired ones are reported as already inactive
  const pAll = (await preview(ad, { all: true })).data;
  assert.equal(pAll.scope, 'all'); assert.deepEqual([pAll.cards.selected, pAll.cards.active, pAll.cards.alreadyInactive], [4, 2, 2]);
  const e = await newCard(ad, { firstName: 'Late' }); // a card created after the preview: the confirmation no longer matches
  assert.equal((await retire(ad, { all: true }, pAll)).status, 409);
  assert.equal((await statusOf(s))[a.id], 'active');
  const pAll2 = (await preview(ad, { all: true })).data;
  const r = await retire(ad, { all: true }, pAll2);
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.result.selected, r.data.result.retired, r.data.result.alreadyInactive], [5, 3, 2]);
  assert.ok(Object.values(await statusOf(s)).every((v) => v === 'inactive'));
  const now = await history(s);
  assert.deepEqual(now.ledger.slice(0, before.ledger.length), before.ledger, 'existing ledger rows unchanged');
  assert.deepEqual(now.ledger.slice(before.ledger.length).map((t) => [t.card_id, t.type]), [[e.id, 'initial_bonus']], "the only new row is the late card's own bonus, from its creation");
  assert.deepEqual([now.transfers, now.redemptions], [before.transfers, before.redemptions]);
  assert.equal((await s.q('SELECT COUNT(*)::int AS c FROM pioneer_cards')).rows[0].c, 5, 'no card row deleted');

  await s.close();
});

test('bulk retire rolls back completely when any step fails, and records the failed attempt', async () => {
  const s = await start();
  const ad = await admin(s);
  const a = await newCard(ad), b = await newCard(ad);
  const ha = await holder(s, a.number, a.cvv);
  // test database only: make the final audit insert of the bulk operation fail
  await s.q(`CREATE OR REPLACE FUNCTION test_fail_bulk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action = 'cards.bulk_retire' AND NEW.details->>'outcome' = 'ok' THEN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$`);
  await s.q('CREATE TRIGGER test_fail_bulk BEFORE INSERT ON pioneer_audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_bulk()');
  try {
    const p = (await preview(ad, { ids: [a.id, b.id] })).data;
    const r = await retire(ad, { ids: [a.id, b.id] }, p);
    assert.equal(r.status, 500);
    assert.deepEqual(Object.values(await statusOf(s)), ['active', 'active'], 'no card deactivated');
    assert.equal((await ha.call('/me')).status, 200, 'sessions not ended');
    assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_audit_log WHERE action = 'card.deactivate'")).rows[0].c, 0, 'per-card audit rolled back too');
    const fail = (await s.q("SELECT details FROM pioneer_audit_log WHERE action = 'cards.bulk_retire'")).rows;
    assert.equal(fail.length, 1); assert.equal(fail[0].details.outcome, 'failed'); assert.equal(fail[0].details.selected, 2);
  } finally {
    await s.q('DROP TRIGGER IF EXISTS test_fail_bulk ON pioneer_audit_log');
    await s.q('DROP FUNCTION IF EXISTS test_fail_bulk()');
  }
  await s.close();
});
