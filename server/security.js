import { scrypt as _scrypt, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(_scrypt);

const N = 32768, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * 1024 * 1024;

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hmacToken = (secret, label, value) => createHmac('sha256', secret).update(`${label}:${value}`).digest('base64url');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, key] = parts;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: MAXMEM });
  return timingSafeEqual(got, expected);
}
// Used when the username does not exist so response time does not reveal valid usernames.
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

/** Sliding-window in-memory limiter (single process). */
export class RateLimiter {
  constructor() {
    this.hits = new Map();
    this.timer = setInterval(() => { const now = Date.now(); for (const [k, v] of this.hits) if (v.exp < now) this.hits.delete(k); }, 60_000);
    this.timer.unref();
  }
  /** Returns {ok, retryAfter}. Counts the attempt. */
  take(key, limit, windowMs) {
    const now = Date.now();
    const e = this.hits.get(key) || { t: [], exp: 0 };
    e.t = e.t.filter((x) => x > now - windowMs);
    e.exp = now + windowMs;
    if (e.t.length >= limit) { this.hits.set(key, e); return { ok: false, retryAfter: Math.ceil((e.t[0] + windowMs - now) / 1000) }; }
    e.t.push(now);
    this.hits.set(key, e);
    return { ok: true };
  }
  reset(key) { this.hits.delete(key); }
  close() { clearInterval(this.timer); }
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** `hsts` comes from HSTS_ENABLED only (never from COOKIE_SECURE): HSTS cannot be withdrawn from browsers that saw it. */
export function setSecurityHeaders(res, { hsts = false, csp = true }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (csp) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
