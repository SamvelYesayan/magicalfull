import http from 'node:http';
import { EVENT } from '../shared/event.js';
import { validateRegistration, validateContact } from '../shared/validation.js';
import { createPool, migrate, withTransaction, isUnique, escapeLike } from './db.js';
import { HttpError, Router, sendJson, sendBuffer, readJson } from './http.js';
import { RateLimiter, sha256, hmacToken, randomToken, safeEqual, hashPassword, verifyPassword, DUMMY_HASH, clientIp, parseCookies, setSecurityHeaders } from './security.js';
import { renderInvitationPdf, streamInvitationsPdf } from './pdf/ticket.js';
import { streamSink } from './pdf/writer.js';
import { serveStatic } from './static.js';
import { registerPioneer } from './pioneer.js';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const COOKIE = 'mg_admin';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const newInvitationNo = () => 'MGC-' + [...randomBytes(6)].map((b) => ALPHA[b % 32]).join('');

const M = {
  server: 'Սերվերի սխալ։ Խնդրում ենք փորձել կրկին։',
  notFound: 'Չի գտնվել։',
  rate: 'Չափազանց շատ հարցումներ։ Խնդրում ենք փորձել մի փոքր ուշ։',
  validation: 'Խնդրում ենք ուղղել նշված դաշտերը։',
  dup: 'Այս տվյալներով հրավիրատոմս արդեն գրանցված է։ Եթե կորցրել եք այն, դիմեք կազմակերպիչներին։',
  login: 'Սխալ օգտանուն կամ գաղտնաբառ։',
  auth: 'Անհրաժեշտ է մուտք գործել։',
  csrf: 'Անվավեր անվտանգության նշան։ Թարմացրեք էջը և փորձեք կրկին։',
  origin: 'Արգելված հարցում։',
  spam: 'Հարցումը մերժվեց։ Խնդրում ենք փորձել կրկին։',
};
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const publicEvent = { name: EVENT.name, dateText: EVENT.dateText, time: EVENT.time, location: EVENT.location, giftsNote: EVENT.giftsNote };

const regPublic = (r) => ({ number: r.invitation_no, firstName: r.first_name, lastName: r.last_name, createdAt: r.created_at, event: publicEvent });
const regAdmin = (r) => ({ id: r.id, invitationNo: r.invitation_no, firstName: r.first_name, lastName: r.last_name, age: r.age, phone: r.phone, status: r.status, createdAt: r.created_at, event: publicEvent });
const msgOut = (r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, service: r.service, message: r.message, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });
const pdfData = (r) => ({ firstName: r.first_name, lastName: r.last_name, invitationNo: r.invitation_no });
const intParam = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

export async function createApp(config) {
  const db = createPool(config);
  let eventId;
  try {
    if (config.autoMigrate !== false) await migrate(db);
    await db.query('INSERT INTO events (slug, title) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING', [EVENT.slug, EVENT.name]);
    eventId = (await db.query('SELECT id FROM events WHERE slug = $1', [EVENT.slug])).rows[0].id;
  } catch (e) { await db.end().catch(() => {}); throw e; } // never leave a half-initialised pool behind
  const limiter = new RateLimiter();
  const router = new Router();
  const hasStatic = existsSync(config.staticDir);

  const guard = (ctx, name, n, windowMs) => {
    if (!config.rateLimits) return;
    const r = limiter.take(`${name}:${ctx.ip}`, n, windowMs);
    if (!r.ok) { const e = new HttpError(429, 'rate_limited', M.rate); e.retryAfter = r.retryAfter; throw e; }
  };

  // ---------- admin sessions -------------------------------------------------
  const sessionFrom = async (req) => {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw || raw.length > 100) return null;
    const { rows } = await db.query(
      `SELECT s.token_hash, s.csrf_token, s.expires_at, a.id AS admin_id, a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(raw)]);
    return rows[0] || null;
  };
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;
  const createSession = async (adminId) => {
    const token = randomToken(32), csrf = randomToken(24);
    await db.query(`INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + ($4::int * interval '1 hour'))`, [sha256(token), adminId, csrf, config.sessionHours]);
    return { token, csrf };
  };
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host === req.headers.host || config.allowedOrigins.includes(o.replace(/\/$/, '')); } catch { return false; }
  };

  const R = (method, path, opts, handler) => router.add(method, path, opts, handler);
  // Positional-parameter builder: add(v) stores v and returns its "$n" placeholder.
  const params = () => { const list = []; return { list, add: (v) => (list.push(v), '$' + list.length) }; };
  // Adds " AND search_text LIKE $n ESCAPE '\'" for a lower-cased, wildcard-escaped search term (search_text is lower-cased by the app, so this is locale-independent).
  const addSearch = (p, q) => {
    const t = String(q || '').replace(/\u0000/g, '').trim().toLowerCase().slice(0, 100);
    return t ? ` AND search_text LIKE ${p.add(`%${escapeLike(t)}%`)} ESCAPE '\\'` : '';
  };
  const count = async (sql, args) => (await db.query(sql, args)).rows[0].c; // COUNT(*)::int, so it is a number, not a bigint string

  // ---------- public API -------------------------------------------------------
  R('GET', '/api/health', {}, (ctx) => sendJson(ctx.res, 200, { ok: true }));
  R('GET', '/api/event', {}, (ctx) => sendJson(ctx.res, 200, { event: publicEvent }));

  R('POST', '/api/registrations', {}, async (ctx) => {
    guard(ctx, 'reg-burst', 8, 10 * 60_000);
    guard(ctx, 'reg-hour', 40, 60 * 60_000);
    const body = await readJson(ctx.req);
    const v = validateRegistration(body);
    if (!v.ok) throw new HttpError(422, 'validation_failed', M.validation, v.errors);
    const { firstName, lastName, age, phone } = v.values;
    const key = String(ctx.req.headers['idempotency-key'] || '');
    if (key && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, 'bad_idempotency_key', 'Անվավեր հարցում։');
    // With a key the token is derived (HMAC), so a retry of the same submission returns the same invitation.
    const token = key ? hmacToken(config.appSecret, 'invite-token', key) : randomToken(32);
    const tokenHash = sha256(token);
    const existing = (await db.query('SELECT * FROM registrations WHERE access_token_hash = $1', [tokenHash])).rows[0];
    const reply = (row, status) => sendJson(ctx.res, status, { invitation: { ...regPublic(row), token } });
    if (existing) return reply(existing, 200);
    const dedupe = sha256([firstName, lastName, phone].join('|').toLowerCase());
    const searchBase = [firstName, lastName, phone, phone.replace(/^\+374/, '0')].join(' ').toLowerCase();
    for (let attempt = 0; attempt < 6; attempt++) {
      const no = newInvitationNo();
      try {
        const { rows } = await db.query(
          `INSERT INTO registrations (event_id, invitation_no, access_token_hash, idempotency_hash, dedupe_key, first_name, last_name, age, phone, search_text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [eventId, no, tokenHash, key ? sha256(key) : null, dedupe, firstName, lastName, age, phone, `${searchBase} ${no.toLowerCase()}`]);
        return reply(rows[0], 201);
      } catch (e) {
        if (isUnique(e, 'invitation_no')) continue; // astronomically rare collision: retry with a new number
        if (isUnique(e)) {
          // A concurrent request with the same Idempotency-Key may have won the race: replay its invitation.
          const row = (await db.query('SELECT * FROM registrations WHERE access_token_hash = $1', [tokenHash])).rows[0];
          if (row) return reply(row, 200);
          if (isUnique(e, 'dedupe')) throw new HttpError(409, 'duplicate_registration', M.dup);
        }
        throw e;
      }
    }
    throw new HttpError(503, 'busy', M.server);
  });

  const byToken = async (ctx) => {
    guard(ctx, 'invite-get', 120, 10 * 60_000);
    const t = ctx.params.token;
    const row = /^[A-Za-z0-9_-]{20,64}$/.test(t) ? (await db.query('SELECT * FROM registrations WHERE access_token_hash = $1', [sha256(t)])).rows[0] : null;
    if (!row) throw new HttpError(404, 'not_found', M.notFound);
    return row;
  };
  R('GET', '/api/invitations/:token', {}, async (ctx) => sendJson(ctx.res, 200, { invitation: regPublic(await byToken(ctx)) }));
  R('GET', '/api/invitations/:token/pdf', {}, async (ctx) => {
    const row = await byToken(ctx);
    const pdf = await renderInvitationPdf(pdfData(row));
    sendBuffer(ctx.res, 200, pdf, 'application/pdf', { 'Content-Disposition': `attachment; filename="magical-invitation-${row.invitation_no}.pdf"` });
  });

  R('POST', '/api/contact', {}, async (ctx) => {
    guard(ctx, 'contact', 6, 60 * 60_000);
    const body = await readJson(ctx.req, 30_000);
    if (typeof body.website === 'string' && body.website !== '') throw new HttpError(400, 'rejected', M.spam); // honeypot
    const age = Date.now() - Number(body.ts);
    if (!Number.isFinite(age) || age < 1500 || age > 24 * 3600_000) throw new HttpError(400, 'rejected', M.spam); // submitted impossibly fast
    const v = validateContact(body);
    if (!v.ok) throw new HttpError(422, 'validation_failed', M.validation, v.errors);
    const { name, email, phone, service, message } = v.values;
    const { rows } = await db.query(`INSERT INTO contact_messages (name, email, phone, service, message, search_text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, email, phone, service, message, [name, email, phone, service, message].join(' ').toLowerCase()]);
    const row = rows[0];
    sendJson(ctx.res, 201, { ok: true, id: row.id });
  });

  // ---------- admin auth -------------------------------------------------------
  R('POST', '/api/admin/login', {}, async (ctx) => {
    guard(ctx, 'login-ip', 20, 15 * 60_000);
    const body = await readJson(ctx.req, 2000);
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 100) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const ukey = `login-user:${username.toLowerCase()}`;
    if (config.rateLimits && !limiter.take(ukey, 5, 15 * 60_000).ok) { const e = new HttpError(429, 'rate_limited', M.rate); e.retryAfter = 900; throw e; }
    const admin = username && !username.includes('\u0000') ? (await db.query('SELECT * FROM admins WHERE lower(username) = lower($1)', [username])).rows[0] : null;
    const ok = await verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH);
    if (!admin || !ok) throw new HttpError(401, 'invalid_credentials', M.login);
    limiter.reset(ukey);
    await db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
    const s = await createSession(admin.id);
    sendJson(ctx.res, 200, { username: admin.username, csrfToken: s.csrf }, { 'Set-Cookie': cookie(s.token, config.sessionHours * 3600) });
  });
  R('GET', '/api/admin/me', { auth: true }, (ctx) => sendJson(ctx.res, 200, { username: ctx.session.username, csrfToken: ctx.session.csrf_token }));
  R('POST', '/api/admin/logout', { auth: true }, async (ctx) => {
    await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [ctx.session.token_hash]);
    sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  });
  R('POST', '/api/admin/password', { auth: true }, async (ctx) => {
    guard(ctx, 'pw-change', 10, 15 * 60_000);
    const b = await readJson(ctx.req, 2000);
    const cur = typeof b.currentPassword === 'string' ? b.currentPassword : '', next = typeof b.newPassword === 'string' ? b.newPassword : '';
    if (next.length < 10 || next.length > 200) throw new HttpError(422, 'validation_failed', M.validation, { newPassword: 'Նոր գաղտնաբառը պետք է լինի առնվազն 10 նիշ։' });
    const admin = (await db.query('SELECT * FROM admins WHERE id = $1', [ctx.session.admin_id])).rows[0];
    if (!admin || !(await verifyPassword(cur, admin.password_hash))) throw new HttpError(422, 'validation_failed', M.validation, { currentPassword: 'Ընթացիկ գաղտնաբառը սխալ է։' });
    const newHash = await hashPassword(next);
    await withTransaction(db, async (c) => { // both statements succeed or neither does
      await c.query('UPDATE admins SET password_hash = $1, updated_at = now() WHERE id = $2', [newHash, admin.id]);
      await c.query('DELETE FROM admin_sessions WHERE admin_id = $1 AND token_hash <> $2', [admin.id, ctx.session.token_hash]);
    });
    sendJson(ctx.res, 200, { ok: true });
  });

  // ---------- admin: registrations ---------------------------------------------
  const SORTS = { created_at: 'id', first_name: 'lower(first_name)', last_name: 'lower(last_name)', age: 'age', phone: 'phone', invitation_no: 'invitation_no', status: 'status' };
  R('GET', '/api/admin/stats', { auth: true }, async (ctx) => sendJson(ctx.res, 200, {
    registrations: await count('SELECT COUNT(*)::int AS c FROM registrations WHERE event_id = $1', [eventId]),
    messages: await count('SELECT COUNT(*)::int AS c FROM contact_messages', []),
    newMessages: await count("SELECT COUNT(*)::int AS c FROM contact_messages WHERE status = 'new'", []),
  }, NO_STORE));
  // WHERE clause (and its parameters) shared by list, CSV and PDF for the registrations search box.
  const regFilter = (q) => { const p = params(); const where = `event_id = ${p.add(eventId)}${addSearch(p, q)}`; return { p, where }; };
  R('GET', '/api/admin/registrations', { auth: true }, async (ctx) => {
    const q = ctx.url.searchParams;
    const { p, where } = regFilter(q.get('q'));
    const col = SORTS[q.get('sort')] || SORTS.created_at, dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
    const pageSize = intParam(q.get('pageSize'), 25, 1, 100);
    const total = await count(`SELECT COUNT(*)::int AS c FROM registrations WHERE ${where}`, p.list.slice());
    const page = Math.min(intParam(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query(`SELECT * FROM registrations WHERE ${where} ORDER BY ${col} ${dir}, id ${dir} LIMIT ${p.add(pageSize)} OFFSET ${p.add((page - 1) * pageSize)}`, p.list);
    sendJson(ctx.res, 200, { items: rows.map(regAdmin), total, page, pageSize }, NO_STORE);
  });
  async function* rowsIter(where, args) { // keyset pagination: constant memory for any table size
    let last = 0;
    for (;;) {
      const { rows } = await db.query(`SELECT * FROM registrations WHERE ${where} AND id > $${args.length + 1} ORDER BY id LIMIT 200`, [...args, last]);
      if (!rows.length) return;
      for (const r of rows) yield r;
      last = rows[rows.length - 1].id;
    }
  }
  R('GET', '/api/admin/registrations/export.csv', { auth: true }, async (ctx) => {
    const { p, where } = regFilter(ctx.url.searchParams.get('q'));
    const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="magical-registrations.csv"', ...NO_STORE });
    ctx.res.write('\ufeff' + ['invitation_no', 'first_name', 'last_name', 'age', 'phone', 'status', 'registered_at_utc'].join(',') + '\r\n');
    for await (const r of rowsIter(where, p.list))
      ctx.res.write([r.invitation_no, r.first_name, r.last_name, r.age, r.phone, r.status, r.created_at].map(cell).join(',') + '\r\n');
    ctx.res.end();
  });
  R('GET', '/api/admin/registrations/pdf', { auth: true }, async (ctx) => {
    const { p, where } = regFilter(ctx.url.searchParams.get('q'));
    const total = await count(`SELECT COUNT(*)::int AS c FROM registrations WHERE ${where}`, p.list.slice());
    if (!total) throw new HttpError(404, 'empty', 'Գրանցումներ չկան։');
    ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="magical-invitations-all.pdf"', ...NO_STORE });
    const rows = (async function* () { for await (const r of rowsIter(where, p.list)) yield pdfData(r); })();
    await streamInvitationsPdf(streamSink(ctx.res), rows);
    ctx.res.end();
  });
  const regById = async (ctx) => {
    const r = /^\d{1,9}$/.test(ctx.params.id) ? (await db.query('SELECT * FROM registrations WHERE id = $1 AND event_id = $2', [Number(ctx.params.id), eventId])).rows[0] : null;
    if (!r) throw new HttpError(404, 'not_found', M.notFound);
    return r;
  };
  R('GET', '/api/admin/registrations/:id', { auth: true }, async (ctx) => sendJson(ctx.res, 200, { registration: regAdmin(await regById(ctx)) }, NO_STORE));
  R('GET', '/api/admin/registrations/:id/pdf', { auth: true }, async (ctx) => {
    const row = await regById(ctx);
    sendBuffer(ctx.res, 200, await renderInvitationPdf(pdfData(row)), 'application/pdf', { 'Content-Disposition': `attachment; filename="magical-invitation-${row.invitation_no}.pdf"` });
  });

  // ---------- admin: contact messages ------------------------------------------
  R('GET', '/api/admin/messages', { auth: true }, async (ctx) => {
    const q = ctx.url.searchParams;
    const p = params();
    const status = ['new', 'read', 'processed'].includes(q.get('status')) ? q.get('status') : null;
    const where = `TRUE${status ? ` AND status = ${p.add(status)}` : ''}${addSearch(p, q.get('q'))}`;
    const pageSize = intParam(q.get('pageSize'), 20, 1, 100);
    const total = await count(`SELECT COUNT(*)::int AS c FROM contact_messages WHERE ${where}`, p.list.slice());
    const page = Math.min(intParam(q.get('page'), 1, 1, 1e6), Math.max(1, Math.ceil(total / pageSize)));
    const { rows } = await db.query(`SELECT * FROM contact_messages WHERE ${where} ORDER BY id DESC LIMIT ${p.add(pageSize)} OFFSET ${p.add((page - 1) * pageSize)}`, p.list);
    sendJson(ctx.res, 200, { items: rows.map(msgOut), total, page, pageSize }, NO_STORE);
  });
  const msgById = async (ctx) => {
    const r = /^\d{1,9}$/.test(ctx.params.id) ? (await db.query('SELECT * FROM contact_messages WHERE id = $1', [Number(ctx.params.id)])).rows[0] : null;
    if (!r) throw new HttpError(404, 'not_found', M.notFound);
    return r;
  };
  R('GET', '/api/admin/messages/:id', { auth: true }, async (ctx) => sendJson(ctx.res, 200, { message: msgOut(await msgById(ctx)) }, NO_STORE));
  R('PATCH', '/api/admin/messages/:id', { auth: true }, async (ctx) => {
    const row = await msgById(ctx);
    const b = await readJson(ctx.req, 1000);
    if (!['new', 'read', 'processed'].includes(b.status)) throw new HttpError(422, 'validation_failed', M.validation, { status: 'Անվավեր կարգավիճակ։' });
    const u = (await db.query('UPDATE contact_messages SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [b.status, row.id])).rows[0];
    sendJson(ctx.res, 200, { message: msgOut(u) }, NO_STORE);
  });

  // ---------- Pioneer Card (server/pioneer.js) ---------------------------------
  const pioneer = registerPioneer({ R, db, config, limiter, guard, params, addSearch, count, intParam });

  // ---------- dispatcher -------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const ctx = { req, res, config, ip: clientIp(req, config.trustProxy), params: {} };
    let label = '-';
    try {
      ctx.url = new URL(req.url, 'http://localhost');
      const path = ctx.url.pathname;
      const isApi = path.startsWith('/api/');
      setSecurityHeaders(res, { secure: config.cookieSecure });
      // CORS: only for explicitly allowed origins
      const origin = req.headers.origin;
      if (origin && config.allowedOrigins.includes(origin.replace(/\/$/, ''))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-CSRF-Token,Idempotency-Key', 'Access-Control-Max-Age': '600' });
          return res.end();
        }
      }
      if (!isApi) {
        label = 'static';
        if ((req.method === 'GET' || req.method === 'HEAD') && hasStatic && serveStatic(config.staticDir, req, res, path)) return;
        return sendJson(res, 404, { error: { code: 'not_found', message: M.notFound } });
      }
      const m = router.match(req.method, path);
      if (!m.route) {
        if (m.pathMatched) throw new HttpError(405, 'method_not_allowed', 'Մեթոդը թույլատրված չէ։');
        throw new HttpError(404, 'not_found', M.notFound);
      }
      label = m.route.pattern;
      ctx.params = m.params;
      const unsafe = !['GET', 'HEAD'].includes(req.method);
      if (unsafe && !originOk(req)) throw new HttpError(403, 'bad_origin', M.origin);
      if (m.route.opts.auth) {
        const s = await sessionFrom(req);
        if (!s) throw new HttpError(401, 'unauthenticated', M.auth);
        if (unsafe && !safeEqual(req.headers['x-csrf-token'] || '', s.csrf_token)) throw new HttpError(403, 'bad_csrf', M.csrf);
        ctx.session = s;
      }
      if (m.route.opts.pioneer) { // cardholder session (separate cookie, same CSRF scheme)
        const s = await pioneer.sessionFrom(req);
        if (!s) throw new HttpError(401, 'unauthenticated', 'Անհրաժեշտ է մուտք գործել Pioneer Card-ով։');
        if (unsafe && !safeEqual(req.headers['x-csrf-token'] || '', s.csrf_token)) throw new HttpError(403, 'bad_csrf', M.csrf);
        ctx.pioneer = s;
      }
      await m.route.handler(ctx);
    } catch (e) {
      if (res.headersSent) { res.destroy(); }
      else if (e instanceof HttpError) {
        const h = e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {};
        sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}) } }, h);
      } else {
        console.error(`[error] ${req.method} ${label}:`, e && e.code ? `[${e.code}]` : '', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
        sendJson(res, 500, { error: { code: 'server_error', message: M.server } });
      }
    } finally {
      if (process.env.LOG_REQUESTS !== 'false' && !process.env.NODE_TEST_CONTEXT) console.log(`${req.method} ${label} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;

  return {
    server, db,
    // Stops accepting connections, then drains and closes the pool (each only once).
    close: async () => {
      limiter.close();
      if (server.listening) await new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); });
      await db.end();
    },
  };
}

/** Creates the admin if missing (race-safe); with reset=true replaces the password and revokes sessions. */
export async function ensureAdmin(db, username, password, { reset = false } = {}) {
  const hash = await hashPassword(password);
  const ins = await db.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [username, hash]);
  if (ins.rows.length) return 'created';
  if (!reset) return 'exists';
  await withTransaction(db, async (c) => {
    const { rows } = await c.query('UPDATE admins SET password_hash = $1, updated_at = now() WHERE lower(username) = lower($2) RETURNING id', [hash, username]);
    if (rows.length) await c.query('DELETE FROM admin_sessions WHERE admin_id = $1', [rows[0].id]);
  });
  return 'reset';
}
