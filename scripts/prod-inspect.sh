#!/usr/bin/env bash
# READ-ONLY production inspection for the integration deployment (docs/PRODUCTION_DEPLOY_INTEGRATION.md).
# Changes nothing: no git checkout/pull, no restarts, no writes to files or the database.
# Never prints secret values: secrets are reported only as "set (N chars)" / "EMPTY"; DATABASE_URL without password.
# The database password is passed through the environment (scripts/pgenv.sh), never on a command line.
#   usage:  bash scripts/prod-inspect.sh /path/to/app 2>&1 | tee /tmp/magical-inspect.txt
#   (copy prod-inspect.sh AND pgenv.sh into the same folder if the app checkout does not have them yet)
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)   # pgenv.sh is expected next to this script
APP_DIR=${1:-$PWD}
cd "$APP_DIR" || { echo "no such directory: $APP_DIR"; exit 1; }
hr() { printf '\n== %s\n' "$1"; }

hr "host"
echo "user=$(id -un) host=$(hostname) date=$(date -u +%FT%TZ)"; uname -sr

hr "app directory"
pwd; ls -la | head -40

hr "git (read-only)"
git rev-parse --abbrev-ref HEAD
git log -1 --format='HEAD %H%n     %ci  %s'
echo "working tree changes:"; git status --short | head -30
git remote -v | sed -E 's#://[^@/]+@#://***@#'
for c in de6de67 15eb4b9; do
  if git cat-file -e "$c^{commit}" 2>/dev/null; then
    git merge-base --is-ancestor "$c" HEAD && echo "$c: in HEAD" || echo "$c: present but NOT in HEAD"
  else echo "$c: not in this clone (git fetch needed)"; fi
done
echo "origin/master as last fetched: $(git rev-parse --short origin/master 2>/dev/null || echo unknown)"
echo "migration files:"; ls server/migrations-postgres/ 2>/dev/null
[ -f server/integration.js ] && echo "server/integration.js: present" || echo "server/integration.js: MISSING"

hr "runtime"
echo "node $(node -v 2>/dev/null || echo missing)  npm $(npm -v 2>/dev/null || echo missing)"
echo "pg_dump: $(pg_dump --version 2>/dev/null || echo missing)"
[ -d dist ] && echo "dist/ built: $(stat -c %y dist/index.html 2>/dev/null)" || echo "dist/: MISSING"
[ -d node_modules ] && echo "node_modules: present" || echo "node_modules: MISSING"

hr "process manager"
PIDS=$(pgrep -f 'server/index.js' || true)
for p in $PIDS; do
  echo "pid $p started $(ps -o lstart= -p "$p") cwd=$(readlink "/proc/$p/cwd" 2>/dev/null) cmd: $(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)"
done
[ -z "$PIDS" ] && echo "no running server/index.js process found"
if command -v pm2 >/dev/null; then
  echo "-- pm2 (name, status, cwd, script, args, uptime; env is NOT printed):"
  pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s||"[]")){const e=p.pm2_env||{};console.log([p.name,e.status,e.pm_cwd,e.pm_exec_path,(e.args||[]).join(" "),e.pm_uptime&&new Date(e.pm_uptime).toISOString(),"restarts="+e.restart_time].join(" | "))}})'
fi
if command -v systemctl >/dev/null; then
  echo "-- systemd units mentioning node/magical:"
  for u in $(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '{print $1}' | grep -iE 'magical|node|web' ); do
    systemctl show "$u" -p Id -p ActiveState -p ActiveEnterTimestamp -p WorkingDirectory -p ExecStart -p EnvironmentFiles --no-pager
  done
fi
command -v docker >/dev/null && docker ps --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null

hr "configuration (values of non-secret keys; secrets only as set/empty)"
node --input-type=module - "$PIDS" <<'NODE'
import { readFileSync, existsSync } from 'node:fs';
const pids = (process.argv[2] || '').split(/\s+/).filter(Boolean);
const parse = (txt, sep) => Object.fromEntries(txt.split(sep).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(l)).filter((m) => m && !m[0].trim().startsWith('#')).map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')]));
const sources = { '.env file': existsSync('.env') ? parse(readFileSync('.env', 'utf8'), /\r?\n/) : null };
for (const p of pids) { try { sources[`running pid ${p}`] = parse(readFileSync(`/proc/${p}/environ`, 'utf8'), '\0'); } catch { sources[`running pid ${p}`] = '(not readable as this user)'; } }
const PLAIN = ['NODE_ENV', 'HOST', 'PORT', 'DB_AUTO_MIGRATE', 'TRUST_PROXY', 'COOKIE_SECURE', 'INTEGRATION_REQUIRE_HTTPS', 'STATIC_DIR', 'ALLOWED_ORIGINS', 'SESSION_TTL_HOURS', 'PIONEER_SESSION_TTL_HOURS', 'DATABASE_SSL', 'DISABLE_RATE_LIMITS', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER'];
const SECRET = ['APP_SECRET', 'PIONEER_CVV_PEPPER', 'ADMIN_PASSWORD', 'PGPASSWORD', 'TEST_DATABASE_URL'];
const dbUrl = (v) => { try { const u = new URL(v); return `${u.protocol}//${u.username || '?'}:${u.password ? '***' : '(none)'}@${u.hostname}:${u.port || 5432}${u.pathname}${u.search ? ' (has query params)' : ''}`; } catch { return 'INVALID URL'; } };
for (const [name, env] of Object.entries(sources)) {
  console.log(`-- ${name}`);
  if (!env || typeof env === 'string') { console.log('  ', env ?? 'missing'); continue; }
  for (const k of PLAIN) if (k in env) console.log(`   ${k}=${env[k]}`);
  console.log(`   DATABASE_URL=${env.DATABASE_URL ? dbUrl(env.DATABASE_URL) : '(not set)'}`);
  for (const k of SECRET) if (k in env) console.log(`   ${k}: ${env[k] ? `set (${env[k].length} chars)` : 'EMPTY'}`);
}
NODE
echo "note: 'npm start' adds --production (NODE_ENV=production) even if NODE_ENV is not in the environment."

hr "nginx (proxy / TLS / header directives only)"
if command -v nginx >/dev/null; then
  nginx -T 2>/dev/null | grep -nE '^\s*(server_name|listen|proxy_pass|proxy_set_header|add_header|ssl_certificate |return 30|location )' | head -80 \
    || echo "nginx -T needs root: run this part with sudo"
else echo "nginx not on PATH"; fi

hr "database (read-only session)"
# connection settings via libpq variables (scripts/pgenv.sh): the password never appears on a command line
if [ ! -f "$SCRIPT_DIR/pgenv.sh" ] || ! . "$SCRIPT_DIR/pgenv.sh"; then echo "pgenv.sh missing next to this script, or DATABASE_URL not in .env - skipped"; else
  PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=10 psql -X -q -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
SELECT current_database() AS database, current_user AS "user", split_part(version(), ',', 1) AS server, pg_size_pretty(pg_database_size(current_database())) AS size;
SELECT version, applied_at FROM schema_migrations ORDER BY version;
SELECT to_regclass('integration_clients') IS NOT NULL AS integration_clients, to_regclass('pioneer_card_links') IS NOT NULL AS pioneer_card_links, to_regclass('integration_request_log') IS NOT NULL AS integration_request_log, to_regclass('partner_point_operations') IS NOT NULL AS partner_point_operations_006;
SELECT relname AS table, n_live_tup AS approx_rows FROM pg_stat_user_tables ORDER BY relname;
SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_db, (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS can_create_databases;
SQL
fi

hr "disk space (for the backup)"
df -h "$APP_DIR" /var/backups 2>/dev/null
echo; echo "inspection finished - nothing was changed"
