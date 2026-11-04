-- External integration API (server/integration.js), e.g. the Christmas Store backend.
-- Purely additive: three new tables; no existing table, column, constraint or row is changed.

-- One row per integrating system. Only a SHA-256 of the API key is stored; the key itself is shown once at creation.
CREATE TABLE integration_clients (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,48}$'),       -- e.g. christmas-store
  key_prefix   TEXT NOT NULL,                                                  -- first characters of the key, for identifying it in logs/CLI
  key_hash     TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes       TEXT[] NOT NULL CHECK (scopes <@ ARRAY['cards:verify','cards:link','cards:read','rewards:read']::text[]),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  CONSTRAINT integration_clients_key_hash_key UNIQUE (key_hash),
  CONSTRAINT integration_clients_key_prefix_key UNIQUE (key_prefix)
);
CREATE UNIQUE INDEX integration_clients_one_active_name ON integration_clients (name) WHERE status = 'active';

-- A Pioneer Card linked to a customer account in an external system. Rows are never deleted: unlinking only
-- sets status = 'unlinked', so the history stays. A card can be actively linked to ONE external account in total
-- (across all clients), and an external customer to one card per client.
CREATE TABLE pioneer_card_links (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id            INTEGER NOT NULL REFERENCES integration_clients(id),
  card_id              INTEGER NOT NULL REFERENCES pioneer_cards(id),
  external_customer_id TEXT NOT NULL CHECK (external_customer_id ~ '^[A-Za-z0-9._:@-]{1,128}$'),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unlinked')),
  linked_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  unlinked_at          TIMESTAMPTZ,
  unlinked_by          TEXT CHECK (unlinked_by IS NULL OR unlinked_by IN ('client','admin')),
  CONSTRAINT pioneer_card_links_unlinked CHECK ((status = 'unlinked') = (unlinked_at IS NOT NULL))
);
CREATE UNIQUE INDEX pioneer_card_links_one_per_card ON pioneer_card_links (card_id) WHERE status = 'active';
CREATE UNIQUE INDEX pioneer_card_links_one_per_customer ON pioneer_card_links (client_id, external_customer_id) WHERE status = 'active';
CREATE INDEX idx_pioneer_card_links_client ON pioneer_card_links (client_id, status);

-- One row per integration request: which client, which route pattern, the result. Never contains API keys,
-- card numbers, CVVs or request bodies.
CREATE TABLE integration_request_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id   INTEGER REFERENCES integration_clients(id),                    -- NULL when the key was missing/invalid
  method      TEXT NOT NULL,
  route       TEXT NOT NULL,                                                 -- pattern, e.g. /api/integration/v1/customers/:customerId/card
  status      INTEGER NOT NULL,
  error_code  TEXT,
  ip          TEXT,
  duration_ms INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_integration_request_log_created ON integration_request_log (created_at);
CREATE INDEX idx_integration_request_log_client ON integration_request_log (client_id, created_at);
