// Magical Pioneer Card: cardholder login/account, transfers, rewards, and the admin API.
// Registered by createApp (server/app.js) on the same router, so it shares the dispatcher's origin check,
// admin session + CSRF middleware, error format and security headers.
import { randomInt, randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { withTransaction, isUnique } from './db.js';
import { HttpError, sendJson, sendBuffer, readJson } from './http.js';
import { sha256, hmacToken, randomToken, safeEqual, hashPassword, verifyPassword, DUMMY_HASH, parseCookies } from './security.js';
import { clean } from '../shared/validation.js';
import { normalizeCardNo, normalizeCvv, maskCardNo, displayName, parsePoints, validateHolder, PIONEER_MSG, MEMBER_FALLBACK } from '../shared/pioneer.js';
import { renderPioneerCardPdf } from './pdf/pioneer-card.js';
import { renderPioneerSheetPdf, SHEET } from './pdf/pioneer-sheet.js';

export const PIONEER_COOKIE = 'mg_pioneer';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRef = (prefix) => `${prefix}-` + [...randomBytes(10)].map((b) => ALPHA[b % 32]).join('');
const newCardNo = () => String(randomInt(10_000_000, 100_000_000)); // 8 digits, never a leading zero
// Gift code shown on the approved request's gift card: 60 random bits in three readable groups (no 0/O/1/I).
const newGiftCode = () => 'MG-' + [...randomBytes(12)].map((b, i) => (i && i % 4 === 0 ? '-' : '') + ALPHA[b % 32]).join('');
const newCvv = () => String(randomInt(0, 1000)).padStart(3, '0');
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Failed attempts (per submitted card number) -> lock. Index = failures so far. 10th failure = hard lock (admin unlock).
export const LOCK_AFTER = 3, HARD_LOCK_AFTER = 10;
const LOCK_SECONDS = [30, 120, 600, 1800, 7200, 21600, 86400]; // for failures 3..9
// A few stray typos (never locked) are forgotten after 24 h without attempts; once locked, the count only grows.
const NEXT_FAILURES = `(CASE WHEN g.failures < ${LOCK_AFTER} AND g.last_failed_at < now() - interval '24 hours' THEN 1 ELSE g.failures + 1 END)`;
const lockSql = (n) => `CASE WHEN ${n} >= ${HARD_LOCK_AFTER} THEN 'infinity'::timestamptz WHEN ${n} >= ${LOCK_AFTER} THEN now() + (ARRAY[${LOCK_SECONDS.join(',')}])[${n} - ${LOCK_AFTER - 1}] * interval '1 second' END`;

const M = {
  login: 'Քարտի համարը կամ CVV կոդը սխալ է։',
  locked: 'Չափազանց շատ անհաջող փորձեր այս քարտի համարով։ Փորձեք ավելի ուշ։',
  hardLocked: 'Այս քարտի համարով մուտքը արգելափակված է անվտանգության նկատառումներով։ Դիմեք Magical-ին՝ ապակողպելու համար։',
  inactive: 'Այս քարտը ապաակտիվացված է։ Մանրամասների համար դիմեք Magical-ին։',
  auth: 'Անհրաժեշտ է մուտք գործել Pioneer Card-ով։',
  notFound: 'Չի գտնվել։',
  recipient: 'Այս համարով ակտիվ Pioneer Card չի գտնվել։',
  self: 'Չեք կարող միավորներ փոխանցել ձեր սեփական քարտին։',
  insufficient: 'Բավարար միավորներ չկան։',
  idemKey: 'Անվավեր հարցում։ Թարմացրեք էջը և փորձեք կրկին։',
  idemConflict: 'Այս հարցումն արդեն կատարվել է այլ տվյալներով։ Թարմացրեք էջը։',
  rewardUnavailable: 'Այս պարգևը հասանելի չէ։',
  rewardSoldOut: 'Այս պարգևի սահմանաչափը սպառված է։',
  rewardLimit: 'Դուք արդեն օգտագործել եք այս պարգևի ձեր սահմանաչափը։',
  validation: 'Խնդրում ենք ուղղել նշված դաշտերը։',
  hasRedemptions: 'Այս պարգևն արդեն օգտագործվել է, այն հնարավոր չէ ջնջել։ Արխիվացրեք այն։',
  redemptionState: 'Այս հայտն արդեն մշակված է։',
  redemptionFlow: 'Այս գործողությունը հնարավոր չէ այս հայտի ներկայիս կարգավիճակում։',
  busy: 'Սերվերը զբաղված է։ Փորձեք կրկին։',
};

const iso = (v) => v ?? null;
const cardAdmin = (r) => ({
  id: r.id, number: r.card_no, firstName: r.first_name, lastName: r.last_name, phone: r.phone, balance: r.balance, status: r.status,
  createdAt: r.created_at, updatedAt: iso(r.updated_at), activatedAt: iso(r.activated_at), lastLoginAt: iso(r.last_login_at), cvvResetAt: iso(r.cvv_reset_at),
  cvvOnFile: !!r.cvv_enc, // whether the print sheet can fill in the CVV itself; the code never leaves the server
});
const rewardOut = (r) => ({
  id: r.id, kind: r.kind, title: r.title, description: r.description, icon: r.icon, pointsCost: r.points_cost,
  discountPercent: r.discount_percent, discountAmount: r.discount_amount, status: r.status,
  availableFrom: iso(r.available_from), availableUntil: iso(r.available_until), availabilityNote: r.availability_note,
  maxRedemptions: r.max_redemptions, perCardLimit: r.per_card_limit, redeemedCount: r.redeemed_count, sortOrder: r.sort_order,
  createdAt: r.created_at, updatedAt: iso(r.updated_at),
});
const benefitText = (r) => [r.discount_percent ? `${r.discount_percent}% զեղչ` : '', r.discount_amount ? `${r.discount_amount.toLocaleString('en-US')} ֏ զեղչ` : ''].filter(Boolean).join(' / ');
const redemptionOut = (r) => ({
  id: r.id, reference: r.reference, rewardId: r.reward_id, rewardTitle: r.reward_title, rewardBenefit: r.reward_benefit, points: r.points,
  status: r.status, createdAt: r.created_at, handledAt: iso(r.handled_at), approvedAt: iso(r.approved_at),
  // Only approved (ready) or handed-over requests carry a gift card; pending/cancelled never do.
  giftCard: r.gift_code && (r.status === 'approved' || r.status === 'fulfilled')
    ? { code: r.gift_code, approvedAt: r.approved_at, state: r.status === 'approved' ? 'ready' : 'collected', collectedAt: r.status === 'fulfilled' ? iso(r.handled_at) : null }
    : null,
});
// Cardholder-facing ledger row: the counterparty is shown by name (or "Pioneer Member") and masked number only.
const txOut = (r) => ({
  id: String(r.id), type: r.type, amount: r.amount, balanceAfter: r.balance_after, description: r.description, createdAt: r.created_at,
  reference: r.transfer_ref || r.redemption_ref || null,
  counterparty: r.cp_card_no ? { name: displayName(r.cp_first, r.cp_last), number: maskCardNo(r.cp_card_no) } : null,
});
const TX_SELECT = `SELECT t.*, tr.reference AS transfer_ref, rd.reference AS redemption_ref, cp.card_no AS cp_card_no, cp.first_name AS cp_first, cp.last_name AS cp_last
  FROM pioneer_transactions t LEFT JOIN pioneer_transfers tr ON tr.id = t.transfer_id LEFT JOIN pioneer_redemptions rd ON rd.id = t.redemption_id
  LEFT JOIN pioneer_cards cp ON cp.id = t.counterparty_card_id`;

const searchText = (v) => [v.cardNo, v.firstName, v.lastName, v.phone, v.phone ? v.phone.replace(/^\+374/, '0') : ''].filter(Boolean).join(' ').toLowerCase();

export function registerPioneer({ R, db, config, limiter, guard, params, addSearch, count, intParam }) {
  const pepper = config.pioneerPepper || '';
  // The CVV is bound to its card number and (optionally) peppered with a server-side secret before scrypt,
  // so a database dump alone is not enough to test the 1000 possible codes offline.
  const cvvInput = (cardNo, cvv) => (pepper ? hmacToken(pepper, 'pioneer-cvv', `${cardNo}:${cvv}`) : `${cardNo}:${cvv}`);
  const hashCvv = (cardNo, cvv) => hashPassword(cvvInput(cardNo, cvv));
  const verifyCvv = (cardNo, cvv, hash) => verifyPassword(cvvInput(cardNo, cvv), hash);
  // Encrypted copy for the print sheet (migration 004), written only where the server issues a code. The key is
  // derived from the pepper, so it is never in the database and there is none without a pepper (then: NULL, and
  // the admin types the code at print time). The card number is the GCM associated data: a value only opens for
  // its own card. Old cards have NULL; their codes exist only as hashes and are not recovered.
  const escrowKey = pepper ? Buffer.from(hkdfSync('sha256', pepper, 'magical-pioneer', 'cvv-escrow-v1', 32)) : null;
  const sealCvv = (cardNo, cvv) => {
    if (!escrowKey) return null;
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', escrowKey, iv);
    c.setAAD(Buffer.from('pioneer-card:' + cardNo));
    const ct = Buffer.concat([c.update(cvv, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  };
  const openCvv = (cardNo, enc) => {
    if (!escrowKey || !enc) return null;
    try {
      const [v, iv, tag, ct] = enc.split('.');
      if (v !== 'v1') return null;
      const d = createDecipheriv('aes-256-gcm', escrowKey, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from('pioneer-card:' + cardNo)); d.setAuthTag(Buffer.from(tag, 'base64url'));
      const cvv = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
      return /^\d{3}$/.test(cvv) ? cvv : null;
    } catch { return null; } // other key (pepper changed) or tampered value: treated as not on file
  };

  // Abuse limits keyed by card (in memory, per process); disabled together with the other limits by config.rateLimits.
  const limit = (key, n, windowMs, msg = 'Չափազանց շատ հարցումներ։ Խնդրում ենք փորձել մի փոքր ուշ։') => {
    if (!config.rateLimits) return;
    const r = limiter.take(key, n, windowMs);
    if (!r.ok) { const e = new HttpError(429, 'rate_limited', msg); e.retryAfter = r.retryAfter; throw e; }
  };
  const idemKey = (ctx) => {
    const key = String(ctx.req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'bad_idempotency_key', M.idemKey);
    return sha256(key);
  };
  const countIn = async (c, sql, args) => (await c.query(sql, args)).rows[0].c; // inside a transaction: same client, never a second pool connection
  const initialBonus = async (c = db) => (await c.query('SELECT initial_bonus FROM pioneer_settings WHERE id')).rows[0]?.initial_bonus ?? 200;
  const audit = (c, ctx, action, cardId, details = {}) =>
    c.query('INSERT INTO pioneer_audit_log (admin_id, admin_name, action, card_id, details) VALUES ($1, $2, $3, $4, $5)', [ctx.session.admin_id, ctx.session.username, action, cardId, JSON.stringify(details)]);

  // ---------- cardholder sessions ------------------------------------------------
  const cookie = (value, maxAge) => `${PIONEER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;
  const sessionFrom = async (req) => {
    const raw = parseCookies(req.headers.cookie)[PIONEER_COOKIE];
    if (!raw || raw.length > 100) return null;
    const { rows } = await db.query(
      `SELECT s.token_hash, s.csrf_token, c.id AS card_id FROM pioneer_sessions s JOIN pioneer_cards c ON c.id = s.card_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND c.status = 'active'`, [sha256(raw)]);
    return rows[0] || null;
  };

  // Card number + CVV check with the per-card lockout. Shared by the cardholder login and the integration API
  // (server/integration.js), so both draw on ONE failure budget per card number.
  // Returns { locked, hard, retryAfter } | { ok: false, attemptsBeforeLock } | { ok: true, card }.
  const checkCredentials = async (cardNo, cvv) => {
    // Count the attempt BEFORE verifying (atomic upsert), unless the number is currently locked.
    // Real and non-existent card numbers go through exactly the same path.
    const g = (await db.query(
      `INSERT INTO pioneer_login_guard AS g (card_no, failures, locked_until) VALUES ($1, 1, ${lockSql(1)})
       ON CONFLICT (card_no) DO UPDATE SET failures = ${NEXT_FAILURES}, last_failed_at = now(), locked_until = ${lockSql(NEXT_FAILURES)}
       WHERE g.locked_until IS NULL OR g.locked_until <= now() RETURNING failures`, [cardNo])).rows[0];
    if (!g) {
      const until = (await db.query(`SELECT locked_until = 'infinity' AS hard, CASE WHEN locked_until = 'infinity' THEN NULL ELSE GREATEST(1, CEIL(EXTRACT(EPOCH FROM locked_until - now())))::int END AS secs FROM pioneer_login_guard WHERE card_no = $1`, [cardNo])).rows[0];
      return { locked: true, hard: !!until?.hard, retryAfter: until?.hard ? null : until?.secs ?? 1 };
    }
    const card = (await db.query('SELECT id, card_no, cvv_hash, status FROM pioneer_cards WHERE card_no = $1', [cardNo])).rows[0];
    const ok = await verifyCvv(cardNo, cvv, card ? card.cvv_hash : DUMMY_HASH); // same scrypt cost either way
    if (!card || !ok) return { ok: false, attemptsBeforeLock: Math.max(0, (g.failures < LOCK_AFTER ? LOCK_AFTER : HARD_LOCK_AFTER) - g.failures) };
    await db.query('DELETE FROM pioneer_login_guard WHERE card_no = $1', [cardNo]);
    return { ok: true, card: { id: card.id, card_no: card.card_no, status: card.status } };
  };

  R('POST', '/api/pioneer/login', {}, async (ctx) => {
    guard(ctx, 'pc-login-ip', 15, 15 * 60_000);
    guard(ctx, 'pc-login-ip-day', 60, 24 * 3600_000);
    const body = await readJson(ctx.req, 1000);
    const cardNo = normalizeCardNo(body.cardNumber), cvv = normalizeCvv(body.cvv);
    if (!cardNo || !cvv) throw new HttpError(422, 'validation_failed', M.validation, { ...(!cardNo && { cardNumber: PIONEER_MSG.cardNumber }), ...(!cvv && { cvv: PIONEER_MSG.cvv }) });
    const v = await checkCredentials(cardNo, cvv);
    if (v.locked) { const e = new HttpError(429, v.hard ? 'card_locked' : 'too_many_attempts', v.hard ? M.hardLocked : M.locked); if (!v.hard) e.retryAfter = v.retryAfter; throw e; }
    if (!v.ok) throw new HttpError(401, 'invalid_credentials', M.login, { attemptsBeforeLock: v.attemptsBeforeLock });
    const card = v.card;
    if (card.status !== 'active') throw new HttpError(403, 'card_inactive', M.inactive);
    // New session id on every login; the previous cookie (if any) is revoked.
    const old = parseCookies(ctx.req.headers.cookie)[PIONEER_COOKIE];
    const token = randomToken(32), csrf = randomToken(24);
    await withTransaction(db, async (c) => {
      if (old && old.length <= 100) await c.query('DELETE FROM pioneer_sessions WHERE token_hash = $1', [sha256(old)]);
      await c.query('DELETE FROM pioneer_sessions WHERE expires_at < now()');
      await c.query(`INSERT INTO pioneer_sessions (token_hash, card_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + ($4::int * interval '1 hour'))`, [sha256(token), card.id, csrf, config.pioneerSessionHours]);
      await c.query('UPDATE pioneer_cards SET activated_at = COALESCE(activated_at, now()), last_login_at = now() WHERE id = $1', [card.id]);
    });
    sendJson(ctx.res, 200, { ok: true, csrfToken: csrf }, { 'Set-Cookie': cookie(token, config.pioneerSessionHours * 3600) });
  });

  R('POST', '/api/pioneer/logout', { pioneer: true }, async (ctx) => {
    await db.query('DELETE FROM pioneer_sessions WHERE token_hash = $1', [ctx.pioneer.token_hash]);
    sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  });

  const accountSummary = async (cardId) => {
    const card = (await db.query('SELECT * FROM pioneer_cards WHERE id = $1', [cardId])).rows[0];
    const sums = Object.fromEntries((await db.query('SELECT type, SUM(amount)::int AS s FROM pioneer_transactions WHERE card_id = $1 GROUP BY type', [cardId])).rows.map((r) => [r.type, r.s]));
    const v = (k) => Math.abs(sums[k] || 0);
    return {
      card: { number: card.card_no, firstName: card.first_name, lastName: card.last_name, displayName: displayName(card.first_name, card.last_name), hasName: !!(card.first_name || card.last_name), memberSince: card.created_at },
      balance: card.balance,
      stats: {
        earned: v('initial_bonus') + v('admin_credit') + v('partner_credit'), received: v('transfer_in'), transferred: v('transfer_out'),
        spent: v('redemption') - v('redemption_refund') + v('partner_redemption'), deducted: v('admin_debit'),
      },
    };
  };
  R('GET', '/api/pioneer/me', { pioneer: true }, async (ctx) => {
    const recent = (await db.query(`${TX_SELECT} WHERE t.card_id = $1 ORDER BY t.id DESC LIMIT 5`, [ctx.pioneer.card_id])).rows.map(txOut);
    sendJson(ctx.res, 200, { ...(await accountSummary(ctx.pioneer.card_id)), recent, csrfToken: ctx.pioneer.csrf_token }, NO_STORE);
  });
  R('GET', '/api/pioneer/transactions', { pioneer: true }, async (ctx) => {
    const q = ctx.url.searchParams, pageSize = intParam(q.get('pageSize'), 20, 1, 50);
    const total = await count('SELECT COUNT(*)::int AS c FROM pioneer_transactions WHERE card_id = $1', [ctx.pioneer.card_id]);
    const page = Math.min(intParam(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query(`${TX_SELECT} WHERE t.card_id = $1 ORDER BY t.id DESC LIMIT $2 OFFSET $3`, [ctx.pioneer.card_id, pageSize, (page - 1) * pageSize]);
    sendJson(ctx.res, 200, { items: rows.map(txOut), total, page, pageSize }, NO_STORE);
  });

  // Rewards visible to cardholders: published, not ended. Upcoming ones are returned locked (canRedeem=false).
  R('GET', '/api/pioneer/rewards', { pioneer: true }, async (ctx) => {
    const { rows } = await db.query(
      `SELECT r.*, (r.available_from IS NOT NULL AND r.available_from > now()) AS upcoming,
              (SELECT COUNT(*)::int FROM pioneer_redemptions d WHERE d.reward_id = r.id AND d.card_id = $1 AND d.status <> 'cancelled') AS mine
       FROM pioneer_rewards r WHERE r.status = 'published' AND (r.available_until IS NULL OR r.available_until > now()) ORDER BY r.sort_order, r.points_cost, r.id`, [ctx.pioneer.card_id]);
    const items = rows.map((r) => {
      const soldOut = r.max_redemptions != null && r.redeemed_count >= r.max_redemptions;
      const limitReached = r.per_card_limit != null && r.mine >= r.per_card_limit;
      const out = rewardOut(r);
      delete out.redeemedCount; delete out.status; delete out.sortOrder; delete out.createdAt; delete out.updatedAt; delete out.maxRedemptions;
      return { ...out, upcoming: r.upcoming, soldOut, limitReached, redeemedByMe: r.mine, available: !r.upcoming && !soldOut && !limitReached };
    });
    sendJson(ctx.res, 200, { items }, NO_STORE);
  });
  R('GET', '/api/pioneer/announcements', { pioneer: true }, async (ctx) => {
    const { rows } = await db.query("SELECT id, title, body, created_at FROM pioneer_announcements WHERE status = 'published' ORDER BY created_at DESC, id DESC LIMIT 10");
    sendJson(ctx.res, 200, { items: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at })) }, NO_STORE);
  });
  R('GET', '/api/pioneer/redemptions', { pioneer: true }, async (ctx) => {
    const { rows } = await db.query('SELECT * FROM pioneer_redemptions WHERE card_id = $1 ORDER BY id DESC LIMIT 100', [ctx.pioneer.card_id]);
    sendJson(ctx.res, 200, { items: rows.map(redemptionOut) }, NO_STORE);
  });

  R('POST', '/api/pioneer/redemptions', { pioneer: true }, async (ctx) => {
    limit(`pc-redeem:${ctx.pioneer.card_id}`, 20, 60 * 60_000);
    const idem = idemKey(ctx);
    const body = await readJson(ctx.req, 1000);
    const rewardId = Number.isSafeInteger(body.rewardId) && body.rewardId > 0 ? body.rewardId : /^\d{1,9}$/.test(String(body.rewardId ?? '')) ? Number(body.rewardId) : 0;
    if (!rewardId) throw new HttpError(422, 'validation_failed', M.validation, { rewardId: M.rewardUnavailable });
    const result = await withTransaction(db, async (c) => {
      const card = (await c.query('SELECT id, balance, status FROM pioneer_cards WHERE id = $1 FOR UPDATE', [ctx.pioneer.card_id])).rows[0];
      if (!card || card.status !== 'active') throw new HttpError(403, 'card_inactive', M.inactive);
      const prev = (await c.query('SELECT * FROM pioneer_redemptions WHERE card_id = $1 AND idempotency_hash = $2', [card.id, idem])).rows[0];
      if (prev) { if (prev.reward_id !== rewardId) throw new HttpError(409, 'idempotency_conflict', M.idemConflict); return { row: prev, replay: true }; }
      const r = (await c.query('SELECT * FROM pioneer_rewards WHERE id = $1 FOR UPDATE', [rewardId])).rows[0];
      const now = Date.now();
      if (!r || r.status !== 'published' || (r.available_from && Date.parse(r.available_from) > now) || (r.available_until && Date.parse(r.available_until) <= now))
        throw new HttpError(422, 'reward_unavailable', M.rewardUnavailable);
      if (r.max_redemptions != null && r.redeemed_count >= r.max_redemptions) throw new HttpError(422, 'reward_sold_out', M.rewardSoldOut);
      if (r.per_card_limit != null) {
        const mine = await countIn(c, "SELECT COUNT(*)::int AS c FROM pioneer_redemptions WHERE reward_id = $1 AND card_id = $2 AND status <> 'cancelled'", [r.id, card.id]);
        if (mine >= r.per_card_limit) throw new HttpError(422, 'reward_limit', M.rewardLimit);
      }
      if (card.balance < r.points_cost) throw new HttpError(422, 'insufficient_points', M.insufficient);
      const row = (await c.query(
        `INSERT INTO pioneer_redemptions (reference, card_id, reward_id, points, reward_title, reward_benefit, idempotency_hash) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [newRef('RD'), card.id, r.id, r.points_cost, r.title, benefitText(r), idem])).rows[0];
      await c.query(`INSERT INTO pioneer_transactions (card_id, type, amount, description, redemption_id) VALUES ($1, 'redemption', $2, $3, $4)`, [card.id, -r.points_cost, r.title, row.id]);
      await c.query('UPDATE pioneer_rewards SET redeemed_count = redeemed_count + 1 WHERE id = $1', [r.id]);
      return { row, replay: false };
    });
    const balance = (await db.query('SELECT balance FROM pioneer_cards WHERE id = $1', [ctx.pioneer.card_id])).rows[0].balance;
    sendJson(ctx.res, result.replay ? 200 : 201, { redemption: redemptionOut(result.row), balance }, NO_STORE);
  });

  // ---------- transfers ------------------------------------------------------------
  const activeCardByNo = async (c, cardNo) => (cardNo ? (await c.query("SELECT id, card_no, first_name, last_name FROM pioneer_cards WHERE card_no = $1 AND status = 'active'", [cardNo])).rows[0] : null);
  const recipientOut = (r) => ({ name: displayName(r.first_name, r.last_name), hasName: !!(r.first_name || r.last_name), number: maskCardNo(r.card_no) });

  R('POST', '/api/pioneer/recipient', { pioneer: true }, async (ctx) => {
    limit(`pc-lookup:${ctx.pioneer.card_id}`, 30, 60 * 60_000); // limits card-number enumeration
    const body = await readJson(ctx.req, 1000);
    const cardNo = normalizeCardNo(body.cardNumber);
    if (!cardNo) throw new HttpError(422, 'validation_failed', M.validation, { cardNumber: PIONEER_MSG.cardNumber });
    const r = await activeCardByNo(db, cardNo);
    if (!r) throw new HttpError(404, 'recipient_not_found', M.recipient);
    if (r.id === ctx.pioneer.card_id) throw new HttpError(422, 'self_transfer', M.self);
    sendJson(ctx.res, 200, { recipient: recipientOut(r) }, NO_STORE);
  });

  R('POST', '/api/pioneer/transfers', { pioneer: true }, async (ctx) => {
    limit(`pc-transfer:${ctx.pioneer.card_id}`, 20, 60 * 60_000);
    const idem = idemKey(ctx);
    const body = await readJson(ctx.req, 1000);
    const cardNo = normalizeCardNo(body.cardNumber), amount = parsePoints(body.amount);
    if (!cardNo || !amount) throw new HttpError(422, 'validation_failed', M.validation, { ...(!cardNo && { cardNumber: PIONEER_MSG.cardNumber }), ...(!amount && { amount: PIONEER_MSG.amount }) });
    const senderId = ctx.pioneer.card_id;
    const replay = async () => {
      const prev = (await db.query('SELECT t.*, c.card_no, c.first_name, c.last_name FROM pioneer_transfers t JOIN pioneer_cards c ON c.id = t.recipient_card_id WHERE t.sender_card_id = $1 AND t.idempotency_hash = $2', [senderId, idem])).rows[0];
      if (prev && (prev.card_no !== cardNo || prev.amount !== amount)) throw new HttpError(409, 'idempotency_conflict', M.idemConflict);
      return prev ? { t: prev, rcp: prev, replay: true } : null;
    };
    const run = () => withTransaction(db, async (c) => {
      const rcp = await activeCardByNo(c, cardNo);
      if (!rcp) throw new HttpError(404, 'recipient_not_found', M.recipient);
      if (rcp.id === senderId) throw new HttpError(422, 'self_transfer', M.self);
      // Lock both cards in id order (no deadlocks); re-check state under the lock.
      const locked = (await c.query('SELECT id, balance, status FROM pioneer_cards WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [[senderId, rcp.id]])).rows;
      const s = locked.find((x) => x.id === senderId), r = locked.find((x) => x.id === rcp.id);
      if (!s || s.status !== 'active') throw new HttpError(403, 'card_inactive', M.inactive);
      const prev = (await c.query('SELECT * FROM pioneer_transfers WHERE sender_card_id = $1 AND idempotency_hash = $2', [senderId, idem])).rows[0];
      if (prev) {
        if (prev.recipient_card_id !== rcp.id || prev.amount !== amount) throw new HttpError(409, 'idempotency_conflict', M.idemConflict);
        return { t: prev, rcp, replay: true };
      }
      if (!r || r.status !== 'active') throw new HttpError(404, 'recipient_not_found', M.recipient);
      if (s.balance < amount) throw new HttpError(422, 'insufficient_points', M.insufficient);
      const t = (await c.query('INSERT INTO pioneer_transfers (reference, sender_card_id, recipient_card_id, amount, idempotency_hash) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [newRef('TR'), senderId, rcp.id, amount, idem])).rows[0];
      const sides = [[senderId, 'transfer_out', -amount, rcp.id], [rcp.id, 'transfer_in', amount, senderId]].sort((a, b) => a[0] - b[0]);
      for (const [card, type, amt, cp] of sides)
        await c.query('INSERT INTO pioneer_transactions (card_id, type, amount, transfer_id, counterparty_card_id) VALUES ($1, $2, $3, $4, $5)', [card, type, amt, t.id, cp]);
      return { t, rcp, replay: false };
    });
    let out = await replay();
    if (!out) {
      try { out = await run(); } catch (e) { if (!isUnique(e, 'idem') || !(out = await replay())) throw e; } // a concurrent duplicate won the race
    }
    const balance = (await db.query('SELECT balance FROM pioneer_cards WHERE id = $1', [senderId])).rows[0].balance;
    sendJson(ctx.res, out.replay ? 200 : 201, { transfer: { reference: out.t.reference, amount: out.t.amount, createdAt: out.t.created_at, recipient: recipientOut(out.rcp) }, balance }, NO_STORE);
  });

  // ---------- admin: cards ------------------------------------------------------------
  const A = '/api/admin/pioneer';
  const cardById = async (c, id, lock = false) => {
    const r = /^\d{1,9}$/.test(String(id)) ? (await c.query(`SELECT * FROM pioneer_cards WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id)])).rows[0] : null;
    if (!r) throw new HttpError(404, 'not_found', M.notFound);
    return r;
  };
  const holderOr422 = (body) => {
    const v = validateHolder(body);
    if (!v.ok) throw new HttpError(422, 'validation_failed', M.validation, v.errors);
    return v.values;
  };

  R('GET', `${A}/stats`, { auth: true }, async (ctx) => {
    const r = (await db.query(`SELECT COUNT(*)::int AS cards, COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(activated_at)::int AS activated, COALESCE(SUM(balance), 0)::int AS points FROM pioneer_cards`)).rows[0];
    const pending = await count("SELECT COUNT(*)::int AS c FROM pioneer_redemptions WHERE status = 'pending'", []);
    const approved = await count("SELECT COUNT(*)::int AS c FROM pioneer_redemptions WHERE status = 'approved'", []);
    sendJson(ctx.res, 200, { ...r, pendingRedemptions: pending, approvedRedemptions: approved, initialBonus: await initialBonus() }, NO_STORE);
  });

  R('GET', `${A}/cards`, { auth: true }, async (ctx) => {
    const q = ctx.url.searchParams, p = params();
    const status = ['active', 'inactive'].includes(q.get('status')) ? q.get('status') : null;
    const where = `TRUE${status ? ` AND status = ${p.add(status)}` : ''}${addSearch(p, String(q.get('q') || '').replace(/(\d{4})\s+(\d{4})/, '$1$2'))}`;
    const pageSize = intParam(q.get('pageSize'), 25, 1, 100);
    const total = await count(`SELECT COUNT(*)::int AS c FROM pioneer_cards WHERE ${where}`, p.list.slice());
    const page = Math.min(intParam(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query(`SELECT * FROM pioneer_cards WHERE ${where} ORDER BY id DESC LIMIT ${p.add(pageSize)} OFFSET ${p.add((page - 1) * pageSize)}`, p.list);
    sendJson(ctx.res, 200, { items: rows.map(cardAdmin), total, page, pageSize }, NO_STORE);
  });

  R('POST', `${A}/cards`, { auth: true }, async (ctx) => {
    guard(ctx, 'pc-admin-create', 120, 10 * 60_000);
    const v = holderOr422(await readJson(ctx.req, 2000));
    const cvv = newCvv();
    for (let attempt = 0; attempt < 8; attempt++) {
      const cardNo = newCardNo();
      const cvvHash = await hashCvv(cardNo, cvv);
      try {
        const card = await withTransaction(db, async (c) => {
          const row = (await c.query(
            `INSERT INTO pioneer_cards (card_no, cvv_hash, cvv_enc, first_name, last_name, phone, search_text, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [cardNo, cvvHash, sealCvv(cardNo, cvv), v.firstName, v.lastName, v.phone, searchText({ cardNo, ...v }), ctx.session.admin_id])).rows[0];
          const bonus = await initialBonus(c);
          if (bonus > 0) await c.query(`INSERT INTO pioneer_transactions (card_id, type, amount, description) VALUES ($1, 'initial_bonus', $2, 'Pioneer Card-ի մեկնարկային բոնուս')`, [row.id, bonus]);
          await audit(c, ctx, 'card.create', row.id, { number: cardNo, initialBonus: bonus, named: !!(v.firstName || v.lastName), phone: !!v.phone });
          return (await c.query('SELECT * FROM pioneer_cards WHERE id = $1', [row.id])).rows[0];
        });
        // The CVV is returned exactly once, here, so the physical card can be prepared. It is not retrievable later.
        return sendJson(ctx.res, 201, { card: cardAdmin(card), cvv }, NO_STORE);
      } catch (e) {
        if (isUnique(e, 'card_no')) continue; // random collision: try another number
        throw e;
      }
    }
    throw new HttpError(503, 'busy', M.busy);
  });

  R('GET', `${A}/cards/:id`, { auth: true }, async (ctx) => {
    const card = await cardById(db, ctx.params.id);
    const g = (await db.query(`SELECT failures, locked_until > now() AS locked, locked_until = 'infinity' AS hard, CASE WHEN locked_until = 'infinity' THEN NULL ELSE locked_until END AS until FROM pioneer_login_guard WHERE card_no = $1`, [card.card_no])).rows[0];
    const redemptions = (await db.query('SELECT * FROM pioneer_redemptions WHERE card_id = $1 ORDER BY id DESC LIMIT 100', [card.id])).rows.map(redemptionOut);
    const sessions = await count('SELECT COUNT(*)::int AS c FROM pioneer_sessions WHERE card_id = $1 AND expires_at > now()', [card.id]);
    sendJson(ctx.res, 200, { card: cardAdmin(card), login: { failures: g?.failures || 0, locked: !!g?.locked, hardLocked: !!g?.hard, lockedUntil: g?.until || null, activeSessions: sessions }, redemptions }, NO_STORE);
  });

  R('GET', `${A}/cards/:id/transactions`, { auth: true }, async (ctx) => {
    const card = await cardById(db, ctx.params.id);
    const q = ctx.url.searchParams, pageSize = intParam(q.get('pageSize'), 20, 1, 100);
    const total = await count('SELECT COUNT(*)::int AS c FROM pioneer_transactions WHERE card_id = $1', [card.id]);
    const page = Math.min(intParam(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query(`${TX_SELECT.replace('SELECT t.*', 'SELECT t.*, a.username AS admin_name')} LEFT JOIN admins a ON a.id = t.admin_id WHERE t.card_id = $1 ORDER BY t.id DESC LIMIT $2 OFFSET $3`, [card.id, pageSize, (page - 1) * pageSize]);
    sendJson(ctx.res, 200, { items: rows.map((r) => ({ ...txOut(r), counterparty: r.cp_card_no ? { name: displayName(r.cp_first, r.cp_last), number: r.cp_card_no } : null, admin: r.admin_name || null })), total, page, pageSize }, NO_STORE);
  });

  R('PATCH', `${A}/cards/:id`, { auth: true }, async (ctx) => {
    const body = await readJson(ctx.req, 2000);
    const card = await withTransaction(db, async (c) => {
      const cur = await cardById(c, ctx.params.id, true);
      const v = holderOr422({ firstName: body.firstName ?? cur.first_name, lastName: body.lastName ?? cur.last_name, phone: body.phone ?? cur.phone });
      const row = (await c.query('UPDATE pioneer_cards SET first_name = $1, last_name = $2, phone = $3, search_text = $4, updated_at = now() WHERE id = $5 RETURNING *',
        [v.firstName, v.lastName, v.phone, searchText({ cardNo: cur.card_no, ...v }), cur.id])).rows[0];
      const changed = ['first_name', 'last_name', 'phone'].filter((k) => cur[k] !== row[k]);
      if (changed.length) await audit(c, ctx, 'card.update_holder', cur.id, { changed });
      return row;
    });
    sendJson(ctx.res, 200, { card: cardAdmin(card) }, NO_STORE);
  });

  R('POST', `${A}/cards/:id/status`, { auth: true }, async (ctx) => {
    const body = await readJson(ctx.req, 500);
    if (!['active', 'inactive'].includes(body.status)) throw new HttpError(422, 'validation_failed', M.validation, { status: 'Անվավեր կարգավիճակ։' });
    const card = await withTransaction(db, async (c) => {
      const cur = await cardById(c, ctx.params.id, true);
      const row = (await c.query('UPDATE pioneer_cards SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [body.status, cur.id])).rows[0];
      if (body.status === 'inactive') await c.query('DELETE FROM pioneer_sessions WHERE card_id = $1', [cur.id]);
      if (cur.status !== body.status) await audit(c, ctx, body.status === 'active' ? 'card.activate' : 'card.deactivate', cur.id);
      return row;
    });
    sendJson(ctx.res, 200, { card: cardAdmin(card) }, NO_STORE);
  });

  R('POST', `${A}/cards/:id/cvv`, { auth: true }, async (ctx) => {
    guard(ctx, 'pc-admin-cvv', 30, 10 * 60_000);
    const cur = await cardById(db, ctx.params.id);
    const cvv = newCvv(), hash = await hashCvv(cur.card_no, cvv);
    await withTransaction(db, async (c) => {
      await c.query('UPDATE pioneer_cards SET cvv_hash = $1, cvv_enc = $2, cvv_reset_at = now(), updated_at = now() WHERE id = $3', [hash, sealCvv(cur.card_no, cvv), cur.id]);
      await c.query('DELETE FROM pioneer_sessions WHERE card_id = $1', [cur.id]);   // sign out everywhere
      await c.query('DELETE FROM pioneer_login_guard WHERE card_no = $1', [cur.card_no]);
      await audit(c, ctx, 'card.cvv_reset', cur.id);                                 // never the code itself
    });
    sendJson(ctx.res, 200, { cvv }, NO_STORE);
  });

  R('POST', `${A}/cards/:id/unlock`, { auth: true }, async (ctx) => {
    const cur = await cardById(db, ctx.params.id);
    await withTransaction(db, async (c) => {
      const n = (await c.query('DELETE FROM pioneer_login_guard WHERE card_no = $1', [cur.card_no])).rowCount;
      if (n) await audit(c, ctx, 'card.unlock', cur.id);
    });
    sendJson(ctx.res, 200, { ok: true }, NO_STORE);
  });

  R('POST', `${A}/cards/:id/adjust`, { auth: true }, async (ctx) => {
    const body = await readJson(ctx.req, 2000);
    const amount = parsePoints(body.amount, { allowNegative: true });
    const reason = clean(body.reason);
    const errors = { ...(!amount && { amount: PIONEER_MSG.adjust }), ...(([...reason].length < 3 || [...reason].length > 300) && { reason: PIONEER_MSG.reason }) };
    if (Object.keys(errors).length) throw new HttpError(422, 'validation_failed', M.validation, errors);
    const card = await withTransaction(db, async (c) => {
      const cur = await cardById(c, ctx.params.id, true);
      if (cur.balance + amount < 0) throw new HttpError(422, 'insufficient_points', `${M.insufficient} Ընթացիկ մնացորդը՝ ${cur.balance}։`, { amount: `Առավելագույն նվազեցումը՝ ${cur.balance}։` });
      await c.query('INSERT INTO pioneer_transactions (card_id, type, amount, description, admin_id) VALUES ($1, $2, $3, $4, $5)', [cur.id, amount > 0 ? 'admin_credit' : 'admin_debit', amount, reason, ctx.session.admin_id]);
      await audit(c, ctx, 'points.adjust', cur.id, { amount, reason });
      return (await c.query('SELECT * FROM pioneer_cards WHERE id = $1', [cur.id])).rows[0];
    });
    sendJson(ctx.res, 200, { card: cardAdmin(card) }, NO_STORE);
  });

  R('GET', `${A}/cards/:id/pdf`, { auth: true }, async (ctx) => {
    const card = await cardById(db, ctx.params.id);
    const pdf = await renderPioneerCardPdf({ number: card.card_no, firstName: card.first_name, lastName: card.last_name });
    sendBuffer(ctx.res, 200, pdf, 'application/pdf', { 'Content-Disposition': `attachment; filename="magical-pioneer-card-${card.card_no}.pdf"` });
  });

  // A4 print sheet for 1-8 selected cards: one page, fronts only, each with its CVV. The CVV comes from the encrypted copy made
  // when the code was issued (cvv_enc); for older cards, which only have the hash, the admin types it. Either way it
  // is checked against the card's hash before anything is printed. Codes never leave the server except inside the
  // PDF, are never logged, and the PDF is not kept.
  // Wrong codes are counted per card: 5 in an hour block that card here, so this cannot be used to guess a CVV.
  const printMisses = new Map(); // card id -> timestamps of wrong codes (in memory, this process)
  const recentMisses = (id) => {
    const t = (printMisses.get(id) || []).filter((x) => x > Date.now() - 3600_000);
    if (t.length) printMisses.set(id, t); else printMisses.delete(id);
    return t;
  };
  R('POST', `${A}/cards/print-sheet`, { auth: true }, async (ctx) => {
    guard(ctx, 'pc-admin-print', 30, 10 * 60_000);
    const body = await readJson(ctx.req, 4000);
    const items = Array.isArray(body.cards) ? body.cards : [];
    const bad = (fields) => { throw new HttpError(422, 'validation_failed', M.validation, fields); };
    if (items.length < 1) bad({ cards: 'Ընտրեք առնվազն 1 քարտ։' });
    if (items.length > SHEET.MAX) bad({ cards: `Մեկ թերթում կարելի է տպել առավելագույնը ${SHEET.MAX} քարտ։` });
    const ids = items.map((it) => (/^\d{1,9}$/.test(String(it?.id ?? '')) ? Number(it.id) : null));
    if (ids.includes(null)) bad({ cards: 'Անվավեր քարտ։' });
    if (new Set(ids).size !== ids.length) bad({ cards: 'Նույն քարտը ընտրված է մեկից ավելի անգամ։' });
    // A typed code is optional: without one the stored (encrypted) code is used. A typed code must be well-formed.
    const typed = items.map((it) => (it?.cvv == null || it.cvv === '' ? null : normalizeCvv(it.cvv) || false));
    const badCvv = Object.fromEntries(ids.filter((id, i) => typed[i] === false).map((id) => [`cvv.${id}`, PIONEER_MSG.cvv]));
    if (Object.keys(badCvv).length) bad(badCvv);

    const rows = new Map((await db.query('SELECT * FROM pioneer_cards WHERE id = ANY($1::int[])', [ids])).rows.map((r) => [r.id, r]));
    const absent = ids.filter((id) => !rows.has(id));
    if (absent.length) throw new HttpError(404, 'not_found', M.notFound, Object.fromEntries(absent.map((id) => [`card.${id}`, 'Քարտը չի գտնվել։'])));
    const inactive = ids.filter((id) => rows.get(id).status !== 'active');
    if (inactive.length) bad(Object.fromEntries(inactive.map((id) => [`card.${id}`, 'Քարտն ապաակտիվացված է․ տպել կարելի է միայն ակտիվ քարտեր։'])));
    const blocked = ids.filter((id, i) => typed[i] && recentMisses(id).length >= 5);
    if (blocked.length) throw new HttpError(429, 'rate_limited', 'Չափազանց շատ սխալ CVV այս քարտի համար։ Փորձեք մեկ ժամից կամ վերականգնեք CVV-ն։',
      Object.fromEntries(blocked.map((id) => [`cvv.${id}`, 'Արգելափակված է մեկ ժամով՝ սխալ CVV-ների պատճառով։'])));

    // Every code, typed or stored, is checked against this card's own hash before it can reach the sheet.
    const cvvs = [], source = [], wrong = [], unavailable = [];
    for (let i = 0; i < ids.length; i++) {
      const r = rows.get(ids[i]);
      const code = typed[i] || openCvv(r.card_no, r.cvv_enc);
      if (code && await verifyCvv(r.card_no, code, r.cvv_hash)) { cvvs[i] = code; source[i] = typed[i] ? 'entered' : 'stored'; }
      else if (typed[i]) wrong.push(ids[i]);
      else unavailable.push(ids[i]); // never stored (card issued before migration 004), or no longer valid
    }
    for (const id of wrong) { recentMisses(id); printMisses.set(id, [...(printMisses.get(id) || []), Date.now()]); await audit(db, ctx, 'card.print_cvv_mismatch', id); }
    if (wrong.length || unavailable.length) {
      throw new HttpError(422, wrong.length ? 'cvv_mismatch' : 'cvv_unavailable', wrong.length ? 'Որոշ CVV կոդեր չեն համապատասխանում քարտերին։ Ոչինչ չի տպվել։' : 'Որոշ քարտերի CVV-ն պահված չէ համակարգում։ Ոչինչ չի տպվել։', {
        ...Object.fromEntries(wrong.map((id) => [`cvv.${id}`, 'CVV-ն չի համապատասխանում այս քարտին։'])),
        ...Object.fromEntries(unavailable.map((id) => [`cvv.${id}`, 'Այս քարտի CVV-ն պահված չէ (քարտը ստեղծվել է մինչ ավտոմատ CVV-ն)։ Մուտքագրեք այն կամ վերականգնեք CVV-ն։'])),
      });
    }
    for (const id of ids) printMisses.delete(id);

    const cards = ids.map((id, i) => { const r = rows.get(id); return { number: r.card_no, firstName: r.first_name, lastName: r.last_name, cvv: cvvs[i] }; });
    const pdf = await renderPioneerSheetPdf(cards);
    // On request (body.keepEntered, the dialog's checkbox), a typed code that has just matched the hash is kept the
    // same way as an issued one, so a card from before migration 004 prints automatically next time. This is the
    // cardholder's existing code, not a new one: no CVV change, no sign-out. Only fills an empty/unusable copy, and
    // only while the hash is still the one just checked (a concurrent CVV reset wins).
    const keep = body.keepEntered === true && escrowKey ? ids.filter((id, i) => source[i] === 'entered' && !openCvv(rows.get(id).card_no, rows.get(id).cvv_enc)) : [];
    let kept = 0;
    await withTransaction(db, async (c) => {
      for (let i = 0; i < ids.length; i++) await audit(c, ctx, 'card.print', ids[i], { batch: ids.length, position: i + 1, cvv: source[i] }); // 'stored' | 'entered', never the code
      for (const id of keep) {
        const r = rows.get(id), i = ids.indexOf(id);
        const n = (await c.query('UPDATE pioneer_cards SET cvv_enc = $1 WHERE id = $2 AND cvv_hash = $3', [sealCvv(r.card_no, cvvs[i]), id, r.cvv_hash])).rowCount;
        if (n) { kept++; await audit(c, ctx, 'card.cvv_stored', id, { via: 'print' }); }
      }
    });
    const day = new Date().toISOString().slice(0, 10);
    sendBuffer(ctx.res, 200, pdf, 'application/pdf', { ...NO_STORE, 'X-Pioneer-Cvv-Kept': String(kept), 'Content-Disposition': `attachment; filename="magical-pioneer-cards-${day}-${ids.length}.pdf"` });
  });

  // ---------- admin: bulk retire ("delete") ------------------------------------------------------
  // Permanent deletion is not offered. Every card made by the app has an immutable ledger row (initial bonus,
  // trigger pioneer_ledger_immutable) and a card.create audit entry, and transactions, transfers (both sides),
  // redemptions and the audit log all reference pioneer_cards without ON DELETE: removing a card would mean
  // destroying financial history that other cards' history also points to. "Delete" therefore retires cards:
  // the existing deactivation (status 'inactive', sessions ended), reversible with «Ակտիվացնել», nothing else
  // changes: balances, ledger, transfers, redemptions, gift codes and audit stay exactly as they are.
  const BULK_MAX = 5000;
  const bulkRows = async (c, body, lock = false) => {
    const tail = `ORDER BY id${lock ? ' FOR UPDATE' : ''}`;
    if (body.all === true) return { scope: 'all', rows: (await c.query(`SELECT id, card_no, status, balance FROM pioneer_cards ${tail}`)).rows };
    const raw = Array.isArray(body.ids) ? body.ids : null;
    if (!raw || !raw.length) throw new HttpError(422, 'validation_failed', M.validation, { ids: 'Ընտրեք առնվազն 1 քարտ։' });
    if (raw.length > BULK_MAX) throw new HttpError(422, 'validation_failed', M.validation, { ids: `Առավելագույնը ${BULK_MAX} քարտ մեկ գործողությամբ։` });
    const ids = raw.map((v) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null));
    if (ids.includes(null) || new Set(ids).size !== ids.length) throw new HttpError(422, 'validation_failed', M.validation, { ids: 'Անվավեր կամ կրկնվող քարտեր։' });
    const rows = (await c.query(`SELECT id, card_no, status, balance FROM pioneer_cards WHERE id = ANY($1::int[]) ${tail}`, [ids])).rows;
    const found = new Set(rows.map((r) => r.id)), absent = ids.filter((id) => !found.has(id));
    if (absent.length) throw new HttpError(404, 'not_found', `${absent.length} քարտ չի գտնվել։ Թարմացրեք ցուցակը։`, { ids: absent.join(', ') });
    return { scope: 'selection', rows };
  };
  // Binds a confirmation to the exact cards and their state at preview time: anything changed -> preview again.
  const bulkToken = (scope, rows) => sha256(`pioneer-bulk-retire:${scope}:` + rows.map((r) => `${r.id}.${r.status}`).join(','));

  R('POST', `${A}/cards/bulk-preview`, { auth: true }, async (ctx) => {
    guard(ctx, 'pc-admin-bulk-preview', 60, 10 * 60_000);
    const { scope, rows } = await bulkRows(db, await readJson(ctx.req, 60_000));
    if (!rows.length) throw new HttpError(422, 'validation_failed', 'Քարտեր չկան։', { ids: 'Քարտեր չկան։' });
    const ids = rows.map((r) => r.id), nos = rows.map((r) => r.card_no), one = async (sql) => (await db.query(sql, [ids])).rows[0];
    const tx = await one('SELECT COUNT(*)::int AS n FROM pioneer_transactions WHERE card_id = ANY($1::int[])');
    const refs = await one('SELECT COUNT(*)::int AS n FROM pioneer_transactions WHERE counterparty_card_id = ANY($1::int[]) AND NOT (card_id = ANY($1::int[]))');
    const tr = await one(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE NOT (sender_card_id = ANY($1::int[]) AND recipient_card_id = ANY($1::int[])))::int AS crossing
      FROM pioneer_transfers WHERE sender_card_id = ANY($1::int[]) OR recipient_card_id = ANY($1::int[])`);
    const red = (await db.query('SELECT status, COUNT(*)::int AS n, COUNT(gift_code)::int AS gifts FROM pioneer_redemptions WHERE card_id = ANY($1::int[]) GROUP BY status', [ids])).rows;
    const audits = await one('SELECT COUNT(*)::int AS n FROM pioneer_audit_log WHERE card_id = ANY($1::int[])');
    const sessions = await one('SELECT COUNT(*)::int AS n FROM pioneer_sessions WHERE card_id = ANY($1::int[]) AND expires_at > now()');
    const guards = (await db.query('SELECT COUNT(*)::int AS n FROM pioneer_login_guard WHERE card_no = ANY($1::text[])', [nos])).rows[0];
    const byStatus = Object.fromEntries(['pending', 'approved', 'fulfilled', 'cancelled'].map((s) => [s, red.find((x) => x.status === s)?.n || 0]));
    const active = rows.filter((r) => r.status === 'active');
    sendJson(ctx.res, 200, {
      scope, token: bulkToken(scope, rows),
      cards: { selected: rows.length, active: active.length, alreadyInactive: rows.length - active.length, withBalance: rows.filter((r) => r.balance > 0).length, balanceTotal: rows.reduce((a, r) => a + r.balance, 0) },
      history: { transactions: tx.n, transfers: tr.n, transfersWithOtherCards: tr.crossing, otherCardsHistoryRefs: refs.n, redemptions: byStatus, giftCodes: red.reduce((a, x) => a + x.gifts, 0), auditEntries: audits.n },
      activeSessions: sessions.n, loginGuardRows: guards.n,
      permanentDelete: { allowed: false, blockedBy: { transactions: tx.n, transfers: tr.n, redemptions: red.reduce((a, x) => a + x.n, 0), auditEntries: audits.n } },
      retire: { willDeactivate: active.length, willEndSessions: sessions.n },
    }, NO_STORE);
  });

  R('POST', `${A}/cards/bulk-retire`, { auth: true }, async (ctx) => {
    guard(ctx, 'pc-admin-bulk', 20, 10 * 60_000);
    const body = await readJson(ctx.req, 60_000);
    let scope = body.all === true ? 'all' : 'selection', requested = body.all === true ? null : (Array.isArray(body.ids) ? body.ids.length : 0);
    try {
      const out = await withTransaction(db, async (c) => {
        const sel = await bulkRows(c, body, true); // row locks: a parallel duplicate waits, then sees the new state
        scope = sel.scope; requested = sel.rows.length;
        if (typeof body.token !== 'string' || !safeEqual(body.token, bulkToken(sel.scope, sel.rows)))
          throw new HttpError(409, 'stale', 'Քարտերի ցուցակը կամ կարգավիճակը փոխվել է նախադիտումից հետո (կամ գործողությունն արդեն կատարվել է)։ Բացեք նախադիտումը կրկին։');
        if (body.confirmCount !== sel.rows.length) throw new HttpError(422, 'validation_failed', M.validation, { confirmCount: `Հաստատման համար մուտքագրեք ${sel.rows.length} թիվը։` });
        const target = sel.rows.filter((r) => r.status === 'active').map((r) => r.id);
        const retired = target.length ? (await c.query("UPDATE pioneer_cards SET status = 'inactive', updated_at = now() WHERE id = ANY($1::int[]) AND status = 'active' RETURNING id", [target])).rows.map((r) => r.id) : [];
        const ended = retired.length ? (await c.query('DELETE FROM pioneer_sessions WHERE card_id = ANY($1::int[])', [retired])).rowCount : 0;
        for (const id of retired) await audit(c, ctx, 'card.deactivate', id, { bulk: true });
        const summary = { scope: sel.scope, selected: sel.rows.length, retired: retired.length, alreadyInactive: sel.rows.length - retired.length, sessionsEnded: ended };
        await audit(c, ctx, 'cards.bulk_retire', null, { ...summary, ids: sel.rows.map((r) => r.id), outcome: 'ok' });
        return { ...summary, retiredIds: retired };
      });
      sendJson(ctx.res, 200, { result: out }, NO_STORE);
    } catch (e) {
      // everything above ran in one transaction and is rolled back; record the failed attempt itself
      if (!(e instanceof HttpError)) await audit(db, ctx, 'cards.bulk_retire', null, { scope, selected: requested, outcome: 'failed', error: e.code || 'error' }).catch(() => {});
      throw e;
    }
  });

  // ---------- admin: ledger, redemptions, audit, settings -------------------------------
  const TX_TYPES = ['initial_bonus', 'transfer_out', 'transfer_in', 'redemption', 'redemption_refund', 'admin_credit', 'admin_debit', 'partner_credit', 'partner_redemption'];
  R('GET', `${A}/transactions`, { auth: true }, async (ctx) => {
    const q = ctx.url.searchParams, p = params();
    const type = TX_TYPES.includes(q.get('type')) ? q.get('type') : null;
    const cardNo = normalizeCardNo(q.get('card'));
    const where = `TRUE${type ? ` AND t.type = ${p.add(type)}` : ''}${cardNo ? ` AND c.card_no = ${p.add(cardNo)}` : ''}`;
    const pageSize = intParam(q.get('pageSize'), 30, 1, 100);
    const total = await count(`SELECT COUNT(*)::int AS c FROM pioneer_transactions t JOIN pioneer_cards c ON c.id = t.card_id WHERE ${where}`, p.list.slice());
    const page = Math.min(intParam(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query(
      `SELECT t.*, c.card_no, c.first_name, c.last_name, tr.reference AS transfer_ref, rd.reference AS redemption_ref, cp.card_no AS cp_card_no, a.username AS admin_name
       FROM pioneer_transactions t JOIN pioneer_cards c ON c.id = t.card_id LEFT JOIN pioneer_transfers tr ON tr.id = t.transfer_id
       LEFT JOIN pioneer_redemptions rd ON rd.id = t.redemption_id LEFT JOIN pioneer_cards cp ON cp.id = t.counterparty_card_id LEFT JOIN admins a ON a.id = t.admin_id
       WHERE ${where} ORDER BY t.id DESC LIMIT ${p.add(pageSize)} OFFSET ${p.add((page - 1) * pageSize)}`, p.list);
    sendJson(ctx.res, 200, { items: rows.map((r) => ({ id: String(r.id), cardId: r.card_id, card: r.card_no, holder: displayName(r.first_name, r.last_name), type: r.type, amount: r.amount, balanceAfter: r.balance_after,
      description: r.description, reference: r.transfer_ref || r.redemption_ref || null, counterparty: r.cp_card_no || null, admin: r.admin_name || null, createdAt: r.created_at })), total, page, pageSize }, NO_STORE);
  });

  R('GET', `${A}/redemptions`, { auth: true }, async (ctx) => {
    const q = ctx.url.searchParams, p = params();
    const status = ['pending', 'approved', 'fulfilled', 'cancelled'].includes(q.get('status')) ? q.get('status') : null;
    const term = String(q.get('q') || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 30);
    const where = `TRUE${status ? ` AND d.status = ${p.add(status)}` : ''}${term ? ` AND (c.card_no = ${p.add(term)} OR d.reference = ${p.add(term)} OR replace(d.gift_code, '-', '') = ${p.add(term.replace(/-/g, ''))})` : ''}`;
    const pageSize = intParam(q.get('pageSize'), 25, 1, 100);
    const total = await count(`SELECT COUNT(*)::int AS c FROM pioneer_redemptions d JOIN pioneer_cards c ON c.id = d.card_id WHERE ${where}`, p.list.slice());
    const page = Math.min(intParam(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query(`SELECT d.*, c.card_no, c.first_name, c.last_name, a.username AS handled_name, ap.username AS approved_name FROM pioneer_redemptions d JOIN pioneer_cards c ON c.id = d.card_id LEFT JOIN admins a ON a.id = d.handled_by LEFT JOIN admins ap ON ap.id = d.approved_by
      WHERE ${where} ORDER BY d.id DESC LIMIT ${p.add(pageSize)} OFFSET ${p.add((page - 1) * pageSize)}`, p.list);
    sendJson(ctx.res, 200, { items: rows.map((r) => ({ ...redemptionOut(r), cardId: r.card_id, card: r.card_no, holder: displayName(r.first_name, r.last_name), note: r.admin_note, handledBy: r.handled_name || null, approvedBy: r.approved_name || null })), total, page, pageSize }, NO_STORE);
  });

  // pending -> approved (gift code issued) -> fulfilled (handed over); pending|approved -> cancelled (refund).
  // Repeating a transition the request is already in returns it unchanged: no second code, refund or audit entry.
  // pending -> fulfilled stays allowed (older clients) and issues the gift code in the same step.
  const NEXT = { approved: ['pending'], fulfilled: ['pending', 'approved'], cancelled: ['pending', 'approved'] };
  const AUDIT = { approved: 'approve', fulfilled: 'fulfill', cancelled: 'cancel' };
  R('POST', `${A}/redemptions/:id/status`, { auth: true }, async (ctx) => {
    const body = await readJson(ctx.req, 2000);
    if (typeof body.status !== 'string' || !Object.hasOwn(NEXT, body.status)) throw new HttpError(422, 'validation_failed', M.validation, { status: 'Անվավեր կարգավիճակ։' });
    const note = clean(body.note).slice(0, 500);
    const row = await withTransaction(db, async (c) => {
      const d = /^\d{1,9}$/.test(ctx.params.id) ? (await c.query('SELECT * FROM pioneer_redemptions WHERE id = $1 FOR UPDATE', [Number(ctx.params.id)])).rows[0] : null;
      if (!d) throw new HttpError(404, 'not_found', M.notFound);
      if (d.status === body.status) return d;
      if (!NEXT[body.status].includes(d.status)) throw new HttpError(409, 'already_handled', d.status === 'pending' || d.status === 'approved' ? M.redemptionFlow : M.redemptionState);
      if (!d.gift_code && (body.status === 'approved' || body.status === 'fulfilled')) {
        // 60-bit code; a collision is practically impossible, but a unique violation must not abort the approval.
        for (let i = 0; ; i++) {
          await c.query('SAVEPOINT gift');
          try {
            await c.query('UPDATE pioneer_redemptions SET gift_code = $1, approved_at = now(), approved_by = $2 WHERE id = $3', [newGiftCode(), ctx.session.admin_id, d.id]);
            break;
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT gift');
            if (!isUnique(e) || i >= 4) throw e;
          }
        }
      }
      const u = body.status === 'approved'
        ? (await c.query('UPDATE pioneer_redemptions SET status = $1, admin_note = $2 WHERE id = $3 RETURNING *', [body.status, note || d.admin_note, d.id])).rows[0]
        : (await c.query('UPDATE pioneer_redemptions SET status = $1, admin_note = $2, handled_by = $3, handled_at = now() WHERE id = $4 RETURNING *', [body.status, note || d.admin_note, ctx.session.admin_id, d.id])).rows[0];
      if (body.status === 'cancelled') { // points go back through the ledger
        await c.query(`INSERT INTO pioneer_transactions (card_id, type, amount, description, redemption_id, admin_id) VALUES ($1, 'redemption_refund', $2, $3, $4, $5)`, [d.card_id, d.points, d.reward_title, d.id, ctx.session.admin_id]);
        await c.query('UPDATE pioneer_rewards SET redeemed_count = GREATEST(0, redeemed_count - 1) WHERE id = $1', [d.reward_id]);
      }
      await audit(c, ctx, `redemption.${AUDIT[body.status]}`, d.card_id, { reference: d.reference, points: d.points, from: d.status, note });
      return u;
    });
    sendJson(ctx.res, 200, { redemption: redemptionOut(row) }, NO_STORE);
  });

  R('GET', `${A}/audit`, { auth: true }, async (ctx) => {
    const q = ctx.url.searchParams, pageSize = intParam(q.get('pageSize'), 30, 1, 100);
    const total = await count('SELECT COUNT(*)::int AS c FROM pioneer_audit_log', []);
    const page = Math.min(intParam(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query('SELECT l.*, c.card_no FROM pioneer_audit_log l LEFT JOIN pioneer_cards c ON c.id = l.card_id ORDER BY l.id DESC LIMIT $1 OFFSET $2', [pageSize, (page - 1) * pageSize]);
    sendJson(ctx.res, 200, { items: rows.map((r) => ({ id: String(r.id), admin: r.admin_name, action: r.action, cardId: r.card_id, card: r.card_no, details: r.details, createdAt: r.created_at })), total, page, pageSize }, NO_STORE);
  });

  R('GET', `${A}/settings`, { auth: true }, async (ctx) => sendJson(ctx.res, 200, { initialBonus: await initialBonus() }, NO_STORE));
  R('PUT', `${A}/settings`, { auth: true }, async (ctx) => {
    const body = await readJson(ctx.req, 500);
    const n = typeof body.initialBonus === 'number' ? body.initialBonus : /^\d{1,6}$/.test(String(body.initialBonus ?? '')) ? Number(body.initialBonus) : NaN;
    if (!Number.isSafeInteger(n) || n < 0 || n > 100000) throw new HttpError(422, 'validation_failed', M.validation, { initialBonus: 'Ամբողջ թիվ՝ 0-ից 100 000։' });
    await withTransaction(db, async (c) => {
      const before = await initialBonus(c);
      await c.query('INSERT INTO pioneer_settings (id, initial_bonus, updated_at, updated_by) VALUES (TRUE, $1, now(), $2) ON CONFLICT (id) DO UPDATE SET initial_bonus = EXCLUDED.initial_bonus, updated_at = now(), updated_by = EXCLUDED.updated_by', [n, ctx.session.admin_id]);
      if (before !== n) await audit(c, ctx, 'settings.initial_bonus', null, { from: before, to: n });
    });
    sendJson(ctx.res, 200, { initialBonus: n }, NO_STORE);
  });

  // ---------- admin: rewards & courses ----------------------------------------------------
  const ICONS = ['spark', 'code', 'design', 'mobile', 'gift', 'star', 'book', 'rocket'];
  const optInt = (v, min, max) => {
    if (v === null || v === undefined || v === '') return { value: null };
    const n = typeof v === 'number' ? v : /^\d{1,9}$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN;
    return Number.isSafeInteger(n) && n >= min && n <= max ? { value: n } : { error: `Ամբողջ թիվ՝ ${min}-ից ${max.toLocaleString('en-US')}։` };
  };
  const optDate = (v) => {
    if (v === null || v === undefined || v === '') return { value: null };
    const t = Date.parse(String(v));
    return Number.isFinite(t) && t > Date.parse('2000-01-01') && t < Date.parse('2100-01-01') ? { value: new Date(t).toISOString() } : { error: 'Անվավեր ամսաթիվ։' };
  };
  function validateReward(b, cur = {}) {
    const pick = (k, d) => (b[k] !== undefined ? b[k] : d);
    const errors = {}, v = {};
    v.kind = pick('kind', cur.kind ?? 'course_discount'); if (!['course_discount', 'reward'].includes(v.kind)) errors.kind = 'Անվավեր տեսակ։';
    v.title = clean(pick('title', cur.title)); if ([...v.title].length < 2 || [...v.title].length > 120) errors.title = 'Անվանումը՝ 2-120 նիշ։';
    v.description = String(pick('description', cur.description) ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if ([...v.description].length > 2000) errors.description = 'Նկարագրությունը՝ առավելագույնը 2000 նիշ։';
    v.icon = pick('icon', cur.icon ?? 'spark'); if (!ICONS.includes(v.icon)) errors.icon = 'Անվավեր պատկերակ։';
    const ints = { pointsCost: [1, 1_000_000, 'points_cost'], discountPercent: [1, 100, 'discount_percent'], discountAmount: [1, 100_000_000, 'discount_amount'], maxRedemptions: [1, 10_000_000, 'max_redemptions'], perCardLimit: [1, 1000, 'per_card_limit'], sortOrder: [0, 100000, 'sort_order'] };
    for (const [k, [min, max, col]] of Object.entries(ints)) { const r = optInt(pick(k, cur[col]), min, max); if (r.error) errors[k] = r.error; else v[k] = r.value; }
    if (v.pointsCost == null && !errors.pointsCost) errors.pointsCost = 'Նշեք պահանջվող միավորները։';
    v.sortOrder ??= 0;
    for (const [k, col] of [['availableFrom', 'available_from'], ['availableUntil', 'available_until']]) { const r = optDate(pick(k, cur[col])); if (r.error) errors[k] = r.error; else v[k] = r.value; }
    if (v.availableFrom && v.availableUntil && Date.parse(v.availableFrom) >= Date.parse(v.availableUntil)) errors.availableUntil = 'Ավարտը պետք է լինի մեկնարկից հետո։';
    v.availabilityNote = clean(pick('availabilityNote', cur.availability_note ?? '')); if ([...v.availabilityNote].length > 200) errors.availabilityNote = 'Առավելագույնը 200 նիշ։';
    v.status = pick('status', cur.status ?? 'draft'); if (!['draft', 'published', 'archived'].includes(v.status)) errors.status = 'Անվավեր կարգավիճակ։';
    if (cur.redeemed_count != null && v.maxRedemptions != null && v.maxRedemptions < cur.redeemed_count) errors.maxRedemptions = `Արդեն օգտագործվել է ${cur.redeemed_count} անգամ։`;
    if (Object.keys(errors).length) throw new HttpError(422, 'validation_failed', M.validation, errors);
    return v;
  }
  const rewardCols = (v) => [v.kind, v.title, v.description, v.icon, v.pointsCost, v.discountPercent, v.discountAmount, v.status, v.availableFrom, v.availableUntil, v.availabilityNote, v.maxRedemptions, v.perCardLimit, v.sortOrder];

  R('GET', `${A}/rewards`, { auth: true }, async (ctx) => {
    const st = ctx.url.searchParams.get('status');
    const status = ['draft', 'published', 'archived'].includes(st) ? st : null;
    const { rows } = await db.query(`SELECT * FROM pioneer_rewards ${status ? 'WHERE status = $1' : "WHERE status <> 'archived'"} ORDER BY sort_order, id DESC`, status ? [status] : []);
    sendJson(ctx.res, 200, { items: rows.map(rewardOut) }, NO_STORE);
  });
  R('POST', `${A}/rewards`, { auth: true }, async (ctx) => {
    const v = validateReward(await readJson(ctx.req, 10_000));
    const row = await withTransaction(db, async (c) => {
      const r = (await c.query(`INSERT INTO pioneer_rewards (kind, title, description, icon, points_cost, discount_percent, discount_amount, status, available_from, available_until, availability_note, max_redemptions, per_card_limit, sort_order, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) RETURNING *`, [...rewardCols(v), ctx.session.admin_id])).rows[0];
      await audit(c, ctx, 'reward.create', null, { rewardId: r.id, title: r.title, pointsCost: r.points_cost, status: r.status });
      return r;
    });
    sendJson(ctx.res, 201, { reward: rewardOut(row) }, NO_STORE);
  });
  const rewardById = async (c, id, lock) => {
    const r = /^\d{1,9}$/.test(id) ? (await c.query(`SELECT * FROM pioneer_rewards WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id)])).rows[0] : null;
    if (!r) throw new HttpError(404, 'not_found', M.notFound);
    return r;
  };
  R('PATCH', `${A}/rewards/:id`, { auth: true }, async (ctx) => {
    const body = await readJson(ctx.req, 10_000);
    const row = await withTransaction(db, async (c) => {
      const cur = await rewardById(c, ctx.params.id, true);
      const v = validateReward(body, cur);
      const r = (await c.query(`UPDATE pioneer_rewards SET kind = $1, title = $2, description = $3, icon = $4, points_cost = $5, discount_percent = $6, discount_amount = $7, status = $8, available_from = $9, available_until = $10,
        availability_note = $11, max_redemptions = $12, per_card_limit = $13, sort_order = $14, updated_by = $15, updated_at = now() WHERE id = $16 RETURNING *`, [...rewardCols(v), ctx.session.admin_id, cur.id])).rows[0];
      await audit(c, ctx, 'reward.update', null, { rewardId: r.id, title: r.title, status: r.status, pointsCost: r.points_cost });
      return r;
    });
    sendJson(ctx.res, 200, { reward: rewardOut(row) }, NO_STORE);
  });
  R('DELETE', `${A}/rewards/:id`, { auth: true }, async (ctx) => {
    await withTransaction(db, async (c) => {
      const cur = await rewardById(c, ctx.params.id, true);
      if (await countIn(c, 'SELECT COUNT(*)::int AS c FROM pioneer_redemptions WHERE reward_id = $1', [cur.id])) throw new HttpError(409, 'has_redemptions', M.hasRedemptions);
      await c.query('DELETE FROM pioneer_rewards WHERE id = $1', [cur.id]);
      await audit(c, ctx, 'reward.delete', null, { rewardId: cur.id, title: cur.title });
    });
    sendJson(ctx.res, 200, { ok: true }, NO_STORE);
  });

  // ---------- admin: announcements --------------------------------------------------------
  const annOut = (r) => ({ id: r.id, title: r.title, body: r.body, status: r.status, createdAt: r.created_at, updatedAt: iso(r.updated_at) });
  const validateAnn = (b, cur = {}) => {
    const title = clean(b.title ?? cur.title), body = String(b.body ?? cur.body ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    const status = b.status ?? cur.status ?? 'draft', errors = {};
    if ([...title].length < 2 || [...title].length > 120) errors.title = 'Վերնագիրը՝ 2-120 նիշ։';
    if ([...body].length > 2000) errors.body = 'Առավելագույնը 2000 նիշ։';
    if (!['draft', 'published', 'archived'].includes(status)) errors.status = 'Անվավեր կարգավիճակ։';
    if (Object.keys(errors).length) throw new HttpError(422, 'validation_failed', M.validation, errors);
    return { title, body, status };
  };
  R('GET', `${A}/announcements`, { auth: true }, async (ctx) => {
    const { rows } = await db.query("SELECT * FROM pioneer_announcements WHERE status <> 'archived' ORDER BY id DESC LIMIT 200");
    sendJson(ctx.res, 200, { items: rows.map(annOut) }, NO_STORE);
  });
  R('POST', `${A}/announcements`, { auth: true }, async (ctx) => {
    const v = validateAnn(await readJson(ctx.req, 10_000));
    const r = (await db.query('INSERT INTO pioneer_announcements (title, body, status, created_by) VALUES ($1, $2, $3, $4) RETURNING *', [v.title, v.body, v.status, ctx.session.admin_id])).rows[0];
    await audit(db, ctx, 'announcement.create', null, { id: r.id, title: r.title, status: r.status });
    sendJson(ctx.res, 201, { announcement: annOut(r) }, NO_STORE);
  });
  R('PATCH', `${A}/announcements/:id`, { auth: true }, async (ctx) => {
    const body = await readJson(ctx.req, 10_000);
    const cur = /^\d{1,9}$/.test(ctx.params.id) ? (await db.query('SELECT * FROM pioneer_announcements WHERE id = $1', [Number(ctx.params.id)])).rows[0] : null;
    if (!cur) throw new HttpError(404, 'not_found', M.notFound);
    const v = validateAnn(body, cur);
    const r = (await db.query('UPDATE pioneer_announcements SET title = $1, body = $2, status = $3, updated_at = now() WHERE id = $4 RETURNING *', [v.title, v.body, v.status, cur.id])).rows[0];
    await audit(db, ctx, 'announcement.update', null, { id: r.id, status: r.status });
    sendJson(ctx.res, 200, { announcement: annOut(r) }, NO_STORE);
  });

  return { sessionFrom, MEMBER_FALLBACK, checkCredentials };
}
