-- ============================================================
-- 079_whatsapp_qr_codes.sql — WACRM metadata for Meta QR codes
--
-- Meta (GET/POST/DELETE /{phone_number_id}/message_qrdls) is the
-- source of truth for the actual QR codes: the code, deep link,
-- and QR image all come from Meta. This table stores only the
-- WACRM organizational metadata needed to list, name, and
-- reconcile them per account:
--
--   - meta_code: the Meta QR code identifier (unique per account).
--   - name: WACRM-local display name (Meta has no name field).
--   - prefilled_message / deep_link_url / qr_image_url: last-known
--     Meta values, refreshed on create/update/sync. The QR image
--     binary is NEVER stored — downloads stream Meta's image.
--
-- Tenant isolation mirrors message_templates (017): any account
-- member may read; only admins may write. No access tokens or
-- secrets are stored here.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_qr_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant key: every query scopes by account, and a deleted
  -- account cascades its QR metadata away.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Meta QR code identifier from message_qrdls. Unique per account
  -- so sync reconciliation is a deterministic upsert target.
  meta_code TEXT NOT NULL,
  -- WACRM-local display name. Meta QR codes have no name field,
  -- so this is what the list UI shows.
  name TEXT NOT NULL,
  prefilled_message TEXT NOT NULL,
  -- Last-known Meta values (refreshed on create/update/sync).
  deep_link_url TEXT,
  qr_image_url TEXT,
  image_format TEXT NOT NULL DEFAULT 'SVG',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_qr_codes_account_code_key
    UNIQUE (account_id, meta_code)
);

-- Hot path: "all QR metadata for this account".
CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_codes_account
  ON whatsapp_qr_codes(account_id);

ALTER TABLE whatsapp_qr_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_qr_codes_select ON whatsapp_qr_codes;
CREATE POLICY whatsapp_qr_codes_select ON whatsapp_qr_codes FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_qr_codes_insert ON whatsapp_qr_codes;
CREATE POLICY whatsapp_qr_codes_insert ON whatsapp_qr_codes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_qr_codes_update ON whatsapp_qr_codes;
CREATE POLICY whatsapp_qr_codes_update ON whatsapp_qr_codes FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_qr_codes_delete ON whatsapp_qr_codes;
CREATE POLICY whatsapp_qr_codes_delete ON whatsapp_qr_codes FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Keep updated_at fresh on writes (same trigger as every table
-- carrying updated_at since 001).
DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_qr_codes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_qr_codes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
