-- Magical: initial PostgreSQL schema (translation of the previous schema; no data is imported).
-- Executed inside a transaction by server/db.js. Timestamps are timestamptz (UTC).
CREATE TABLE events (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT events_slug_key UNIQUE (slug)
);

CREATE TABLE registrations (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id          INTEGER NOT NULL REFERENCES events(id),
  invitation_no     TEXT NOT NULL,                        -- public ticket number, e.g. MGC-7K4P2Q
  access_token_hash TEXT NOT NULL,                        -- sha256 of the secret link token (token itself is never stored)
  idempotency_hash  TEXT,                                 -- sha256 of the client's Idempotency-Key (safe retries)
  dedupe_key        TEXT NOT NULL,                        -- sha256(lower(first|last|phone)) blocks accidental double registration
  first_name        TEXT NOT NULL CHECK (char_length(first_name) BETWEEN 2 AND 200),
  last_name         TEXT NOT NULL CHECK (char_length(last_name)  BETWEEN 2 AND 200),
  age               INTEGER NOT NULL CHECK (age BETWEEN 1 AND 120),
  phone             TEXT NOT NULL CHECK (char_length(phone) BETWEEN 8 AND 20),
  search_text       TEXT NOT NULL,                        -- lower-cased copy (done in the app) for Unicode-aware search
  status            TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','checked_in')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT registrations_invitation_no_key     UNIQUE (invitation_no),
  CONSTRAINT registrations_access_token_hash_key UNIQUE (access_token_hash),
  CONSTRAINT registrations_idempotency_hash_key  UNIQUE (idempotency_hash),
  CONSTRAINT registrations_event_dedupe_key      UNIQUE (event_id, dedupe_key)
);
CREATE INDEX idx_registrations_event_created ON registrations (event_id, created_at);
CREATE INDEX idx_registrations_last_name ON registrations (last_name);

CREATE TABLE contact_messages (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 400),
  email       TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  phone       TEXT NOT NULL DEFAULT '',
  service     TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '' CHECK (char_length(message) <= 12000),
  search_text TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','processed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ
);
CREATE INDEX idx_contact_status_created ON contact_messages (status, created_at);

CREATE TABLE admins (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX admins_username_lower_key ON admins (lower(username));  -- case-insensitive usernames

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,                            -- sha256 of the session cookie value
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sessions_expires ON admin_sessions (expires_at);
CREATE INDEX idx_sessions_admin ON admin_sessions (admin_id);
