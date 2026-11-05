// COOKIE_SECURE controls only the cookie Secure flag; HSTS is sent only with HSTS_ENABLED=true. Other headers unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';
import { loadConfig } from '../server/config.js';

const HSTS = 'max-age=31536000; includeSubDomains';
const base = { APP_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgresql://u@h/d' };

test('config: HSTS is off by default (also in production) and on only with HSTS_ENABLED=true', () => {
  const prod = loadConfig({ ...base, NODE_ENV: 'production' });
  assert.equal(prod.cookieSecure, true, 'production keeps Secure cookies by default');
  assert.equal(prod.hstsEnabled, false, 'production does not enable HSTS by default');
  assert.equal(loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' }).hstsEnabled, false, 'COOKIE_SECURE does not imply HSTS');
  assert.equal(loadConfig({ ...base, NODE_ENV: 'production', HSTS_ENABLED: 'true' }).hstsEnabled, true);
  assert.equal(loadConfig({ ...base, HSTS_ENABLED: 'true', COOKIE_SECURE: 'false' }).hstsEnabled, true, 'independent of COOKIE_SECURE');
  for (const v of ['false', 'TRUE', 'True', '1', 'yes', '']) assert.equal(loadConfig({ ...base, NODE_ENV: 'production', HSTS_ENABLED: v }).hstsEnabled, false, `HSTS_ENABLED=${JSON.stringify(v)}`);
});

// Admin and Pioneer Card logins on one server; returns the cookies and the headers of several kinds of responses.
async function observe(extra) {
  const s = await start(extra);
  try {
    const admin = await s.login();
    assert.equal(admin.status, 200);
    const ad = (path, opts = {}) => s.api('/api/admin/pioneer' + path, { cookie: admin.cookie, csrf: admin.csrf, ...opts });
    const card = (await ad('/cards', { method: 'POST', body: {} })).data;
    const holder = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: card.card.number, cvv: card.cvv } });
    assert.equal(holder.status, 200);
    const responses = {
      health: await s.api('/api/health'),
      adminLogin: admin,
      pioneerLogin: holder,
      notFound: await s.api('/api/nope'),
      nonApi: await s.api('/some-page'),
      integration: await s.api('/api/integration/v1/me'),
    };
    return { adminCookie: admin.headers.get('set-cookie'), pioneerCookie: holder.headers.get('set-cookie'), responses };
  } finally { await s.close(); }
}
const unchangedHeaders = (responses) => {
  for (const [name, r] of Object.entries(responses)) {
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', name);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', name);
    assert.equal(r.headers.get('referrer-policy'), 'same-origin', name);
    assert.equal(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=()', name);
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin', name);
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin', name);
    assert.match(r.headers.get('content-security-policy'), /^default-src 'self'; script-src 'self';.*frame-ancestors 'none'$/, name);
  }
};
const hasFlags = (cookie, secure) => {
  for (const f of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(f), f);
  assert.equal(/;\s*Secure(;|$)/.test(cookie), secure, `Secure flag ${secure ? 'expected' : 'unexpected'}: ${cookie}`);
};

test('Secure cookies with HSTS disabled: admin and Pioneer cookies are Secure, no Strict-Transport-Security anywhere', async () => {
  const o = await observe({ cookieSecure: true, hstsEnabled: false });
  hasFlags(o.adminCookie, true);
  hasFlags(o.pioneerCookie, true);
  for (const [name, r] of Object.entries(o.responses)) assert.equal(r.headers.get('strict-transport-security'), null, name);
  unchangedHeaders(o.responses);
});

test('HSTS enabled explicitly: same header value as before on every response; cookie flags unaffected', async () => {
  const o = await observe({ cookieSecure: true, hstsEnabled: true });
  for (const [name, r] of Object.entries(o.responses)) assert.equal(r.headers.get('strict-transport-security'), HSTS, name);
  hasFlags(o.adminCookie, true);
  hasFlags(o.pioneerCookie, true);
  unchangedHeaders(o.responses);
  // independent of COOKIE_SECURE in both directions
  const onlyHsts = await observe({ cookieSecure: false, hstsEnabled: true });
  for (const [name, r] of Object.entries(onlyHsts.responses)) assert.equal(r.headers.get('strict-transport-security'), HSTS, name);
  hasFlags(onlyHsts.adminCookie, false);
  hasFlags(onlyHsts.pioneerCookie, false);
});

test('HSTS disabled and non-secure cookies (local development): neither HSTS nor Secure', async () => {
  const o = await observe({ cookieSecure: false, hstsEnabled: false });
  for (const [name, r] of Object.entries(o.responses)) assert.equal(r.headers.get('strict-transport-security'), null, name);
  hasFlags(o.adminCookie, false);
  hasFlags(o.pioneerCookie, false);
  unchangedHeaders(o.responses);
});
