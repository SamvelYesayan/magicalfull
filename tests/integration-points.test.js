// Partner points (POST /api/integration/v1/points/credit|debit) through the Pioneer ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, verifyTestDatabase } from './helpers.js';
import { migrate } from '../server/db.js';
import { generateKey, SCOPES, ALL_SCOPES } from '../server/integration.js';

const B = '/api/integration/v1';
let seq = 0;
const ikey = (tag = 'op') => `test:${tag}:${Date.now().toString(36)}:${++seq}`;

async function admin(s) {
  const l = await s.login();
  return (path, opts = {}) => s.api('/api/admin/pioneer' + path, { cookie: l.cookie, csrf: l.csrf, ...opts });
}
async function newCard(ad, holder = {}) {
  const r = await ad('/cards', { method: 'POST', body: holder });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...r.data.card, cvv: r.data.cvv };
}
async function client(s, name = 'christmas-store', scopes = ALL_SCOPES) {
  const k = generateKey();
  const id = (await s.q('INSERT INTO integration_clients (name, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4) RETURNING id', [name, k.prefix, k.hash, scopes])).rows[0].id;
  const call = (path, opts = {}) => s.api(B + path, { ...opts, headers: { Authorization: `Bearer ${k.key}`, ...(opts.headers || {}) } });
  const op = (kind, body, key = ikey(kind)) => call(`/points/${kind}`, { method: 'POST', body, headers: { 'Idempotency-Key': key } });
  return { id, key: k.key, call, op };
}
// partner + linked card in one go
async function setup(s, { scopes = ALL_SCOPES, holder = {} } = {}) {
  const ad = await admin(s), c = await client(s, 'christmas-store', scopes);
  const card = await newCard(ad, holder);
  const l = await c.call('/links', { method: 'POST', body: { customerId: 'cust_8412', cardNumber: card.number, cvv: card.cvv } });
  assert.equal(l.status, 201, JSON.stringify(l.data));
  return { ad, c, card };
}
const balance = async (s, id) => (await s.q('SELECT balance FROM pioneer_cards WHERE id = $1', [id])).rows[0].balance;
const ledger = async (s, id) => (await s.q('SELECT type, amount, balance_after, description, partner_operation_id FROM pioneer_transactions WHERE card_id = $1 ORDER BY id', [id])).rows;
const consistent = async (s) => (await s.q('SELECT COUNT(*)::int AS c FROM pioneer_cards c WHERE c.balance <> COALESCE((SELECT SUM(amount) FROM pioneer_transactions t WHERE t.card_id = c.id), 0)')).rows[0].c === 0;
const credit = (over = {}) => ({ customerId: 'cust_8412', points: 100, reference: 'christmas-game-987', reason: 'game_reward', description: 'Christmas game reward', ...over });
const debit = (over = {}) => ({ customerId: 'cust_8412', points: 250, reference: 'christmas-gift-451', reason: 'partner_redemption', description: 'Christmas Store gift redemption', ...over });

test('credit and debit go through the ledger; committed balance is returned; history shows the partner', async () => {
  const s = await start();
  const { c, card } = await setup(s);
  const cr = await c.op('credit', credit());
  assert.equal(cr.status, 201, JSON.stringify(cr.data));
  assert.equal(cr.data.success, true);
  assert.deepEqual({ ...cr.data.transaction, id: 'x', createdAt: 'x' }, { id: 'x', type: 'partner_credit', points: 100, amount: 100, balanceAfter: 300, customerId: 'cust_8412', reference: 'christmas-game-987', reason: 'game_reward', description: 'Christmas game reward', createdAt: 'x' });
  const db = await c.op('debit', debit());
  assert.equal(db.status, 201, JSON.stringify(db.data));
  assert.deepEqual([db.data.transaction.type, db.data.transaction.points, db.data.transaction.amount, db.data.transaction.balanceAfter], ['partner_redemption', 250, -250, 50]);
  // the balance is the ledger's: card row, ledger sum and response all agree
  assert.equal(await balance(s, card.id), 50);
  assert.ok(await consistent(s));
  const rows = await ledger(s, card.id);
  assert.deepEqual(rows.map((r) => [r.type, r.amount, r.balance_after]), [['initial_bonus', 200, 200], ['partner_credit', 100, 300], ['partner_redemption', -250, 50]]);
  assert.equal(rows[1].description, 'Christmas Store — Christmas game reward');
  assert.equal(rows[2].description, 'Christmas Store — Christmas Store gift redemption');
  assert.equal(cr.data.transaction.id, String((await s.q("SELECT id FROM pioneer_transactions WHERE type = 'partner_credit'")).rows[0].id));
  // audit record: partner, card, link, kind, points, reference, reason, description, idempotency key, time, status
  const ops = (await s.q('SELECT client_id, card_id, link_id, kind, points, reference, reason, description, idempotency_key, status, created_at FROM partner_point_operations ORDER BY id')).rows;
  assert.equal(ops.length, 2);
  assert.deepEqual([ops[0].client_id, ops[0].card_id, ops[0].kind, ops[0].points, ops[0].reference, ops[0].reason, ops[0].status], [c.id, card.id, 'credit', 100, 'christmas-game-987', 'game_reward', 'completed']);
  assert.ok(ops[0].link_id && ops[0].idempotency_key.startsWith('test:credit:') && ops[0].created_at);
  // partner view of the history
  const tx = (await c.call('/customers/cust_8412/transactions')).data;
  assert.equal(tx.balance, 50);
  assert.deepEqual(tx.items.slice(0, 2).map((t) => [t.type, t.label, t.amount, t.description]), [
    ['partner_redemption', 'Փոխանակում գործընկերոջ մոտ', -250, 'Christmas Store — Christmas Store gift redemption'],
    ['partner_credit', 'Գործընկերոջ բոնուս', 100, 'Christmas Store — Christmas game reward']]);
  // cardholder view on magical.am: same entries, stats include them, nothing internal is shown
  const h = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: card.number, cvv: card.cvv } });
  const cookie = h.headers.get('set-cookie').split(';')[0];
  const me = (await s.api('/api/pioneer/me', { cookie })).data;
  assert.equal(me.balance, 50);
  assert.deepEqual([me.stats.earned, me.stats.spent], [300, 250]);
  const hist = (await s.api('/api/pioneer/transactions', { cookie })).data.items;
  assert.equal(hist[0].description, 'Christmas Store — Christmas Store gift redemption');
  const j = JSON.stringify(hist);
  for (const secret of [c.key, 'idempotency', 'test:credit', 'client_id', 'partner_operation']) assert.ok(!j.includes(secret), 'history leaks ' + secret);
  // admin ledger filter knows the new types
  const ad = await admin(s);
  assert.equal((await ad('/transactions?type=partner_credit')).data.total, 1);
  await s.close();
});

test('authentication, scopes and links: invalid key, missing credit/debit scope, unlinked or foreign customer', async () => {
  const s = await start();
  const { c, card } = await setup(s, { scopes: SCOPES });
  assert.equal((await s.api(B + '/points/credit', { method: 'POST', body: credit(), headers: { Authorization: 'Bearer mgpc_' + 'x'.repeat(43), 'Idempotency-Key': ikey() } })).data.error.code, 'invalid_api_key');
  // a key with the v1 scopes only (the default) gets neither operation
  for (const kind of ['credit', 'debit']) {
    const r = await c.op(kind, kind === 'credit' ? credit() : debit());
    assert.equal(r.status, 403); assert.equal(r.data.error.code, 'insufficient_scope');
  }
  // credit-only and debit-only keys are independent
  await s.q("UPDATE integration_clients SET scopes = scopes || '{points:credit}' WHERE id = $1", [c.id]);
  assert.equal((await c.op('credit', credit())).status, 201);
  assert.equal((await c.op('debit', debit({ points: 10 }))).data.error.code, 'insufficient_scope');
  await s.q("UPDATE integration_clients SET scopes = array_remove(scopes, 'points:credit') || '{points:debit}' WHERE id = $1", [c.id]);
  assert.equal((await c.op('credit', credit({ reference: 'other-ref' }))).data.error.code, 'insufficient_scope');
  assert.equal((await c.op('debit', debit({ points: 10 }))).status, 201);
  // unknown customer, and another partner's customer, are both "not linked"
  await s.q("UPDATE integration_clients SET scopes = $2 WHERE id = $1", [c.id, ALL_SCOPES]);
  const nf = await c.op('credit', credit({ customerId: 'nobody', reference: 'r-nobody' }));
  assert.equal(nf.status, 404); assert.equal(nf.data.error.code, 'link_not_found');
  const other = await client(s, 'other-shop');
  const foreign = await other.op('credit', credit({ reference: 'r-foreign' }));
  assert.equal(foreign.status, 404); assert.equal(foreign.data.error.code, 'link_not_found', "a partner cannot reach another partner's customers");
  // no field allows addressing a card directly
  const sneaky = await other.op('credit', { ...credit({ reference: 'r-sneaky' }), cardNumber: card.number, cardId: card.id });
  assert.equal(sneaky.data.error.code, 'link_not_found');
  // unlinked customers cannot be credited any more
  await c.call('/customers/cust_8412/link', { method: 'DELETE' });
  assert.equal((await c.op('credit', credit({ reference: 'r-after-unlink' }))).data.error.code, 'link_not_found');
  // browsers are refused here too
  assert.equal((await c.call('/points/credit', { method: 'POST', body: credit({ reference: 'r-browser' }), headers: { Origin: 'https://evil.example', 'Idempotency-Key': ikey() } })).data.error.code, 'browser_requests_not_allowed');
  assert.equal(await balance(s, card.id), 200 + 100 - 10);
  await s.close();
});

test('request validation: amounts, references, reasons, idempotency header', async () => {
  const s = await start();
  const { c, card } = await setup(s);
  for (const points of [0, -5, 1.5, '100', null, 'NaN', 1e7, 2 ** 53, true, [100], { n: 1 }]) {
    const r = await c.op('credit', credit({ points, reference: 'r-amount' }));
    assert.equal(r.status, 422, `points=${JSON.stringify(points)}`); assert.equal(r.data.error.code, 'invalid_points_amount');
  }
  assert.equal((await c.op('debit', debit({ points: -1 }))).data.error.code, 'invalid_points_amount');
  const bad = await c.op('credit', credit({ reference: 'x', reason: 'Game Reward', description: 'y'.repeat(201) }));
  assert.equal(bad.status, 422); assert.deepEqual(Object.keys(bad.data.error.fields).sort(), ['description', 'reason', 'reference']);
  const noKey = await c.call('/points/credit', { method: 'POST', body: credit() });
  assert.equal(noKey.status, 400); assert.equal(noKey.data.error.code, 'idempotency_key_required');
  const badKey = await c.call('/points/credit', { method: 'POST', body: credit(), headers: { 'Idempotency-Key': 'short' } });
  assert.equal(badKey.status, 400); assert.equal(badKey.data.error.code, 'invalid_idempotency_key');
  assert.equal((await c.call('/points/credit', { method: 'POST', body: 'x', raw: true, headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': ikey() } })).status, 415);
  assert.equal(await balance(s, card.id), 200);
  assert.equal((await s.q('SELECT COUNT(*)::int AS n FROM partner_point_operations')).rows[0].n, 0);
  await s.close();
});

test('debit protection: insufficient points, never negative, no partial debit, inactive cards', async () => {
  const s = await start();
  const { ad, c, card } = await setup(s);
  const r = await c.op('debit', debit({ points: 201 }));
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'insufficient_points');
  assert.equal(await balance(s, card.id), 200, 'nothing deducted');
  assert.equal((await c.op('debit', debit({ points: 200, reference: 'all-of-it' }))).data.transaction.balanceAfter, 0);
  assert.equal((await c.op('debit', debit({ points: 1, reference: 'one-more' }))).data.error.code, 'insufficient_points');
  assert.equal(await balance(s, card.id), 0);
  // the ledger itself refuses to go negative even for a direct insert
  const opId = (await s.q('SELECT id FROM partner_point_operations LIMIT 1')).rows[0].id;
  await assert.rejects(s.q("INSERT INTO pioneer_transactions (card_id, type, amount, description, partner_operation_id) VALUES ($1, 'partner_redemption', -1, 'x', $2)", [card.id, opId]), (e) => e.code === '23514' || e.code === '23505');
  await assert.rejects(s.q("UPDATE pioneer_cards SET balance = 999 WHERE id = $1", [card.id]), (e) => e.code === '42501', 'balances only change through the ledger');
  // deactivated cards: no credit, no debit
  await ad(`/cards/${card.id}/status`, { method: 'POST', body: { status: 'inactive' } });
  assert.equal((await c.op('credit', credit({ reference: 'r-inactive' }))).data.error.code, 'card_inactive');
  assert.ok(await consistent(s));
  await s.close();
});

test('idempotency: identical retry replays the original; different data -> 409; references are unique per partner', async () => {
  const s = await start();
  const { c, card } = await setup(s);
  const key = 'christmas-store:game:987';
  const first = await c.op('credit', credit(), key);
  assert.equal(first.status, 201);
  const again = await c.op('credit', credit(), key);
  assert.equal(again.status, 200); assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(again.data, first.data, 'the original result, byte for byte');
  // a retry is replayed even after the balance changed in between
  await c.op('debit', debit({ points: 50, reference: 'between' }));
  assert.deepEqual((await c.op('credit', credit(), key)).data, first.data);
  const conflict = await c.op('credit', credit({ points: 101 }), key);
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error.code, 'idempotency_conflict');
  assert.equal((await c.op('debit', debit({ reference: 'christmas-game-987' }), key)).data.error.code, 'idempotency_conflict', 'same key for a debit is a conflict too');
  // same reference with a new key = the same game reward again -> refused
  const dupRef = await c.op('credit', credit());
  assert.equal(dupRef.status, 409); assert.equal(dupRef.data.error.code, 'duplicate_reference');
  // another partner may use the same key and reference without conflict
  const other = await client(s, 'other-shop');
  const ad = await admin(s);
  const card2 = await newCard(ad);
  await other.call('/links', { method: 'POST', body: { customerId: 'cust_8412', cardNumber: card2.number, cvv: card2.cvv } });
  assert.equal((await other.op('credit', credit(), key)).status, 201);
  assert.equal((await s.q("SELECT COUNT(*)::int AS n FROM pioneer_transactions WHERE card_id = $1 AND type = 'partner_credit'", [card.id])).rows[0].n, 1, 'credited exactly once');
  assert.equal(await balance(s, card.id), 250);
  await s.close();
});

test('concurrency: parallel duplicate credits execute once; parallel debits never overdraw', async () => {
  const s = await start();
  const { c, card } = await setup(s);
  const key = 'christmas-store:game:race';
  const rs = await Promise.all(Array.from({ length: 10 }, () => c.op('credit', credit({ reference: 'race-1' }), key)));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201], JSON.stringify(rs.map((r) => r.data)));
  assert.equal(new Set(rs.map((r) => r.data.transaction.id)).size, 1, 'everyone gets the same transaction');
  assert.equal(await balance(s, card.id), 300);
  // balance 300: six parallel debits of 100 with different keys -> exactly three succeed
  const ds = await Promise.all(Array.from({ length: 6 }, (_, i) => c.op('debit', debit({ points: 100, reference: `race-debit-${i}` }))));
  assert.equal(ds.filter((r) => r.status === 201).length, 3, JSON.stringify(ds.map((r) => r.data.error?.code || r.status)));
  assert.ok(ds.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.data.error.code === 'insufficient_points'));
  assert.equal(await balance(s, card.id), 0);
  assert.deepEqual(ds.filter((r) => r.status === 201).map((r) => r.data.transaction.balanceAfter).sort((a, b) => a - b), [0, 100, 200], 'each response carries its own committed balance');
  // same reference, different keys, in parallel -> one wins, the rest are duplicates
  const refs = await Promise.all(Array.from({ length: 5 }, () => c.op('credit', credit({ points: 5, reference: 'race-ref' }))));
  assert.equal(refs.filter((r) => r.status === 201).length, 1);
  assert.ok(refs.filter((r) => r.status !== 201).every((r) => r.data.error.code === 'duplicate_reference'));
  assert.ok(await consistent(s));
  await s.close();
});

test('partner limits: per operation, per card per 24 h, per partner per 24 h; configurable', async () => {
  const s = await start();
  const { ad, c, card } = await setup(s);
  const lim = (await s.q('SELECT max_credit_per_operation AS a, max_credit_per_card_per_day AS b, max_credit_per_day AS c, max_debit_per_operation AS d FROM integration_clients WHERE id = $1', [c.id])).rows[0];
  assert.deepEqual(lim, { a: 500, b: 1000, c: 20000, d: 10000 }, 'documented defaults');
  const big = await c.op('credit', credit({ points: 501, reference: 'big' }));
  assert.equal(big.status, 422); assert.equal(big.data.error.code, 'partner_limit_exceeded'); assert.deepEqual(big.data.error.fields, { limit: 'max_credit_per_operation', max: 500 });
  for (let i = 0; i < 2; i++) assert.equal((await c.op('credit', credit({ points: 500, reference: `day-${i}` }))).status, 201);
  const day = await c.op('credit', credit({ points: 1, reference: 'day-over' }));
  assert.equal(day.data.error.code, 'partner_limit_exceeded'); assert.deepEqual(day.data.error.fields, { limit: 'max_credit_per_card_per_day', max: 1000, usedLast24h: 1000 });
  // partner-wide daily cap across cards
  await s.q('UPDATE integration_clients SET max_credit_per_day = 1200 WHERE id = $1', [c.id]);
  const card2 = await newCard(ad);
  await c.call('/links', { method: 'POST', body: { customerId: 'cust_2', cardNumber: card2.number, cvv: card2.cvv } });
  assert.equal((await c.op('credit', credit({ customerId: 'cust_2', points: 200, reference: 'c2-a' }))).status, 201);
  assert.equal((await c.op('credit', credit({ customerId: 'cust_2', points: 1, reference: 'c2-b' }))).data.error.fields.limit, 'max_credit_per_day');
  // credits older than 24 h no longer count
  await s.q("UPDATE partner_point_operations SET created_at = created_at - interval '25 hours'");
  assert.equal((await c.op('credit', credit({ points: 10, reference: 'next-day' }))).status, 201);
  // debit per-operation limit
  await s.q('UPDATE integration_clients SET max_debit_per_operation = 50 WHERE id = $1', [c.id]);
  assert.equal((await c.op('debit', debit({ points: 51, reference: 'd-big' }))).data.error.fields.limit, 'max_debit_per_operation');
  assert.equal((await c.op('debit', debit({ points: 50, reference: 'd-ok' }))).status, 201);
  assert.equal(await balance(s, card.id), 200 + 1000 + 10 - 50);
  await s.close();
});

test('a failure inside the operation rolls back everything (no points, no audit row, key reusable)', async () => {
  const s = await start();
  const { c, card } = await setup(s);
  // make the ledger insert fail after the operation row was written in the same transaction
  await s.q("CREATE OR REPLACE FUNCTION test_fail_partner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'partner_credit' AND NEW.amount = 77 THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$");
  await s.q('CREATE TRIGGER test_fail_partner BEFORE INSERT ON pioneer_transactions FOR EACH ROW EXECUTE FUNCTION test_fail_partner()');
  try {
    const key = ikey('rollback');
    const r = await c.op('credit', credit({ points: 77, reference: 'boom' }), key);
    assert.equal(r.status, 500); assert.deepEqual(r.data, { error: { code: 'server_error', message: 'Սերվերի սխալ։ Խնդրում ենք փորձել կրկին։' } }, 'no SQL details leak');
    assert.equal(await balance(s, card.id), 200);
    assert.equal((await s.q('SELECT COUNT(*)::int AS n FROM partner_point_operations')).rows[0].n, 0);
    await s.q('DROP TRIGGER test_fail_partner ON pioneer_transactions');
    const retry = await c.op('credit', credit({ points: 77, reference: 'boom' }), key);
    assert.equal(retry.status, 201, 'the same key and reference work once the failure is gone');
    assert.equal(await balance(s, card.id), 277);
  } finally {
    await s.q('DROP TRIGGER IF EXISTS test_fail_partner ON pioneer_transactions');
    await s.q('DROP FUNCTION IF EXISTS test_fail_partner()');
  }
  await s.close();
});

test('migration 006 on an existing database keeps every card, balance and ledger row unchanged', async () => {
  const s = await start();
  // Take the test database back to the schema before 006 (empty partner tables), as on production today.
  await s.q(`DROP TABLE partner_point_operations CASCADE;
    ALTER TABLE pioneer_transactions DROP COLUMN partner_operation_id;
    ALTER TABLE pioneer_transactions DROP CONSTRAINT IF EXISTS pioneer_tx_links, DROP CONSTRAINT pioneer_tx_sign, DROP CONSTRAINT pioneer_transactions_type_check,
      ADD CONSTRAINT pioneer_transactions_type_check CHECK (type IN ('initial_bonus','transfer_out','transfer_in','redemption','redemption_refund','admin_credit','admin_debit')),
      ADD CONSTRAINT pioneer_tx_sign CHECK ((type IN ('initial_bonus','transfer_in','redemption_refund','admin_credit') AND amount > 0) OR (type IN ('transfer_out','redemption','admin_debit') AND amount < 0)),
      ADD CONSTRAINT pioneer_tx_links CHECK ((type IN ('transfer_out','transfer_in') AND transfer_id IS NOT NULL AND counterparty_card_id IS NOT NULL) OR (type IN ('redemption','redemption_refund') AND redemption_id IS NOT NULL) OR (type IN ('admin_credit','admin_debit') AND char_length(description) > 0) OR type = 'initial_bonus');
    ALTER TABLE integration_clients DROP COLUMN display_name, DROP COLUMN max_credit_per_operation, DROP COLUMN max_credit_per_card_per_day, DROP COLUMN max_credit_per_day, DROP COLUMN max_debit_per_operation,
      DROP CONSTRAINT integration_clients_scopes_check, ADD CONSTRAINT integration_clients_scopes_check CHECK (scopes <@ ARRAY['cards:verify','cards:link','cards:read','rewards:read']::text[]);
    DELETE FROM schema_migrations WHERE version = '006_partner_points.sql';`);
  const ad = await admin(s);
  const a = await newCard(ad, { firstName: 'Աննա' }), b = await newCard(ad);
  await ad(`/cards/${a.id}/adjust`, { method: 'POST', body: { amount: 40, reason: 'Before upgrade' } });
  await ad(`/cards/${b.id}/adjust`, { method: 'POST', body: { amount: -15, reason: 'Before upgrade' } });
  const k = generateKey();
  await s.q('INSERT INTO integration_clients (name, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4)', ['christmas-store', k.prefix, k.hash, SCOPES]);
  const snap = async () => ({
    tx: (await s.q('SELECT id, card_id, type, amount, balance_after, description, created_at FROM pioneer_transactions ORDER BY id')).rows,
    cards: (await s.q('SELECT id, card_no, balance, status, cvv_hash FROM pioneer_cards ORDER BY id')).rows,
    clients: (await s.q('SELECT id, name, key_hash, scopes, status FROM integration_clients ORDER BY id')).rows,
  });
  const before = await snap();
  assert.deepEqual(await migrate(s.app.db), ['006_partner_points.sql']);
  assert.deepEqual(await snap(), before, 'cards, balances, ledger and partner keys are unchanged');
  assert.deepEqual((await s.q('SELECT scopes FROM integration_clients')).rows[0].scopes, SCOPES, 'the existing partner gains no points scope');
  assert.deepEqual(await migrate(s.app.db), [], 'running it again is a no-op');
  await s.close();
});

test('CLI: scopes granted and revoked without touching the key; rotation keeps the partner, links and limits', async () => {
  const s = await start();
  const url = await verifyTestDatabase();
  const out = join(mkdtempSync(join(tmpdir(), 'mg-cli-')), 'key.env');
  const cli = (...args) => {
    const r = spawnSync(process.execPath, ['server/integration-cli.js', ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } });
    return { code: r.status, text: r.stdout + r.stderr };
  };
  const keyOf = () => readFileSync(out, 'utf8').trim().split('\n').pop().split('=')[1];
  assert.equal(cli('create-key', '--name', 'christmas-store', '--out', out).code, 0);
  const key1 = keyOf();
  const row = async () => (await s.q("SELECT id, scopes, key_hash, max_credit_per_operation, display_name FROM integration_clients WHERE name = 'christmas-store'")).rows;
  const [r1] = await row();
  assert.deepEqual(r1.scopes, SCOPES, 'new keys get no points scopes by default');
  const g = cli('grant-scope', '--name', 'christmas-store', '--scope', 'points:credit,points:debit');
  assert.equal(g.code, 0, g.text); assert.ok(!g.text.includes(key1), 'the key is never printed');
  const [r2] = await row();
  assert.deepEqual([...r2.scopes].sort(), [...ALL_SCOPES].sort()); assert.equal(r2.key_hash, r1.key_hash, 'same key');
  assert.equal(cli('revoke-scope', '--name', 'christmas-store', '--scope', 'points:debit').code, 0);
  assert.ok(!(await row())[0].scopes.includes('points:debit'));
  assert.equal(cli('grant-scope', '--name', 'christmas-store', '--scope', 'points:everything').code, 1);
  assert.equal(cli('set-limits', '--name', 'christmas-store', '--credit-per-operation', '250').code, 0);
  assert.equal(cli('set-display-name', '--name', 'christmas-store', '--display-name', 'Christmas Store').code, 0);
  const list = cli('list-keys');
  assert.equal(list.code, 0); assert.ok(!list.text.includes(key1)); assert.ok(list.text.includes('credit 250/op'));
  // a link made with the first key survives rotation and revoke + create
  const ad = await admin(s), card = await newCard(ad);
  const call = (key, path, opts = {}) => s.api(B + path, { ...opts, headers: { Authorization: `Bearer ${key}`, ...(opts.headers || {}) } });
  assert.equal((await call(key1, '/links', { method: 'POST', body: { customerId: 'cust_1', cardNumber: card.number, cvv: card.cvv } })).status, 201);
  assert.equal(cli('rotate-key', '--name', 'christmas-store', '--out', out).code, 0);
  const key2 = keyOf();
  assert.equal((await call(key1, '/me')).status, 401, 'old key stops working');
  assert.equal((await call(key2, '/customers/cust_1/card')).status, 200, 'new key sees the same links');
  assert.equal(cli('revoke-key', '--name', 'christmas-store').code, 0);
  assert.equal((await call(key2, '/me')).status, 401);
  assert.equal(cli('create-key', '--name', 'christmas-store', '--out', out).code, 0);
  const key3 = keyOf();
  assert.equal((await call(key3, '/customers/cust_1/card')).status, 200);
  const [r3] = await row();
  assert.equal(r3.id, r1.id, 'still the same partner'); assert.equal(r3.max_credit_per_operation, 250); assert.equal(r3.display_name, 'Christmas Store');
  assert.equal((await s.q('SELECT COUNT(*)::int AS n FROM integration_clients')).rows[0].n, 1);
  assert.equal(cli('list-operations', '--name', 'christmas-store').code, 0);
  await s.close();
});
