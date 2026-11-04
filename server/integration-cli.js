// Manages integration API keys and card links (run on the server, with the same .env as the app):
//   npm run integration -- create-key --name christmas-store [--scopes cards:verify,cards:link,cards:read,rewards:read] [--out path]
//   npm run integration -- rotate-key --name christmas-store [--out path]
//   npm run integration -- revoke-key --name christmas-store
//   npm run integration -- list-keys
//   npm run integration -- list-links [--name christmas-store]
//   npm run integration -- unlink --card 12345678
// A new key is shown ONCE. With --out it is appended to that file (MAGICAL_PIONEER_API_KEY=...) instead of
// being printed, so it never appears in the terminal or shell history. Only its SHA-256 is stored.
import { appendFileSync } from 'node:fs';
import { loadEnvFile, loadConfig } from './config.js';
import { createPool, migrate, withTransaction, isUnique } from './db.js';
import { generateKey, SCOPES } from './integration.js';
import { normalizeCardNo } from '../shared/pioneer.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
const fail = (msg) => { console.error(msg); process.exit(1); };
const USAGE = 'Usage: npm run integration -- <create-key|rotate-key|revoke-key|list-keys|list-links|unlink> [options] (see server/integration-cli.js)';

loadEnvFile();
let pool, code = 0;
try {
  const cfg = loadConfig({ ...process.env, APP_SECRET: process.env.APP_SECRET || 'x'.repeat(32) });
  pool = createPool(cfg);
  await migrate(pool); // additive only (005_integration_api.sql creates the tables if missing)

  const name = opt('name');
  const needName = () => { if (!name || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(name)) fail('--name is required: 2-49 lower-case letters, digits or "-", e.g. christmas-store'); return name; };
  const deliver = (key, row) => {
    const file = opt('out');
    if (file) {
      appendFileSync(file, `\nMAGICAL_PIONEER_API_KEY=${key}\n`, { mode: 0o600 });
      console.log(`API key for "${row.name}" (${row.key_prefix}…, scopes ${row.scopes.join(',')}) written to ${file}. It is not stored anywhere else and cannot be shown again.`);
    } else {
      console.log(`API key for "${row.name}" (scopes ${row.scopes.join(',')}). Store it in the partner's secret configuration now; it cannot be shown again:\n\n${key}\n`);
    }
  };
  const insertKey = async (c, n, scopes) => {
    const k = generateKey();
    const row = (await c.query('INSERT INTO integration_clients (name, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4) RETURNING name, key_prefix, scopes', [n, k.prefix, k.hash, scopes])).rows[0];
    return { key: k.key, row };
  };

  if (cmd === 'create-key') {
    const scopes = (opt('scopes') || SCOPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    if (!scopes.length || scopes.some((s) => !SCOPES.includes(s))) fail(`--scopes must be a comma-separated subset of: ${SCOPES.join(',')}`);
    try { const { key, row } = await insertKey(pool, needName(), scopes); deliver(key, row); }
    catch (e) { if (isUnique(e, 'one_active_name')) fail(`An active key named "${name}" already exists. Use rotate-key or revoke-key.`); throw e; }
  } else if (cmd === 'rotate-key') {
    const n = needName();
    const { key, row } = await withTransaction(pool, async (c) => { // old key stops working the moment the new one exists
      const old = (await c.query("UPDATE integration_clients SET status = 'revoked', revoked_at = now() WHERE name = $1 AND status = 'active' RETURNING scopes", [n])).rows[0];
      if (!old) fail(`No active key named "${n}".`);
      return insertKey(c, n, old.scopes);
    });
    deliver(key, row);
  } else if (cmd === 'revoke-key') {
    const n = needName();
    const r = await pool.query("UPDATE integration_clients SET status = 'revoked', revoked_at = now() WHERE name = $1 AND status = 'active' RETURNING key_prefix", [n]);
    console.log(r.rowCount ? `Revoked "${n}" (${r.rows[0].key_prefix}…). Its card links are kept; a new key with the same name sees them again.` : `No active key named "${n}".`);
  } else if (cmd === 'list-keys') {
    const { rows } = await pool.query('SELECT name, key_prefix, scopes, status, created_at, last_used_at, revoked_at FROM integration_clients ORDER BY id');
    console.table(rows.map((r) => ({ name: r.name, key: r.key_prefix + '…', scopes: r.scopes.join(','), status: r.status, created: r.created_at, lastUsed: r.last_used_at, revoked: r.revoked_at })));
  } else if (cmd === 'list-links') {
    const { rows } = await pool.query(
      `SELECT k.name AS client, l.external_customer_id, '•••• ' || right(c.card_no, 4) AS card, l.status, l.linked_at, l.unlinked_at, l.unlinked_by
       FROM pioneer_card_links l JOIN integration_clients k ON k.id = l.client_id JOIN pioneer_cards c ON c.id = l.card_id
       WHERE ($1::text IS NULL OR k.name = $1) ORDER BY l.id DESC LIMIT 500`, [name ?? null]);
    console.table(rows);
  } else if (cmd === 'unlink') {
    const cardNo = normalizeCardNo(opt('card'));
    if (!cardNo) fail('--card must be the 8-digit card number');
    const r = await pool.query(
      `UPDATE pioneer_card_links l SET status = 'unlinked', unlinked_at = now(), unlinked_by = 'admin' FROM pioneer_cards c
       WHERE c.id = l.card_id AND c.card_no = $1 AND l.status = 'active'`, [cardNo]);
    console.log(r.rowCount ? `Card •••• ${cardNo.slice(4)} unlinked.` : 'That card has no active link.');
  } else fail(USAGE);
} catch (e) {
  console.error(`Failed: ${e.code ? `[${e.code}] ` : ''}${e.message}`);
  code = 1;
} finally { if (pool) await pool.end(); }
process.exit(code);
