// External integration API for partner systems (e.g. the Christmas Store backend): /api/integration/v1/*.
// Server-to-server only: authenticated with an API key sent as a Bearer token (keys are created with
// `npm run integration -- create-key`, see docs/PIONEER_CARD_API.md). Card data is only readable for a card that
// the partner has linked to one of its customers by proving ownership with the card number + CVV.
// Registered by createApp (server/app.js) on the shared router; reuses the Pioneer per-card login lockout.
import { createHash, randomBytes } from 'node:crypto';
import { withTransaction, isUnique } from './db.js';
import { HttpError, sendJson, readJson } from './http.js';
import { normalizeCardNo, normalizeCvv, maskCardNo, displayName, TX_LABELS, MAX_POINTS_OP } from '../shared/pioneer.js';
import { clean } from '../shared/validation.js';

export const BASE = '/api/integration/v1';
// Scopes a new key gets by default. Points scopes are never default: an administrator grants them explicitly.
export const SCOPES = ['cards:verify', 'cards:link', 'cards:read', 'rewards:read'];
export const POINT_SCOPES = ['points:credit', 'points:debit'];
export const ALL_SCOPES = [...SCOPES, ...POINT_SCOPES];
export const LIMIT_COLUMNS = { 'credit-per-operation': 'max_credit_per_operation', 'credit-per-card-per-day': 'max_credit_per_card_per_day', 'credit-per-day': 'max_credit_per_day', 'debit-per-operation': 'max_debit_per_operation' };
const IDEM_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const REF_RE = /^[A-Za-z0-9._:-]{3,100}$/;
const REASON_RE = /^[a-z][a-z0-9_]{1,39}$/;
// "christmas-store" -> "Christmas Store" when no display name is set
export const partnerLabel = (c) => c.display_name || c.name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const KEY_RE = /^mgpc_[A-Za-z0-9_-]{43}$/;
const CUSTOMER_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

// API keys: "mgpc_" + 256 random bits. Only the SHA-256 is stored (a slow hash adds nothing for 256-bit secrets).
export const hashKey = (key) => createHash('sha256').update(key).digest('hex');
export function generateKey() {
  const key = 'mgpc_' + randomBytes(32).toString('base64url');
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

const E = {
  auth: 'Missing or invalid API key. Send it as "Authorization: Bearer <key>".',
  scope: 'This API key is not allowed to use this endpoint.',
  browser: 'The integration API is server-to-server only; browser (CORS) requests are refused. Call it from your backend.',
  https: 'HTTPS is required.',
  rate: 'Too many requests. Retry later.',
  validation: 'The request has invalid fields.',
  locked: 'Too many failed attempts for this card number. Retry later.',
  hardLocked: 'This card number is locked after repeated failed attempts. The cardholder must contact Magical to unlock it.',
  invalidCard: 'The card number or verification code is incorrect.',
  inactive: 'This Pioneer Card is deactivated.',
  cardLinked: 'This Pioneer Card is already linked to another account.',
  customerLinked: 'This customer already has a different Pioneer Card linked. Unlink it first.',
  noLink: 'No Pioneer Card is linked to this customer.',
  noReward: 'Reward not found or not available.',
  idemMissing: 'An Idempotency-Key header is required: 8-200 characters from A-Z a-z 0-9 . _ : -, unique per operation.',
  points: `"points" must be a whole number from 1 to ${MAX_POINTS_OP}.`,
  insufficient: 'The card does not have enough points.',
  duplicateRef: 'An operation with this reference already exists for this partner.',
  idemConflict: 'This Idempotency-Key was already used with different request data.',
  limit: 'This operation exceeds a limit configured for this partner.',
};
const fieldErr = (fields) => new HttpError(422, 'validation_failed', E.validation, fields);

export function registerIntegration({ R, db, config, limiter, pioneer }) {
  const limit = (key, n, windowMs) => {
    if (!config.rateLimits) return;
    const r = limiter.take(key, n, windowMs);
    if (!r.ok) { const e = new HttpError(429, 'rate_limited', E.rate); e.retryAfter = r.retryAfter; throw e; }
  };
  const isHttps = (req) => req.socket.encrypted || (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

  const authenticate = async (ctx) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(ctx.req.headers.authorization || ''));
    const key = m && KEY_RE.test(m[1]) ? m[1] : null;
    const client = key ? (await db.query(
      `SELECT id, name, scopes, display_name, max_credit_per_operation, max_credit_per_card_per_day, max_credit_per_day, max_debit_per_operation
       FROM integration_clients WHERE key_hash = $1 AND status = 'active'`, [hashKey(key)])).rows[0] : null;
    if (!client) { limit(`int-badkey:${ctx.ip}`, 30, 15 * 60_000); throw new HttpError(401, 'invalid_api_key', E.auth); }
    db.query("UPDATE integration_clients SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [client.id]).catch(() => {});
    return client;
  };

  // Every endpoint: HTTPS (when required) -> no browser origin -> API key -> scope -> per-client rate limit -> handler.
  // One log row per request (route pattern, status, error code; never keys, card numbers, CVVs or bodies).
  const route = (method, path, { scope, rate }, handler) => R(method, BASE + path, {}, async (ctx) => {
    const t0 = Date.now();
    let client = null, status = 500, code = null;
    try {
      if (config.integrationRequireHttps && !isHttps(ctx.req)) throw new HttpError(403, 'https_required', E.https);
      if (ctx.req.headers.origin) throw new HttpError(403, 'browser_requests_not_allowed', E.browser);
      client = await authenticate(ctx);
      if (scope && !client.scopes.includes(scope)) throw new HttpError(403, 'insufficient_scope', E.scope);
      if (rate === 'credentials') limit(`int-cred:${client.id}`, 120, 10 * 60_000);
      else if (rate === 'points') limit(`int-points:${client.id}`, 300, 10 * 60_000);
      else limit(`int-read:${client.id}`, 600, 60_000);
      ctx.client = client;
      await handler(ctx);
      status = ctx.res.statusCode;
    } catch (e) {
      status = e instanceof HttpError ? e.status : 500;
      code = e instanceof HttpError ? e.code : 'server_error';
      throw e;
    } finally {
      await db.query('INSERT INTO integration_request_log (client_id, method, route, status, error_code, ip, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [client?.id ?? null, method, BASE + path, status, code, ctx.ip, Date.now() - t0]).catch((e) => console.error('[integration] log write failed:', e.code || e.message));
    }
  });

  // ---------- helpers ------------------------------------------------------------------
  const credentialsFrom = (body) => {
    const cardNo = normalizeCardNo(body.cardNumber), cvv = normalizeCvv(body.cvv);
    if (!cardNo || !cvv) throw fieldErr({ ...(!cardNo && { cardNumber: 'Must be the 8-digit card number.' }), ...(!cvv && { cvv: 'Must be the 3-digit verification code.' }) });
    return { cardNo, cvv };
  };
  // The shared Pioneer lockout check; locked numbers are an error, wrong credentials are a result.
  const check = async (cardNo, cvv) => {
    const v = await pioneer.checkCredentials(cardNo, cvv);
    if (v.locked) { const e = new HttpError(429, v.hard ? 'card_locked' : 'too_many_attempts', v.hard ? E.hardLocked : E.locked); if (!v.hard) e.retryAfter = v.retryAfter; throw e; }
    return v;
  };
  const customerIdOf = (raw) => {
    const id = String(raw ?? '');
    if (!CUSTOMER_RE.test(id)) throw fieldErr({ customerId: 'Must be 1-128 characters: letters, digits and . _ : @ -' });
    return id;
  };
  const cardOut = (c) => ({
    number: maskCardNo(c.card_no), last4: c.card_no.slice(4), firstName: c.first_name, lastName: c.last_name,
    displayName: displayName(c.first_name, c.last_name), status: c.status, memberSince: c.created_at,
  });
  const linkedCard = async (ctx) => {
    const customerId = customerIdOf(ctx.params.customerId);
    const r = (await db.query(
      `SELECT l.id AS link_id, l.external_customer_id, l.linked_at, c.* FROM pioneer_card_links l JOIN pioneer_cards c ON c.id = l.card_id
       WHERE l.client_id = $1 AND l.external_customer_id = $2 AND l.status = 'active'`, [ctx.client.id, customerId])).rows[0];
    if (!r) throw new HttpError(404, 'link_not_found', E.noLink);
    return r;
  };
  const linkOut = (r) => ({ customerId: r.external_customer_id, linkedAt: r.linked_at, card: cardOut(r), balance: r.balance });

  // Rewards a cardholder can see (published, not ended), optionally with per-card eligibility.
  const REWARDS_SQL = `SELECT r.*, (r.available_from IS NOT NULL AND r.available_from > now()) AS upcoming,
      (SELECT COUNT(*)::int FROM pioneer_redemptions d WHERE d.reward_id = r.id AND d.card_id = $1 AND d.status <> 'cancelled') AS mine
    FROM pioneer_rewards r WHERE r.status = 'published' AND (r.available_until IS NULL OR r.available_until > now())`;
  const rewardOut = (r) => ({
    id: r.id, kind: r.kind, title: r.title, description: r.description, icon: r.icon, pointsCost: r.points_cost,
    discountPercent: r.discount_percent, discountAmount: r.discount_amount, availableFrom: r.available_from ?? null, availableUntil: r.available_until ?? null,
    availabilityNote: r.availability_note, perCardLimit: r.per_card_limit, upcoming: r.upcoming,
    soldOut: r.max_redemptions != null && r.redeemed_count >= r.max_redemptions,
  });
  const eligibility = (r, card) => {
    const base = rewardOut(r), reasons = [];
    const limitReached = r.per_card_limit != null && r.mine >= r.per_card_limit;
    const affordable = card.balance >= r.points_cost;
    if (card.status !== 'active') reasons.push('card_inactive');
    if (base.upcoming) reasons.push('not_yet_available');
    if (base.soldOut) reasons.push('sold_out');
    if (limitReached) reasons.push('per_card_limit_reached');
    if (!affordable) reasons.push('insufficient_points');
    return { ...base, redeemedByCard: r.mine, limitReached, affordable, shortfall: Math.max(0, r.points_cost - card.balance), eligible: reasons.length === 0, reasons };
  };

  // ---------- endpoints ------------------------------------------------------------------
  route('GET', '/me', {}, async (ctx) => sendJson(ctx.res, 200, { client: { name: ctx.client.name, scopes: ctx.client.scopes } }, NO_STORE));

  route('POST', '/cards/verify', { scope: 'cards:verify', rate: 'credentials' }, async (ctx) => {
    const { cardNo, cvv } = credentialsFrom(await readJson(ctx.req, 2000));
    const v = await check(cardNo, cvv);
    if (!v.ok) return sendJson(ctx.res, 200, { valid: false, reason: 'invalid_credentials', attemptsBeforeLock: v.attemptsBeforeLock }, NO_STORE);
    const c = (await db.query('SELECT * FROM pioneer_cards WHERE id = $1', [v.card.id])).rows[0];
    const linked = !!(await db.query("SELECT 1 FROM pioneer_card_links WHERE card_id = $1 AND status = 'active'", [c.id])).rows[0];
    sendJson(ctx.res, 200, { valid: true, card: { ...cardOut(c), linked } }, NO_STORE);
  });

  // Link = proof of ownership (card number + CVV, same lockout as the website login) + the partner's customer id.
  route('POST', '/links', { scope: 'cards:link', rate: 'credentials' }, async (ctx) => {
    const body = await readJson(ctx.req, 2000);
    const customerId = customerIdOf(body.customerId);
    const { cardNo, cvv } = credentialsFrom(body);
    const v = await check(cardNo, cvv);
    if (!v.ok) throw new HttpError(422, 'invalid_card_credentials', E.invalidCard, { attemptsBeforeLock: v.attemptsBeforeLock });
    if (v.card.status !== 'active') throw new HttpError(403, 'card_inactive', E.inactive);
    const result = await withTransaction(db, async (c) => {
      const cur = (await c.query("SELECT * FROM pioneer_card_links WHERE card_id = $1 AND status = 'active' FOR UPDATE", [v.card.id])).rows[0];
      if (cur) {
        if (cur.client_id === ctx.client.id && cur.external_customer_id === customerId) return { replay: true };
        throw new HttpError(409, 'card_already_linked', E.cardLinked);
      }
      try {
        await c.query('INSERT INTO pioneer_card_links (client_id, card_id, external_customer_id) VALUES ($1, $2, $3)', [ctx.client.id, v.card.id, customerId]);
      } catch (e) {
        if (isUnique(e, 'one_per_customer')) throw new HttpError(409, 'customer_already_linked', E.customerLinked);
        if (isUnique(e, 'one_per_card')) throw new HttpError(409, 'card_already_linked', E.cardLinked); // a concurrent link won
        throw e;
      }
      return { replay: false };
    });
    ctx.params.customerId = customerId;
    sendJson(ctx.res, result.replay ? 200 : 201, { link: linkOut(await linkedCard(ctx)) }, NO_STORE);
  });

  route('DELETE', '/customers/:customerId/link', { scope: 'cards:link' }, async (ctx) => {
    const r = await linkedCard(ctx);
    await db.query("UPDATE pioneer_card_links SET status = 'unlinked', unlinked_at = now(), unlinked_by = 'client' WHERE id = $1 AND status = 'active'", [r.link_id]);
    sendJson(ctx.res, 200, { unlinked: true, customerId: r.external_customer_id }, NO_STORE);
  });

  route('GET', '/customers/:customerId/card', { scope: 'cards:read' }, async (ctx) => sendJson(ctx.res, 200, { link: linkOut(await linkedCard(ctx)) }, NO_STORE));

  route('GET', '/customers/:customerId/transactions', { scope: 'cards:read' }, async (ctx) => {
    const r = await linkedCard(ctx), q = ctx.url.searchParams;
    const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    const pageSize = int(q.get('pageSize'), 20, 1, 50);
    const total = (await db.query('SELECT COUNT(*)::int AS c FROM pioneer_transactions WHERE card_id = $1', [r.id])).rows[0].c;
    const page = Math.min(int(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query('SELECT id, type, amount, balance_after, description, created_at FROM pioneer_transactions WHERE card_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3', [r.id, pageSize, (page - 1) * pageSize]);
    const items = rows.map((t) => ({ id: String(t.id), type: t.type, label: TX_LABELS[t.type] || t.type, description: t.description, amount: t.amount, balanceAfter: t.balance_after, createdAt: t.created_at }));
    sendJson(ctx.res, 200, { balance: r.balance, items, total, page, pageSize }, NO_STORE);
  });

  route('GET', '/rewards', { scope: 'rewards:read' }, async (ctx) => {
    const { rows } = await db.query(`${REWARDS_SQL} ORDER BY r.sort_order, r.points_cost, r.id`, [0]);
    sendJson(ctx.res, 200, { items: rows.map(rewardOut) }, NO_STORE);
  });

  route('GET', '/customers/:customerId/rewards', { scope: 'rewards:read' }, async (ctx) => {
    const card = await linkedCard(ctx);
    const { rows } = await db.query(`${REWARDS_SQL} ORDER BY r.sort_order, r.points_cost, r.id`, [card.id]);
    sendJson(ctx.res, 200, { balance: card.balance, cardStatus: card.status, items: rows.map((r) => eligibility(r, card)) }, NO_STORE);
  });

  route('GET', '/customers/:customerId/rewards/:rewardId/eligibility', { scope: 'rewards:read' }, async (ctx) => {
    const card = await linkedCard(ctx);
    const id = /^\d{1,9}$/.test(ctx.params.rewardId) ? Number(ctx.params.rewardId) : 0;
    const r = id ? (await db.query(`${REWARDS_SQL} AND r.id = $2`, [card.id, id])).rows[0] : null;
    if (!r) throw new HttpError(404, 'reward_not_found', E.noReward);
    const e = eligibility(r, card);
    sendJson(ctx.res, 200, { rewardId: r.id, title: r.title, pointsCost: r.points_cost, balance: card.balance, eligible: e.eligible, affordable: e.affordable, shortfall: e.shortfall, reasons: e.reasons }, NO_STORE);
  });

  // ---------- points: credit / debit through the Pioneer ledger --------------------------------
  // One database transaction per operation: lock -> idempotency re-check -> limits/balance -> operation row ->
  // ledger row (the existing trigger changes the balance and refuses negatives) -> stored result -> COMMIT.
  // The operation row's UNIQUE (client_id, idempotency_key) makes a repeated or concurrent duplicate impossible;
  // a duplicate gets the stored original result instead.
  const limitErr = (limitName, max, extra = {}) => new HttpError(422, 'partner_limit_exceeded', E.limit, { limit: limitName, max, ...extra });
  const pointsRequest = async (ctx, kind) => {
    const idem = String(ctx.req.headers['idempotency-key'] ?? '');
    if (!idem) throw new HttpError(400, 'idempotency_key_required', E.idemMissing);
    if (!IDEM_RE.test(idem)) throw new HttpError(400, 'invalid_idempotency_key', E.idemMissing);
    const body = await readJson(ctx.req, 2000);
    const customerId = customerIdOf(body.customerId);
    const points = body.points;
    if (typeof points !== 'number' || !Number.isSafeInteger(points) || points < 1 || points > MAX_POINTS_OP) throw new HttpError(422, 'invalid_points_amount', E.points, { points: E.points });
    const reference = typeof body.reference === 'string' ? body.reference : '';
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const description = clean(body.description ?? '');
    const errors = {
      ...(!REF_RE.test(reference) && { reference: 'Required: 3-100 characters from A-Z a-z 0-9 . _ : -, unique per partner.' }),
      ...(!REASON_RE.test(reason) && { reason: 'Required: 2-40 characters, lower-case letters, digits and _, starting with a letter (e.g. game_reward).' }),
      ...((body.description != null && typeof body.description !== 'string') || [...description].length > 200 ? { description: 'Optional text, at most 200 characters.' } : {}),
    };
    if (Object.keys(errors).length) throw new HttpError(422, 'validation_failed', E.validation, errors);
    // fingerprint of everything that defines the operation; a retry must match it exactly
    const requestHash = createHash('sha256').update(JSON.stringify([kind, customerId, points, reference, reason, description])).digest('hex');
    return { idem, customerId, points, reference, reason, description, requestHash };
  };
  const replayOf = async (c, client, req) => {
    const prev = (await c.query('SELECT request_hash, result FROM partner_point_operations WHERE client_id = $1 AND idempotency_key = $2', [client.id, req.idem])).rows[0];
    if (!prev) return null;
    if (prev.request_hash !== req.requestHash) throw new HttpError(409, 'idempotency_conflict', E.idemConflict);
    return prev.result;
  };

  const pointsOperation = (kind) => async (ctx) => {
    const client = ctx.client, req = await pointsRequest(ctx, kind);
    const send = (result, replayed) => sendJson(ctx.res, replayed ? 200 : 201, result, { ...NO_STORE, ...(replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
    const early = await replayOf(db, client, req);
    if (early) return send(early, true);
    const maxOp = kind === 'credit' ? client.max_credit_per_operation : client.max_debit_per_operation;
    if (req.points > maxOp) throw limitErr(kind === 'credit' ? 'max_credit_per_operation' : 'max_debit_per_operation', maxOp);

    const run = () => withTransaction(db, async (c) => {
      // Lock order (never reversed, so no deadlocks): partner (credits only, for its daily total) -> link -> card.
      if (kind === 'credit') await c.query('SELECT id FROM integration_clients WHERE id = $1 FOR UPDATE', [client.id]);
      const link = (await c.query("SELECT id, card_id FROM pioneer_card_links WHERE client_id = $1 AND external_customer_id = $2 AND status = 'active' FOR SHARE", [client.id, req.customerId])).rows[0];
      if (!link) throw new HttpError(404, 'link_not_found', E.noLink);
      const card = (await c.query('SELECT id, balance, status FROM pioneer_cards WHERE id = $1 FOR UPDATE', [link.card_id])).rows[0];
      // a concurrent duplicate that was waiting on the locks above now sees the committed original
      const replay = await replayOf(c, client, req);
      if (replay) return { result: replay, replayed: true };
      if (card.status !== 'active') throw new HttpError(403, 'card_inactive', E.inactive);
      if ((await c.query('SELECT 1 FROM partner_point_operations WHERE client_id = $1 AND reference = $2', [client.id, req.reference])).rows[0])
        throw new HttpError(409, 'duplicate_reference', E.duplicateRef);
      if (kind === 'credit') {
        const sum = async (extra, args) => (await c.query(`SELECT COALESCE(SUM(points), 0)::int AS s FROM partner_point_operations WHERE client_id = $1 AND kind = 'credit' AND created_at > now() - interval '24 hours'${extra}`, [client.id, ...args])).rows[0].s;
        const cardDay = await sum(' AND card_id = $2', [card.id]);
        if (cardDay + req.points > client.max_credit_per_card_per_day) throw limitErr('max_credit_per_card_per_day', client.max_credit_per_card_per_day, { usedLast24h: cardDay });
        const allDay = await sum('', []);
        if (allDay + req.points > client.max_credit_per_day) throw limitErr('max_credit_per_day', client.max_credit_per_day, { usedLast24h: allDay });
      } else if (card.balance < req.points) {
        throw new HttpError(409, 'insufficient_points', E.insufficient, { balance: card.balance, points: req.points });
      }
      const op = (await c.query(
        `INSERT INTO partner_point_operations (client_id, card_id, link_id, kind, points, reference, reason, description, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [client.id, card.id, link.id, kind, req.points, req.reference, req.reason, req.description, req.idem, req.requestHash])).rows[0];
      // Shown in the cardholder's history: the partner and what happened, nothing internal.
      const what = req.description || req.reason.charAt(0).toUpperCase() + req.reason.slice(1).replace(/_/g, ' ');
      const tx = (await c.query(
        'INSERT INTO pioneer_transactions (card_id, type, amount, description, partner_operation_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, type, amount, balance_after, created_at',
        [card.id, kind === 'credit' ? 'partner_credit' : 'partner_redemption', kind === 'credit' ? req.points : -req.points, `${partnerLabel(client)} — ${what}`.slice(0, 500), op.id])).rows[0];
      const result = {
        success: true,
        transaction: {
          id: String(tx.id), type: tx.type, points: req.points, amount: tx.amount, balanceAfter: tx.balance_after,
          customerId: req.customerId, reference: req.reference, reason: req.reason, description: req.description, createdAt: tx.created_at,
        },
      };
      await c.query('UPDATE partner_point_operations SET result = $1 WHERE id = $2', [JSON.stringify(result), op.id]);
      return { result, replayed: false };
    });

    let out;
    try { out = await run(); } catch (e) {
      if (isUnique(e, 'idem_key')) { const r = await replayOf(db, client, req); if (r) return send(r, true); } // concurrent duplicate won
      if (isUnique(e, 'reference_key')) throw new HttpError(409, 'duplicate_reference', E.duplicateRef);
      if (e?.code === '23514' && String(e.constraint || '').includes('balance')) throw new HttpError(409, 'insufficient_points', E.insufficient); // ledger guard (backstop)
      throw e;
    }
    send(out.result, out.replayed);
  };
  route('POST', '/points/credit', { scope: 'points:credit', rate: 'points' }, pointsOperation('credit'));
  route('POST', '/points/debit', { scope: 'points:debit', rate: 'points' }, pointsOperation('debit'));
}
