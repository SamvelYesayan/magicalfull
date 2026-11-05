import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Tiny .env reader (no dependency). Real environment variables always win. */
export function loadEnvFile(file = resolve(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/** PostgreSQL settings from DATABASE_URL, or from PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD. Never falls back to anything else. */
export function databaseConfig(env) {
  const base = {
    max: int(env.PG_POOL_MAX, 10),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ...(env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } } : {}),
  };
  if (env.DATABASE_URL) {
    let u;
    try { u = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL is not a valid URL (expected postgresql://user:password@host:5432/database)'); }
    if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL must start with postgresql:// (SQLite is no longer supported)');
    const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!name) throw new Error('DATABASE_URL must include a database name (postgresql://user:password@host:5432/database)');
    return { ...base, connectionString: env.DATABASE_URL, database: name };
  }
  const missing = ['PGHOST', 'PGDATABASE', 'PGUSER'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`PostgreSQL is not configured. Set DATABASE_URL, or ${missing.join(', ')} (plus PGPORT and PGPASSWORD if needed).`);
  const port = int(env.PGPORT, 5432);
  if (port < 1 || port > 65535) throw new Error('PGPORT is invalid');
  return { ...base, host: env.PGHOST, port, database: env.PGDATABASE, user: env.PGUSER, password: env.PGPASSWORD || undefined };
}

const list = (s) => (s || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const cfg = {
    prod,
    port: int(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    db: databaseConfig(env),
    autoMigrate: env.DB_AUTO_MIGRATE !== 'false',
    staticDir: resolve(ROOT, env.STATIC_DIR || 'dist'),
    appSecret: env.APP_SECRET || '',
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : prod, // only the Secure flag on admin/Pioneer cookies
    // Strict-Transport-Security is sent ONLY with HSTS_ENABLED=true (exactly), never by default and never because of
    // COOKIE_SECURE: once browsers see it (1 year, includeSubDomains) it cannot be withdrawn.
    hstsEnabled: env.HSTS_ENABLED === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    sessionHours: int(env.SESSION_TTL_HOURS, 8),
    pioneerSessionHours: Math.min(72, Math.max(1, int(env.PIONEER_SESSION_TTL_HOURS, 4))),
    pioneerPepper: env.PIONEER_CVV_PEPPER || '', // optional; changing it invalidates every CVV (reset via admin)
    rateLimits: env.DISABLE_RATE_LIMITS === 'true' ? false : true,
    // Integration API (/api/integration/v1): refuse plain-HTTP requests. Default on in production; behind a
    // reverse proxy this needs TRUST_PROXY=true so X-Forwarded-Proto is honoured.
    integrationRequireHttps: env.INTEGRATION_REQUIRE_HTTPS ? env.INTEGRATION_REQUIRE_HTTPS === 'true' : prod,
  };
  if (!cfg.appSecret) {
    if (prod) throw new Error('APP_SECRET must be set (at least 32 characters) when NODE_ENV=production');
    cfg.appSecret = randomBytes(32).toString('hex'); // ephemeral in development
    cfg.ephemeralSecret = true;
  } else if (prod && cfg.appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
  return cfg;
}
