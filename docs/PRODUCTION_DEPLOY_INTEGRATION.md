# Production deployment: Pioneer Card integration API (005) and partner points (006)

Runbook for bringing the integration API (migration `005`, `master` `15eb4b9`) and the partner points operations
(migration `006`, branch `pioneer-points-api`, deployed once it is reviewed and merged into `master`) live on magical.am.
Nothing here has been executed. Phase 0 is read-only; every later phase needs explicit approval.
If `005` is already applied on production, the same phases apply; `npm run migrate` then applies only `006`.

`TARGET` below = the reviewed `master` commit that contains `006_partner_points.sql` (fill in after the merge).

Placeholders used below (fill in from the Phase 0 output):
`APP_DIR` (app checkout on the server), `APP` (pm2 name or systemd unit), `BK` (backup folder).

---

## What is known now (checked from outside, no server access)

| Item | Finding |
|---|---|
| GitHub `master` | `15eb4b9` = merge of PR #1; contains `de6de67` and migration `005_integration_api.sql`. |
| Live site | Runs code **after** the seminar removal (`/invitation` → 302, `/api/registrations` → 404) but **without** the integration API (`/api/integration/v1/*` → 404 from the Node app). |
| Reverse proxy | nginx 1.28; `http://` → `301 https://`. Only ports 80/443 are reachable; Node (3000) and PostgreSQL (5432) are not exposed. |
| HSTS | **Not sent.** The app only sends HSTS when secure cookies are on → production almost certainly runs with `COOKIE_SECURE=false` (or not in production mode). |
| DNS | Wildcard `*.magical.am` → `5.63.165.46` (not serving HTTPS). `api.magical.am` → production IP, but HTTPS on it fails. |

## Phase 0 — read-only inspection (safe, changes nothing)

`scripts/prod-inspect.sh` and `scripts/verify-backup.sh` are not on GitHub yet: copy both into `APP_DIR/scripts/`
on the server (copying files changes nothing the app uses). Then, from the app directory:

```bash
sudo -v                      # nginx -T needs root; the rest runs as the app user
bash scripts/prod-inspect.sh "$PWD" 2>&1 | tee /tmp/magical-inspect.txt
```

It prints: directory, branch, HEAD commit, whether `de6de67`/`15eb4b9` are in HEAD, migration files, node/npm/pg_dump
versions, the running process (pid, start time, cwd, command) and pm2/systemd/docker details, configuration values
of **non-secret** keys from `.env` *and* from the running process (`/proc/<pid>/environ`), secrets only as
`set (N chars)` / `EMPTY`, `DATABASE_URL` with the password replaced by `***`, nginx proxy/TLS directives, and a
**read-only** database session (`default_transaction_read_only=on`): applied migrations, whether the integration
tables exist, approximate row counts, privileges, disk space. Send me the output.

Decision points from that output:
- the process is started via `npm start` / `--production` (production mode) or not;
- the **running** values of `TRUST_PROXY`, `COOKIE_SECURE`, `DB_AUTO_MIGRATE` (may differ from `.env` if the
  process manager sets them);
- `DATABASE_URL` points to the production database (host/name), not a copy;
- nginx sets `X-Forwarded-For` / `X-Forwarded-Proto` and how.

## Phase 1 — configuration decisions (need your choice; nothing changed yet)

### `COOKIE_SECURE` and HSTS

How the code works (`server/config.js`, `server/app.js`, `server/pioneer.js`, `server/security.js`):
`COOKIE_SECURE=true` (or unset with production mode) does **two** things at once:
1. the admin cookie `mg_admin` and the cardholder cookie `mg_pioneer` get the `Secure` flag (already `HttpOnly`,
   `SameSite=Strict`);
2. every response carries `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

Why `Secure` is correct here: TLS ends at nginx, but the *browser* only ever talks HTTPS to magical.am (HTTP is
301-redirected), so Secure cookies keep working; Node does not need to see TLS. Today, without `Secure`, a browser
that opens `http://magical.am/...` (typed address, old link) sends the session cookie **in clear text** before the
redirect — on hostile Wi-Fi that is enough to steal an admin or cardholder session.

HSTS caveat: once a browser has seen that header it refuses plain HTTP to magical.am **and every subdomain** for one
year, and this cannot be rolled back for those browsers. Affected today: `api.magical.am` (points to the server,
HTTPS broken) and anything under the wildcard. If no subdomain is (or will be) used without valid HTTPS — including a
possible `shop.magical.am` for the Christmas Store — this is fine.

Options (choose one):
- **A (recommended if no subdomain needs HTTP):** set `COOKIE_SECURE=true`. Secure cookies + 1-year HSTS incl. subdomains.
- **B (cautious):** first a small code change making the HSTS `max-age`/`includeSubDomains` configurable, start with
  a short max-age without subdomains, raise later. Separate commit and review; not part of this deploy.
- Either way, existing logins stay valid (cookies are re-sent with the new flag on the next login; sessions in the
  database are unaffected).

### `TRUST_PROXY`

Needed `true` behind nginx, otherwise:
- the integration API refuses **every** request with `403 https_required` (it cannot see `X-Forwarded-Proto`);
- all visitors share nginx's IP (`127.0.0.1`), so the per-IP limits (e.g. 15 Pioneer logins / 15 min) are hit by
  everyone together — this already affects the live site if it is `false` today.

Safe only if nginx **overwrites** the headers (the app trusts the first `X-Forwarded-For` entry; with
`$proxy_add_x_forwarded_for` a client could spoof it) and Node listens on `127.0.0.1` (`HOST=127.0.0.1`, verified:
port 3000 is not reachable from outside). Required nginx lines in the `location` that proxies to Node:

```nginx
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-For   $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

### `DB_AUTO_MIGRATE`

Recommendation: run the migration **explicitly** (Phase 4) before restarting, so a failure never happens during the
restart. `DB_AUTO_MIGRATE` can stay as it is: if it is `true`, the app finds nothing pending at start.

### Other

`INTEGRATION_REQUIRE_HTTPS` — leave unset (on by default in production mode). `ADMIN_PASSWORD` — should be empty
in the production `.env` after seeding (Phase 0 shows only whether it is set).

## Phase 2 — backup (needs approval)

Writes only into a new backup folder; the database session used by pg_dump is a plain read.

```bash
cd "$APP_DIR"
BK=/var/backups/magical/$(date +%Y%m%d-%H%M%S)
sudo install -d -m 700 -o "$(id -un)" "$BK"
DBURL=$(node --input-type=module -e "const { loadEnvFile } = await import('./server/config.js'); loadEnvFile(); process.stdout.write(process.env.DATABASE_URL || '')")

# 1) database (custom format, includes schema + all data)
PGOPTIONS='-c default_transaction_read_only=on' pg_dump -Fc -f "$BK/magical.dump" "$DBURL"
# 2) verify: archive readable + exact row count per table equals the live database
bash scripts/verify-backup.sh "$BK/magical.dump"
# 3) code and configuration as they are now (the .env copy contains secrets: keep it in the 700 folder)
git rev-parse HEAD > "$BK/previous-commit.txt"
tar --exclude=node_modules --exclude=.git -czf "$BK/app.tgz" .
cp -p .env "$BK/env.backup" && chmod 600 "$BK/env.backup"
# 4) checksums, then copy the folder off the server (e.g. scp to a second machine)
( cd "$BK" && sha256sum magical.dump app.tgz env.backup > SHA256SUMS )
```

`pg_dump` must be the same major version as the server or newer (Phase 0 prints both).
Optional full restore test (needs a role that may create databases): `createdb magical_restore_check`,
`pg_restore -d magical_restore_check "$BK/magical.dump"`, compare counts, then drop **only** that scratch database.

## Phase 3 — code and build (needs approval; the live process keeps running the old code)

```bash
cd "$APP_DIR"
git status --short                      # must be empty; stop if not
git fetch origin
git merge --ff-only "$TARGET"           # moves to the reviewed master commit; refuses if history diverged
git log -1 --oneline                    # expect: TARGET
ls server/migrations-postgres/          # expect 001 ... 006
npm ci --include=dev                    # dev deps needed for the build (vite) even when NODE_ENV=production
npm run build                           # rebuilds dist/ (only static files change)
```

Do **not** run `npm test` on the server (the tests wipe their own `*_test` database and are guarded, but they do not
belong on production).

## Phase 4 — configuration and migration (needs approval)

1. `.env`: edit only the decided lines in place (keeps every other line; a timestamped copy first):
   ```bash
   cp -p .env ".env.before-integration-$(date +%Y%m%d-%H%M%S)"
   # set TRUST_PROXY=true and (option A) COOKIE_SECURE=true — edit with an editor; do not regenerate the file
   ```
2. nginx: add/adjust the three `proxy_set_header` lines, then `sudo nginx -t && sudo systemctl reload nginx`
   (reload keeps connections; `-t` aborts on a syntax error).
3. Migrations (old code keeps running; it ignores the new tables, columns and ledger types):
   ```bash
   npm run migrate                      # expect: Applied: 005_integration_api.sql, 006_partner_points.sql (or only 006)
   bash scripts/prod-inspect.sh "$PWD" | sed -n '/== database/,/== disk/p'   # integration tables: t t t
   ```

What `005_integration_api.sql` does (reviewed line by line): three `CREATE TABLE` (`integration_clients`,
`pioneer_card_links`, `integration_request_log`) and seven `CREATE INDEX`, nothing else — no `ALTER`, `UPDATE`,
`DELETE`, `DROP`, `INSERT` or `TRUNCATE`. It runs in one transaction together with its `schema_migrations` row
(all or nothing). `pioneer_card_links.card_id` references `pioneer_cards(id)`: this adds no column or constraint to
`pioneer_cards` and the app never hard-deletes cards. Creating that foreign key briefly locks `pioneer_cards` against
writes (milliseconds on an empty new table).

What `006_partner_points.sql` does (reviewed line by line; one transaction, all or nothing):
- `CREATE TABLE partner_point_operations` (+ 2 indexes): audit/idempotency record of partner credits/debits.
- `pioneer_transactions`: `ADD COLUMN partner_operation_id` (nullable, NULL on every existing row; adding a nullable
  column rewrites nothing), then the three CHECK constraints that list ledger types
  (`pioneer_transactions_type_check`, `pioneer_tx_sign`, `pioneer_tx_links`) are dropped and re-added **wider** in
  the same transaction: every existing type keeps exactly its old rule, `partner_credit` (> 0) and
  `partner_redemption` (< 0) are added. Re-adding a CHECK makes PostgreSQL re-read the existing rows to prove they
  still satisfy it; it does not change them. One more CHECK and a partial unique index tie partner rows to one
  operation. The ledger triggers (balance update, append-only, no direct balance changes) are not touched.
- `integration_clients`: the scopes CHECK is widened to allow `points:credit`/`points:debit` (**no key gets them**),
  plus `display_name` and four limit columns with constant defaults (metadata-only change).
- No `UPDATE`, `DELETE`, `INSERT`, `TRUNCATE` or `DROP TABLE`/`DROP COLUMN`. Locks: `ALTER TABLE` on
  `pioneer_transactions` takes an exclusive lock for the duration of the check scan (milliseconds to seconds for
  this table size); card logins, transfers and redemptions wait meanwhile, nothing fails.
- Proven by `tests/integration-points.test.js` ("migration 006 on an existing database keeps every card, balance
  and ledger row unchanged"): cards, balances, every ledger row and partner keys are identical before/after.

Extra pre-check for `006` (read-only, right after the Phase 2 backup), to compare after the migration:
```bash
PGOPTIONS='-c default_transaction_read_only=on' psql "$DBURL" -X -A -t -c "SELECT COUNT(*), SUM(amount), md5(string_agg(id || ':' || card_id || ':' || type || ':' || amount || ':' || balance_after, ',' ORDER BY id)) FROM pioneer_transactions" | tee "$BK/ledger-before.txt"
PGOPTIONS='-c default_transaction_read_only=on' psql "$DBURL" -X -A -t -c "SELECT COUNT(*), SUM(balance), md5(string_agg(id || ':' || balance, ',' ORDER BY id)) FROM pioneer_cards" | tee "$BK/cards-before.txt"
# after `npm run migrate`: run the same two queries; the output must be identical
```

## Phase 5 — restart (needs approval)

Exactly one of these, depending on Phase 0:
```bash
pm2 restart "$APP" --update-env && pm2 save
sudo systemctl restart "$APP"
```
Expect a few seconds of 502 from nginx while Node starts.

## Phase 6 — verification (read-only)

```bash
curl -s https://magical.am/api/health                                   # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://magical.am/             # 200
curl -s https://magical.am/api/integration/v1/me                         # 401 invalid_api_key  (was 404)
curl -s -H 'Origin: https://example.com' https://magical.am/api/integration/v1/me   # 403 browser_requests_not_allowed
curl -sI https://magical.am/ | grep -i strict-transport                  # present if COOKIE_SECURE=true
```
Then: admin login at `/admin` and a Pioneer Card login still work (log in again once; new cookies carry `Secure`),
and the server log shows `Magical server listening ... (production), database "<production db>"`.

## Phase 7 — production API key (needs approval, separately)

Only if `christmas-store` has no key yet (`npm run integration -- list-keys` shows names and prefixes, never keys):
```bash
npm run integration -- create-key --name christmas-store --out "$BK/christmas-store.env"
```
Hand the value over through a secrets manager, then delete that file. Check with
`curl -s -H "Authorization: Bearer $KEY" https://magical.am/api/integration/v1/me` → `200`.

## Phase 8 — authorise points for Christmas Store (needs approval, separately; the key does not change)

```bash
npm run integration -- set-display-name --name christmas-store --display-name "Christmas Store"   # shown in cardholder history
npm run integration -- set-limits --name christmas-store --credit-per-operation 500 --credit-per-card-per-day 1000 --credit-per-day 20000 --debit-per-operation 10000   # defaults; adjust to the agreed business limits
npm run integration -- grant-scope --name christmas-store --scope points:credit,points:debit
npm run integration -- list-keys                       # check scopes and limits
```
To stop all partner point movements at once: `npm run integration -- revoke-scope --name christmas-store --scope points:credit,points:debit`.
Audit at any time: `npm run integration -- list-operations --name christmas-store`.

## Rollback

| Problem | Action | Data impact |
|---|---|---|
| New code misbehaves | `git checkout "$(cat "$BK/previous-commit.txt")"`, `npm ci --include=dev`, `npm run build`, restart (Phase 5). The old code ignores the three new tables. | none |
| `.env` change causes problems | copy the timestamped `.env.before-integration-*` back, restart | none |
| nginx change causes problems | revert the lines, `sudo nginx -t && sudo systemctl reload nginx` | none |
| Partner points must stop | `npm run integration -- revoke-scope --name christmas-store --scope points:credit,points:debit` (immediate, no restart) | none; history stays |
| Integration tables must go (only before any partner uses them) | `BEGIN; DROP TABLE integration_request_log, pioneer_card_links, integration_clients; DELETE FROM schema_migrations WHERE version = '005_integration_api.sql'; COMMIT;` | drops only the three new tables (keys, links, request log) |
| Migration 006 must be undone (only while `partner_point_operations` is empty) | revert code first; then in one transaction drop the added constraint/index/column/table and restore the three old CHECK definitions from `002_pioneer.sql` (the exact SQL is in `tests/integration-points.test.js`, migration test), and `DELETE FROM schema_migrations WHERE version = '006_partner_points.sql'` | none while empty. Once partner ledger rows exist they are part of the append-only ledger and must stay: roll back code only (old code shows them under their raw type name) |
| Database damaged (not expected from this deploy) | restore `$BK/magical.dump` into a **new** database, compare, then point `DATABASE_URL` to it | loses writes made after the backup — last resort |
| HSTS | cannot be withdrawn from browsers that already received it (see Phase 1) | — |
