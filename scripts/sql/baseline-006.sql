-- Production baseline before migration 006. READ-ONLY: one REPEATABLE READ, READ ONLY transaction, so every number
-- below comes from the same consistent snapshot. Prints counts, sums, ids and hashes only - never card data or keys.
-- Run:  . scripts/pgenv.sh && PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' psql -X -f scripts/sql/baseline-006.sql
\set ON_ERROR_STOP on
\pset footer off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo == context
SELECT current_database() AS database, now() AS snapshot_at, current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS read_only;
SELECT string_agg(version, ', ' ORDER BY version) AS applied_migrations FROM schema_migrations;
SELECT to_regclass('partner_point_operations') IS NULL AS migration_006_not_applied_yet;

\echo == runbook Phase 4 fingerprints (exact queries from docs/PRODUCTION_DEPLOY_INTEGRATION.md)
SELECT COUNT(*), SUM(amount), md5(string_agg(id || ':' || card_id || ':' || type || ':' || amount || ':' || balance_after, ',' ORDER BY id)) FROM pioneer_transactions;
SELECT COUNT(*), SUM(balance), md5(string_agg(id || ':' || balance, ',' ORDER BY id)) FROM pioneer_cards;

\echo == ledger bound for the after-migration comparison (ledger rows are append-only: rows up to this id can never change)
SELECT MAX(id) AS ledger_max_id, COUNT(*) AS ledger_rows, COALESCE(SUM(amount), 0) AS ledger_sum FROM pioneer_transactions;

\echo == invariant: every card balance equals its ledger total (expect cards_mismatched = 0 and totals equal)
SELECT COUNT(*) AS cards_mismatched
FROM pioneer_cards c
LEFT JOIN (SELECT card_id, SUM(amount) AS s FROM pioneer_transactions GROUP BY card_id) t ON t.card_id = c.id
WHERE c.balance <> COALESCE(t.s, 0);
SELECT (SELECT COALESCE(SUM(balance), 0) FROM pioneer_cards) AS total_balances,
       (SELECT COALESCE(SUM(amount), 0) FROM pioneer_transactions) AS total_ledger;
\echo == invariant: the newest ledger row of each card carries its current balance (expect 0)
SELECT COUNT(*) AS last_row_mismatched
FROM pioneer_cards c
JOIN LATERAL (SELECT balance_after FROM pioneer_transactions t WHERE t.card_id = c.id ORDER BY t.id DESC LIMIT 1) l ON true
WHERE l.balance_after <> c.balance;

\echo == partner keys (names and scopes only; never hashes or keys)
SELECT name, status, array_to_string(scopes, ',') AS scopes FROM integration_clients ORDER BY id;

\echo == lock check: open transactions older than 30 s that would make an ALTER TABLE wait (expect none)
SELECT pid, state, now() - xact_start AS xact_age, application_name, left(regexp_replace(query, '\s+', ' ', 'g'), 60) AS query_start
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start < now() - interval '30 seconds';

COMMIT;
