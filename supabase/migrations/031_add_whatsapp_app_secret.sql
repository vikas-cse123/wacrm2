-- Add per-account Meta App Secret for webhook signature verification.
--
-- Prior to this, all accounts shared one META_APP_SECRET env var,
-- which breaks once different clients each have their own Meta App
-- (each Meta App has its own App Secret). This column lets each
-- account's whatsapp_config row store its own, so the webhook route
-- can verify inbound signatures per-account instead of globally.
--
-- Nullable and non-breaking: existing rows with NULL fall back to
-- process.env.META_APP_SECRET at the application layer (see
-- src/app/api/whatsapp/webhook/route.ts, resolveWebhookSecret()).
--
-- NOTE: this column was already applied directly via the Supabase
-- SQL editor on production. This file exists to keep migration
-- history in sync for local dev / fresh environments — it should be
-- a no-op against the current production DB.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS app_secret TEXT;

COMMENT ON COLUMN whatsapp_config.app_secret IS
  'Encrypted Meta App Secret for this account''s WhatsApp App. Used to verify inbound webhook signatures for this account''s phone_number_id. NULL means the webhook route falls back to the global META_APP_SECRET env var (legacy single-tenant behavior).';