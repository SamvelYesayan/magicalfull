// Manages integration API keys, scopes, partner limits and card links (run on the server, with the same .env as the app):
//   npm run integration -- create-key --name christmas-store [--scopes cards:verify,cards:link,cards:read,rewards:read] [--out path]
//   npm run integration -- rotate-key --name christmas-store [--out path]
//   npm run integration -- revoke-key --name christmas-store
//   npm run integration -- grant-scope  --name christmas-store --scope points:credit[,points:debit]
//   npm run integration -- revoke-scope --name christmas-store --scope points:credit[,points:debit]
//   npm run integration -- set-limits --name christmas-store [--credit-per-operation N] [--credit-per-card-per-day N] [--credit-per-day N] [--debit-per-operation N]
//   npm run integration -- set-display-name --name christmas-store --display-name "Christmas Store"
//   npm run integration -- list-keys
//   npm run integration -- list-links [--name christmas-store]
//   npm run integration -- list-operations [--name christmas-store] [--card 12345678]
//   npm run integration -- unlink --card 12345678
// One partner = one row in integration_clients; its links, points operations, scopes and limits belong to that row.
// rotate-key and create-key (after revoke-key) replace the key on the SAME row, so nothing of the partner is lost.
// A new key is shown ONCE. With --out it is appended to that file (MAGICAL_PIONEER_API_KEY=...) instead of
// being printed, so it never appears in the terminal or shell history. Only its SHA-256 is stored.
// Scope and limit commands never touch or print the key.
// No command applies database migrations: while any are pending, every command refuses to run.
import { appendFileSync } from 'node:fs';
import { loadEnvFile, loadConfig } from './config.js';
import { createPool, pendingMigrations, withTransaction, isUnique } from './db.js';
import { generateKey, SCOPES, ALL_SCOPES, LIMIT_COLUMNS, partnerLabel } from './integration.js';
import { normalizeCardNo } from '../shared/pioneer.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
const fail = (msg) => { console.error(msg); process.exit(1); };
const USAGE = 'Usage: npm run integration -- <create-key|rotate-key|revoke-key|grant-scope|revoke-scope|set-limits|set-display-name|list-keys|list-links|list-operations|unlink> [options] (see server/integration-cli.js)';
const scopeList = (raw) => {
  const s = String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!s.length || s.some((x) => !ALL_SCOPES.includes(x))) fail(`--scope(s) must be a comma-separated subset of: ${ALL_SCOPES.join(',')}`);
  return s;
};
const summary = (r) => `"${r.name}" (${r.key_prefix}…) scopes: ${r.scopes.join(', ')}`;

loadEnvFile();
let pool, code = 0;
try {
  const cfg = loadConfig({ ...process.env, APP_SECRET: process.env.APP_SECRET || 'x'.repeat(32) });
  pool = createPool(cfg);
  // Never applies migrations itself: a schema change must only happen through the explicit, backed-up `npm run migrate`.
  const pending = await pendingMigrations(pool);
  if (pending.length) fail(`Refusing to run: database migrations are pending (${pending.join(', ')}). Back up the database and run \`npm run migrate\` first (docs/PRODUCTION_DEPLOY_INTEGRATION.md, Phase 4).`);

  const name = opt('name');
  const needName = () => { if (!name || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(name)) fail('--name is required: 2-49 lower-case letters, digits or "-", e.g. christmas-store'); return name; };
  const deliver = (key, row) => {
    const file = opt('out');
    if (file) {
      appendFileSync(file, `\nMAGICAL_PIONEER_API_KEY=${key}\n`, { mode: 0o600 });
      console.log(`API key for ${summary(row)} written to ${file}. It is not stored anywhere else and cannot be shown again.`);
    } else {
      console.log(`API key for ${summary(row)}. Store it in the partner's secret configuration now; it cannot be shown again:\n\n${key}\n`);
    }
  };
  // Puts a fresh key on the partner's row (new partner: new row). The old key stops working in the same statement.
  const setKey = async (c, n, { scopes, requireActive }) => {
    const k = generateKey();
    const cur = (await c.query('SELECT id, status FROM integration_clients WHERE name = $1 ORDER BY (status = \'active\') DESC, id DESC LIMIT 1 FOR UPDATE', [n])).rows[0];
    if (requireActive && cur?.status !== 'active') fail(`No active key named "${n}".`);
    if (cur && cur.status === 'active' && !requireActive) fail(`An active key named "${n}" already exists. Use rotate-key or revoke-key.`);
    const row = cur
      ? (await c.query(`UPDATE integration_clients SET key_prefix = $2, key_hash = $3, status = 'active', revoked_at = NULL${scopes ? ', scopes = $4' : ''} WHERE id = $1 RETURNING name, key_prefix, scopes`,
        [cur.id, k.prefix, k.hash, ...(scopes ? [scopes] : [])])).rows[0]
      : (await c.query('INSERT INTO integration_clients (name, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4) RETURNING name, key_prefix, scopes', [n, k.prefix, k.hash, scopes || SCOPES])).rows[0];
    return { key: k.key, row };
  };
  const activeRow = async (n) => {
    const r = (await pool.query("SELECT * FROM integration_clients WHERE name = $1 AND status = 'active'", [n])).rows[0];
    if (!r) fail(`No active key named "${n}".`);
    return r;
  };

  if (cmd === 'create-key') {
    // new partner, or a new key for a partner whose key was revoked (keeps its links, operations, scopes and limits)
    const scopes = opt('scopes') ? scopeList(opt('scopes')) : null;
    try { const { key, row } = await withTransaction(pool, (c) => setKey(c, needName(), { scopes })); deliver(key, row); }
    catch (e) { if (isUnique(e, 'one_active_name')) fail(`An active key named "${name}" already exists. Use rotate-key or revoke-key.`); throw e; }
  } else if (cmd === 'rotate-key') {
    const { key, row } = await withTransaction(pool, (c) => setKey(c, needName(), { requireActive: true }));
    deliver(key, row);
  } else if (cmd === 'revoke-key') {
    const n = needName();
    const r = await pool.query("UPDATE integration_clients SET status = 'revoked', revoked_at = now() WHERE name = $1 AND status = 'active' RETURNING key_prefix", [n]);
    console.log(r.rowCount ? `Revoked "${n}" (${r.rows[0].key_prefix}…). Its links, operations, scopes and limits are kept; create-key gives the same partner a new key.` : `No active key named "${n}".`);
  } else if (cmd === 'grant-scope' || cmd === 'revoke-scope') {
    const n = needName(), s = scopeList(opt('scope') || opt('scopes'));
    await activeRow(n);
    const r = (await pool.query(
      cmd === 'grant-scope'
        ? "UPDATE integration_clients SET scopes = ARRAY(SELECT DISTINCT x FROM unnest(scopes || $2::text[]) AS x ORDER BY x) WHERE name = $1 AND status = 'active' RETURNING name, key_prefix, scopes"
        : "UPDATE integration_clients SET scopes = ARRAY(SELECT x FROM unnest(scopes) AS x WHERE x <> ALL($2::text[]) ORDER BY x) WHERE name = $1 AND status = 'active' RETURNING name, key_prefix, scopes",
      [n, s])).rows[0];
    console.log(`${cmd === 'grant-scope' ? 'Granted' : 'Revoked'} ${s.join(', ')}. Now: ${summary(r)}. The key itself is unchanged.`);
  } else if (cmd === 'set-limits') {
    const n = needName(), sets = [], args = [n];
    for (const [flag, col] of Object.entries(LIMIT_COLUMNS)) {
      if (opt(flag) === undefined) continue;
      if (!/^\d{1,9}$/.test(opt(flag)) || Number(opt(flag)) < 1) fail(`--${flag} must be a positive whole number`);
      args.push(Number(opt(flag))); sets.push(`${col} = $${args.length}`);
    }
    if (!sets.length) fail(`Give at least one of: ${Object.keys(LIMIT_COLUMNS).map((f) => '--' + f).join(' ')}`);
    await activeRow(n);
    const r = (await pool.query(`UPDATE integration_clients SET ${sets.join(', ')} WHERE name = $1 AND status = 'active' RETURNING *`, args)).rows[0];
    console.log(`Limits for "${n}":`, Object.fromEntries(Object.entries(LIMIT_COLUMNS).map(([f, col]) => [f, r[col]])));
  } else if (cmd === 'set-display-name') {
    const n = needName(), d = String(opt('display-name') || '').trim();
    if (d.length < 2 || d.length > 60) fail('--display-name must be 2-60 characters, e.g. "Christmas Store"');
    await activeRow(n);
    await pool.query("UPDATE integration_clients SET display_name = $2 WHERE name = $1 AND status = 'active'", [n, d]);
    console.log(`"${n}" is shown to cardholders as "${d}".`);
  } else if (cmd === 'list-keys') {
    const { rows } = await pool.query('SELECT * FROM integration_clients ORDER BY id');
    console.table(rows.map((r) => ({
      name: r.name, shownAs: partnerLabel(r), key: r.key_prefix + '…', scopes: r.scopes.join(','), status: r.status,
      limits: `credit ${r.max_credit_per_operation}/op, ${r.max_credit_per_card_per_day}/card/24h, ${r.max_credit_per_day}/24h; debit ${r.max_debit_per_operation}/op`,
      lastUsed: r.last_used_at,
    })));
  } else if (cmd === 'list-links') {
    const { rows } = await pool.query(
      `SELECT k.name AS client, l.external_customer_id, '•••• ' || right(c.card_no, 4) AS card, l.status, l.linked_at, l.unlinked_at, l.unlinked_by
       FROM pioneer_card_links l JOIN integration_clients k ON k.id = l.client_id JOIN pioneer_cards c ON c.id = l.card_id
       WHERE ($1::text IS NULL OR k.name = $1) ORDER BY l.id DESC LIMIT 500`, [name ?? null]);
    console.table(rows);
  } else if (cmd === 'list-operations') {
    const cardNo = opt('card') ? normalizeCardNo(opt('card')) : null;
    if (opt('card') && !cardNo) fail('--card must be the 8-digit card number');
    const { rows } = await pool.query(
      `SELECT o.created_at, k.name AS client, o.kind, o.points, '•••• ' || right(c.card_no, 4) AS card, o.reference, o.reason, o.description, o.idempotency_key, o.status, t.id AS ledger_id, t.balance_after
       FROM partner_point_operations o JOIN integration_clients k ON k.id = o.client_id JOIN pioneer_cards c ON c.id = o.card_id
       LEFT JOIN pioneer_transactions t ON t.partner_operation_id = o.id
       WHERE ($1::text IS NULL OR k.name = $1) AND ($2::text IS NULL OR c.card_no = $2) ORDER BY o.id DESC LIMIT 500`, [name ?? null, cardNo]);
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
