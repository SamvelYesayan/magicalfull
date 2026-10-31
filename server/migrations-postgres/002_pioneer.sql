-- Magical Pioneer Card: loyalty cards, points ledger, transfers, rewards, redemptions, announcements, audit.
-- Purely additive: no existing table is altered. Executed inside a transaction by server/db.js.
-- Rollback (destroys Pioneer data only): see README "Pioneer Card -> Rollback".

-- Single-row settings (initial bonus is configurable by the admin; 200 by default).
CREATE TABLE pioneer_settings (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  initial_bonus INTEGER NOT NULL DEFAULT 200 CHECK (initial_bonus BETWEEN 0 AND 100000),
  updated_at    TIMESTAMPTZ,
  updated_by    INTEGER REFERENCES admins(id) ON DELETE SET NULL
);
INSERT INTO pioneer_settings (id) VALUES (TRUE);

CREATE TABLE pioneer_cards (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_no      TEXT NOT NULL CHECK (card_no ~ '^[1-9][0-9]{7}$'), -- public 8-digit identifier printed on the card
  cvv_hash     TEXT NOT NULL,                                     -- scrypt hash of the (peppered) 3-digit CVV; the CVV itself is never stored
  first_name   TEXT CHECK (first_name IS NULL OR char_length(first_name) BETWEEN 1 AND 50),
  last_name    TEXT CHECK (last_name  IS NULL OR char_length(last_name)  BETWEEN 1 AND 50),
  phone        TEXT CHECK (phone IS NULL OR char_length(phone) BETWEEN 8 AND 20),
  balance      INTEGER NOT NULL DEFAULT 0,                        -- maintained ONLY by the ledger trigger below
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  search_text  TEXT NOT NULL,                                     -- lower-cased copy (done in the app) for Unicode-aware search
  created_by   INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,                                       -- first successful cardholder login
  last_login_at TIMESTAMPTZ,
  cvv_reset_at TIMESTAMPTZ,
  CONSTRAINT pioneer_cards_card_no_key UNIQUE (card_no),
  CONSTRAINT pioneer_cards_balance_nonneg CHECK (balance >= 0)
);
CREATE INDEX idx_pioneer_cards_created ON pioneer_cards (created_at);
CREATE INDEX idx_pioneer_cards_status ON pioneer_cards (status);

-- Failed-login counters keyed by the SUBMITTED card number (whether or not it exists), so a locked
-- number behaves identically for real and non-existent cards. Survives restarts (unlike the in-memory IP limiter).
CREATE TABLE pioneer_login_guard (
  card_no      TEXT PRIMARY KEY CHECK (card_no ~ '^[0-9]{8}$'),
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,                                       -- 'infinity' = hard lock, cleared only by an admin
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pioneer_sessions (
  token_hash TEXT PRIMARY KEY,                                    -- sha256 of the cookie value
  card_id    INTEGER NOT NULL REFERENCES pioneer_cards(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_pioneer_sessions_card ON pioneer_sessions (card_id);
CREATE INDEX idx_pioneer_sessions_expires ON pioneer_sessions (expires_at);

CREATE TABLE pioneer_rewards (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             TEXT NOT NULL DEFAULT 'course_discount' CHECK (kind IN ('course_discount','reward')),
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  icon             TEXT NOT NULL DEFAULT 'spark' CHECK (icon IN ('spark','code','design','mobile','gift','star','book','rocket')),
  points_cost      INTEGER NOT NULL CHECK (points_cost BETWEEN 1 AND 1000000),
  discount_percent INTEGER CHECK (discount_percent IS NULL OR discount_percent BETWEEN 1 AND 100),
  discount_amount  INTEGER CHECK (discount_amount IS NULL OR discount_amount BETWEEN 1 AND 100000000), -- whole AMD
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  available_from   TIMESTAMPTZ,
  available_until  TIMESTAMPTZ,
  availability_note TEXT NOT NULL DEFAULT '' CHECK (char_length(availability_note) <= 200),
  max_redemptions  INTEGER CHECK (max_redemptions IS NULL OR max_redemptions >= 1),
  per_card_limit   INTEGER CHECK (per_card_limit IS NULL OR per_card_limit >= 1),
  redeemed_count   INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  updated_by       INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ,
  CONSTRAINT pioneer_rewards_window CHECK (available_from IS NULL OR available_until IS NULL OR available_from < available_until),
  CONSTRAINT pioneer_rewards_quota CHECK (max_redemptions IS NULL OR redeemed_count <= max_redemptions)
);
CREATE INDEX idx_pioneer_rewards_status ON pioneer_rewards (status, sort_order);

CREATE TABLE pioneer_transfers (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference         TEXT NOT NULL,                                -- public reference, e.g. TR-7K4P2Q9M
  sender_card_id    INTEGER NOT NULL REFERENCES pioneer_cards(id),
  recipient_card_id INTEGER NOT NULL REFERENCES pioneer_cards(id),
  amount            INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000000),
  idempotency_hash  TEXT NOT NULL,                                -- sha256 of the client's Idempotency-Key
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pioneer_transfers_reference_key UNIQUE (reference),
  CONSTRAINT pioneer_transfers_idem_key UNIQUE (sender_card_id, idempotency_hash),
  CONSTRAINT pioneer_transfers_not_self CHECK (sender_card_id <> recipient_card_id)
);
CREATE INDEX idx_pioneer_transfers_recipient ON pioneer_transfers (recipient_card_id);

CREATE TABLE pioneer_redemptions (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference        TEXT NOT NULL,                                 -- shown to the cardholder and verified by staff, e.g. RD-7K4P2Q9M
  card_id          INTEGER NOT NULL REFERENCES pioneer_cards(id),
  reward_id        INTEGER NOT NULL REFERENCES pioneer_rewards(id),
  points           INTEGER NOT NULL CHECK (points >= 1),
  reward_title     TEXT NOT NULL,                                 -- snapshot at redemption time
  reward_benefit   TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','cancelled')),
  idempotency_hash TEXT NOT NULL,
  admin_note       TEXT NOT NULL DEFAULT '' CHECK (char_length(admin_note) <= 500),
  handled_by       INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  handled_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pioneer_redemptions_reference_key UNIQUE (reference),
  CONSTRAINT pioneer_redemptions_idem_key UNIQUE (card_id, idempotency_hash)
);
CREATE INDEX idx_pioneer_redemptions_reward ON pioneer_redemptions (reward_id);
CREATE INDEX idx_pioneer_redemptions_status ON pioneer_redemptions (status, created_at);

-- The ledger. Every balance change is one row here; rows can never be updated or deleted.
CREATE TABLE pioneer_transactions (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id              INTEGER NOT NULL REFERENCES pioneer_cards(id),
  type                 TEXT NOT NULL CHECK (type IN ('initial_bonus','transfer_out','transfer_in','redemption','redemption_refund','admin_credit','admin_debit')),
  amount               INTEGER NOT NULL CHECK (amount <> 0 AND amount BETWEEN -1000000 AND 1000000),
  balance_after        INTEGER NOT NULL CHECK (balance_after >= 0), -- filled in by the trigger
  description          TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  transfer_id          INTEGER REFERENCES pioneer_transfers(id),
  redemption_id        INTEGER REFERENCES pioneer_redemptions(id),
  counterparty_card_id INTEGER REFERENCES pioneer_cards(id),
  admin_id             INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pioneer_tx_sign CHECK (
    (type IN ('initial_bonus','transfer_in','redemption_refund','admin_credit') AND amount > 0) OR
    (type IN ('transfer_out','redemption','admin_debit') AND amount < 0)),
  CONSTRAINT pioneer_tx_links CHECK (
    (type IN ('transfer_out','transfer_in') AND transfer_id IS NOT NULL AND counterparty_card_id IS NOT NULL) OR
    (type IN ('redemption','redemption_refund') AND redemption_id IS NOT NULL) OR
    (type IN ('admin_credit','admin_debit') AND char_length(description) > 0) OR
    type = 'initial_bonus')
);
CREATE INDEX idx_pioneer_tx_card ON pioneer_transactions (card_id, id);
CREATE INDEX idx_pioneer_tx_type ON pioneer_transactions (type, id);
CREATE UNIQUE INDEX pioneer_tx_one_initial_bonus ON pioneer_transactions (card_id) WHERE type = 'initial_bonus';
CREATE UNIQUE INDEX pioneer_tx_one_side_per_transfer ON pioneer_transactions (transfer_id, type) WHERE transfer_id IS NOT NULL;
CREATE UNIQUE INDEX pioneer_tx_one_per_redemption ON pioneer_transactions (redemption_id, type) WHERE redemption_id IS NOT NULL;

-- Applies a ledger row to the card balance (row-locks the card; the CHECK rejects negative balances).
CREATE OR REPLACE FUNCTION pioneer_apply_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE nb INTEGER;
BEGIN
  UPDATE pioneer_cards SET balance = balance + NEW.amount, updated_at = now() WHERE id = NEW.card_id RETURNING balance INTO nb;
  IF NOT FOUND THEN RAISE EXCEPTION 'pioneer card % not found', NEW.card_id USING ERRCODE = '23503'; END IF;
  NEW.balance_after := nb;
  RETURN NEW;
END $$;
CREATE TRIGGER pioneer_transactions_apply BEFORE INSERT ON pioneer_transactions FOR EACH ROW EXECUTE FUNCTION pioneer_apply_transaction();

CREATE OR REPLACE FUNCTION pioneer_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pioneer_transactions is append-only' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER pioneer_transactions_immutable BEFORE UPDATE OR DELETE ON pioneer_transactions FOR EACH ROW EXECUTE FUNCTION pioneer_ledger_immutable();

-- Balances can only change through the ledger trigger above (trigger depth 2), never by a direct UPDATE/INSERT.
CREATE OR REPLACE FUNCTION pioneer_cards_guard_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance <> 0 THEN RAISE EXCEPTION 'new cards start at 0; credit points through pioneer_transactions' USING ERRCODE = '42501'; END IF;
  ELSIF NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'balance can only change through pioneer_transactions' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pioneer_cards_balance_guard BEFORE INSERT OR UPDATE ON pioneer_cards FOR EACH ROW EXECUTE FUNCTION pioneer_cards_guard_balance();

CREATE TABLE pioneer_announcements (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  body       TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX idx_pioneer_announcements_status ON pioneer_announcements (status, created_at);

-- Administrative audit trail (never contains CVVs or CVV hashes).
CREATE TABLE pioneer_audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id   INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  admin_name TEXT NOT NULL,                                       -- snapshot, survives admin deletion
  action     TEXT NOT NULL,
  card_id    INTEGER REFERENCES pioneer_cards(id),
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pioneer_audit_created ON pioneer_audit_log (created_at);
CREATE INDEX idx_pioneer_audit_card ON pioneer_audit_log (card_id);
