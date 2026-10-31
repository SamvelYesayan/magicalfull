-- Encrypted copy of a card's CVV, so the admin print sheet can put it on the back without retyping it.
-- Additive only: one nullable column, no row is changed.
--
-- Written only when the server itself issues a code (card creation, CVV reset), because that is the only moment
-- the plain code legitimately exists. AES-256-GCM with a key derived from PIONEER_CVV_PEPPER (never stored in the
-- database), authenticated with the card number, so a value cannot be moved to another card. cvv_hash stays the
-- only thing used for login. Cards issued before this migration keep NULL: their CVV exists only as a hash.
ALTER TABLE pioneer_cards ADD COLUMN cvv_enc TEXT;
ALTER TABLE pioneer_cards ADD CONSTRAINT pioneer_cards_cvv_enc_format CHECK (cvv_enc IS NULL OR cvv_enc ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4}$');
