# Source from the app directory:   . scripts/pgenv.sh
# Exports the libpq variables (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD, PGSSLMODE) from DATABASE_URL in .env,
# so psql / pg_dump / pg_restore need no URL argument. Prints nothing secret, and the password never appears on a
# command line (where other users could see it via ps); it lives only in this shell's environment.
eval "$(node --input-type=module -e '
const { loadEnvFile } = await import("./server/config.js"); loadEnvFile();
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set in .env"); process.exit(1); }
const u = new URL(process.env.DATABASE_URL);
const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
const v = { PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGDATABASE: decodeURIComponent(u.pathname.slice(1)), PGPASSWORD: decodeURIComponent(u.password) };
const mode = u.searchParams.get("sslmode") || (process.env.DATABASE_SSL === "true" ? "require" : "");
if (mode) v.PGSSLMODE = mode;
process.stdout.write(Object.entries(v).map(([k, x]) => `export ${k}=${q(x)}`).join("\n"));
')" || return 1 2>/dev/null || exit 1
echo "libpq variables set for database ${PGDATABASE} on ${PGHOST}:${PGPORT} as ${PGUSER} (password not shown)"
