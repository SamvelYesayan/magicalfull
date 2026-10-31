-- Pioneer gift cards for approved redemption requests. Additive only: no row is changed, nothing is dropped
-- except the status CHECK, which is replaced by a wider one in the same statement.
--
-- Status flow (existing meanings are unchanged):
--   pending   -> approved  : admin approves; a gift code is issued once (approved_at / approved_by / gift_code)
--   approved  -> fulfilled : staff hand the gift over («Տրամադրված է»), handled_at / handled_by as before
--   pending|approved -> cancelled : points refunded through the ledger, as before
-- Existing 'fulfilled' rows keep gift_code NULL (they were handed over before gift cards existed).

ALTER TABLE pioneer_redemptions
  DROP CONSTRAINT pioneer_redemptions_status_check,
  ADD CONSTRAINT pioneer_redemptions_status_check CHECK (status IN ('pending','approved','fulfilled','cancelled'));

ALTER TABLE pioneer_redemptions
  ADD COLUMN gift_code   TEXT,
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN approved_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;

-- One code per request, never shared between requests; issued together with the approval time.
ALTER TABLE pioneer_redemptions
  ADD CONSTRAINT pioneer_redemptions_gift_code_key UNIQUE (gift_code),
  ADD CONSTRAINT pioneer_redemptions_gift_code_format CHECK (gift_code IS NULL OR gift_code ~ '^MG-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$'),
  ADD CONSTRAINT pioneer_redemptions_gift_issued CHECK ((gift_code IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT pioneer_redemptions_approved_has_gift CHECK (status <> 'approved' OR gift_code IS NOT NULL);
