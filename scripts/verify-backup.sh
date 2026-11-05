#!/usr/bin/env bash
# Verifies a pg_dump custom-format backup against the live database, READ-ONLY on both sides:
#   - the archive is readable and lists every table,
#   - for every table, the number of rows in the dump equals an exact COUNT(*) in the database.
# Run it right after the backup, before anything writes to the database.
#   usage:  bash scripts/verify-backup.sh /var/backups/magical/<stamp>/magical.dump   (from the app directory)
set -euo pipefail
DUMP=${1:?usage: verify-backup.sh <dump file>}
DBURL=$(node --input-type=module -e "const { loadEnvFile } = await import('./server/config.js'); loadEnvFile(); process.stdout.write(process.env.DATABASE_URL || '')")
[ -n "$DBURL" ] || { echo "DATABASE_URL not found in .env"; exit 1; }
CR=$(printf '\r')
q() { PGOPTIONS='-c default_transaction_read_only=on' psql "$DBURL" -X -A -t -c "$1" | tr -d "$CR"; } # read-only session; CR stripped (Windows psql)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "archive: $DUMP ($(du -h "$DUMP" | cut -f1)), sha256 $(sha256sum "$DUMP" | cut -c1-16)..."
pg_restore -l "$DUMP" > /dev/null && echo "archive table of contents: readable"

# rows per table inside the dump: lines between "COPY public.<table> ..." and "\."
pg_restore --data-only -f - "$DUMP" | tr -d "$CR" | awk '
  /^COPY / { t=$2; sub(/^public\./, "", t); gsub(/"/, "", t); n=0; inside=1; next }
  inside && /^\\\.$/ { print t, n; inside=0; next }
  inside { n++ }' | sort > "$TMP/dump"

# exact rows per table in the database
for t in $(q "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"); do
  echo "$t $(q "SELECT COUNT(*) FROM public.\"$t\"")"
done | sort > "$TMP/db"

printf '%-28s %10s %10s\n' table database dump
join -a1 -a2 -e MISSING -o 0,1.2,2.2 "$TMP/db" "$TMP/dump" | while read -r t a b; do
  printf '%-28s %10s %10s %s\n' "$t" "$a" "$b" "$([ "$a" = "$b" ] && echo ok || echo MISMATCH)"
done | tee "$TMP/result"
if grep -q MISMATCH "$TMP/result"; then
  echo "BACKUP NOT VERIFIED (a mismatch can also mean the site wrote rows after the dump; re-run both right away)"; exit 1
fi
echo "BACKUP VERIFIED: every table matches"
