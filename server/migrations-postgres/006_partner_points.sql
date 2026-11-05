-- Partner points (integration API v1: POST /points/credit and /points/debit).
-- Additive only: no row is changed or deleted, no column is removed, no existing transaction type is removed.
--   * pioneer_transactions: two new ledger types (partner_credit > 0, partner_redemption < 0) and a nullable link to the
--     partner operation. The three CHECK constraints that list the types are replaced by wider ones in this same
--     transaction; every existing row satisfies them unchanged (re-checked by PostgreSQL when they are added).
--     Balances keep changing ONLY through the existing ledger triggers (pioneer_apply_transaction / balance guard).
--   * integration_clients: two new scopes (never granted automatically), a display name and per-partner limits.
--   * partner_point_operations: one row per executed partner credit/debit = audit record + idempotency record.

-- 1) operations: idempotency + audit. Written in the same database transaction as its ledger row (all or nothing).
CREATE TABLE partner_point_operations (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id        INTEGER NOT NULL REFERENCES integration_clients(id),
  card_id          INTEGER NOT NULL REFERENCES pioneer_cards(id),
  link_id          INTEGER NOT NULL REFERENCES pioneer_card_links(id),
  kind             TEXT NOT NULL CHECK (kind IN ('credit','debit')),
  points           INTEGER NOT NULL CHECK (points BETWEEN 1 AND 1000000),
  reference        TEXT NOT NULL CHECK (reference ~ '^[A-Za-z0-9._:-]{3,100}$'),        -- partner's own id of the event/order
  reason           TEXT NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{1,39}$'),            -- e.g. game_reward, partner_redemption
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  idempotency_key  TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  request_hash     TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),             -- SHA-256 fingerprint of the request
  status           TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),   -- only committed operations are stored
  result           JSONB,                                                             -- the original response, replayed on retries
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_point_operations_idem_key UNIQUE (client_id, idempotency_key),     -- partners never collide with each other
  CONSTRAINT partner_point_operations_reference_key UNIQUE (client_id, reference)       -- one operation per partner reference
);
CREATE INDEX idx_partner_point_operations_card ON partner_point_operations (card_id, created_at);
CREATE INDEX idx_partner_point_operations_client ON partner_point_operations (client_id, kind, created_at);

-- 2) ledger: new types, each row tied to exactly one partner operation
ALTER TABLE pioneer_transactions ADD COLUMN partner_operation_id INTEGER REFERENCES partner_point_operations(id);

ALTER TABLE pioneer_transactions
  DROP CONSTRAINT pioneer_transactions_type_check,
  ADD CONSTRAINT pioneer_transactions_type_check CHECK (type IN ('initial_bonus','transfer_out','transfer_in','redemption','redemption_refund','admin_credit','admin_debit','partner_credit','partner_redemption'));
ALTER TABLE pioneer_transactions
  DROP CONSTRAINT pioneer_tx_sign,
  ADD CONSTRAINT pioneer_tx_sign CHECK (
    (type IN ('initial_bonus','transfer_in','redemption_refund','admin_credit','partner_credit') AND amount > 0) OR
    (type IN ('transfer_out','redemption','admin_debit','partner_redemption') AND amount < 0));
ALTER TABLE pioneer_transactions
  DROP CONSTRAINT pioneer_tx_links,
  ADD CONSTRAINT pioneer_tx_links CHECK (
    (type IN ('transfer_out','transfer_in') AND transfer_id IS NOT NULL AND counterparty_card_id IS NOT NULL) OR
    (type IN ('redemption','redemption_refund') AND redemption_id IS NOT NULL) OR
    (type IN ('admin_credit','admin_debit') AND char_length(description) > 0) OR
    (type IN ('partner_credit','partner_redemption') AND partner_operation_id IS NOT NULL) OR
    type = 'initial_bonus');
-- only partner rows may carry a partner operation, and each operation has exactly one ledger row
ALTER TABLE pioneer_transactions
  ADD CONSTRAINT pioneer_tx_partner_only CHECK (partner_operation_id IS NULL OR type IN ('partner_credit','partner_redemption'));
CREATE UNIQUE INDEX pioneer_tx_one_per_partner_operation ON pioneer_transactions (partner_operation_id) WHERE partner_operation_id IS NOT NULL;

-- 3) partner clients: new scopes (existing keys keep exactly their current scopes), display name, limits
ALTER TABLE integration_clients
  DROP CONSTRAINT integration_clients_scopes_check,
  ADD CONSTRAINT integration_clients_scopes_check CHECK (scopes <@ ARRAY['cards:verify','cards:link','cards:read','rewards:read','points:credit','points:debit']::text[]);
ALTER TABLE integration_clients
  ADD COLUMN display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 2 AND 60),  -- shown in cardholder history
  -- Limits (points). Defaults are deliberately small next to the existing 200-point welcome bonus; change them per
  -- partner with `npm run integration -- set-limits`. Debits are additionally capped by the card balance.
  ADD COLUMN max_credit_per_operation    INTEGER NOT NULL DEFAULT 500    CHECK (max_credit_per_operation BETWEEN 1 AND 1000000),
  ADD COLUMN max_credit_per_card_per_day INTEGER NOT NULL DEFAULT 1000   CHECK (max_credit_per_card_per_day BETWEEN 1 AND 1000000),
  ADD COLUMN max_credit_per_day          INTEGER NOT NULL DEFAULT 20000  CHECK (max_credit_per_day BETWEEN 1 AND 100000000),
  ADD COLUMN max_debit_per_operation     INTEGER NOT NULL DEFAULT 10000  CHECK (max_debit_per_operation BETWEEN 1 AND 1000000);
