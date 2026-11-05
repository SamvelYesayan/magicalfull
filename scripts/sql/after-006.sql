-- After migration 006. READ-ONLY. Run with the ledger_max_id printed by baseline.sql:
--   . scripts/pgenv.sh && PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' psql -X -v ledger_max_id=<N> -f scripts/sql/after-006.sql
-- The bounded ledger fingerprint must equal the baseline Phase 4 ledger fingerprint EXACTLY (ledger rows are
-- append-only). Card balances may legitimately differ if customers were active; the invariants must still hold.
\set ON_ERROR_STOP on
\pset footer off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo == context
SELECT current_database() AS database, now() AS snapshot_at, current_setting('transaction_read_only') AS read_only;
SELECT string_agg(version, ', ' ORDER BY version) AS applied_migrations FROM schema_migrations;
SELECT to_regclass('partner_point_operations') IS NOT NULL AS migration_006_applied,
       (SELECT COUNT(*) FROM partner_point_operations) AS partner_operations;

\echo == ledger rows up to the baseline id (must equal the baseline ledger fingerprint)
SELECT COUNT(*), SUM(amount), md5(string_agg(id || ':' || card_id || ':' || type || ':' || amount || ':' || balance_after, ',' ORDER BY id))
FROM pioneer_transactions WHERE id <= :ledger_max_id;
\echo == ledger rows written since the baseline (expect 0 in a quiet window; never partner types before Phase 8)
SELECT COUNT(*) AS new_rows, COUNT(*) FILTER (WHERE type IN ('partner_credit', 'partner_redemption')) AS new_partner_rows
FROM pioneer_transactions WHERE id > :ledger_max_id;
\echo == card fingerprint (equals the baseline if no ledger row was added since)
SELECT COUNT(*), SUM(balance), md5(string_agg(id || ':' || balance, ',' ORDER BY id)) FROM pioneer_cards;

\echo == invariants (expect 0, 0 and equal totals)
SELECT COUNT(*) AS cards_mismatched
FROM pioneer_cards c
LEFT JOIN (SELECT card_id, SUM(amount) AS s FROM pioneer_transactions GROUP BY card_id) t ON t.card_id = c.id
WHERE c.balance <> COALESCE(t.s, 0);
SELECT COUNT(*) AS last_row_mismatched
FROM pioneer_cards c
JOIN LATERAL (SELECT balance_after FROM pioneer_transactions t WHERE t.card_id = c.id ORDER BY t.id DESC LIMIT 1) l ON true
WHERE l.balance_after <> c.balance;
SELECT (SELECT COALESCE(SUM(balance), 0) FROM pioneer_cards) AS total_balances,
       (SELECT COALESCE(SUM(amount), 0) FROM pioneer_transactions) AS total_ledger;

\echo == partner keys: no key may have points scopes yet (expect points_scoped_keys = 0)
SELECT COUNT(*) FILTER (WHERE scopes && ARRAY['points:credit', 'points:debit']) AS points_scoped_keys FROM integration_clients;

\echo == the widened ledger rules are in place
SELECT conname FROM pg_constraint WHERE conrelid = 'pioneer_transactions'::regclass AND contype = 'c' ORDER BY conname;

COMMIT;
