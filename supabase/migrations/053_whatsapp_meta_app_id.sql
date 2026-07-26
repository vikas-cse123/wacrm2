-- ============================================================
-- Per-account Meta App ID.
--
-- Multi-tenant: different clients connect their own Meta app, so the
-- App ID can't live in a single global env var (META_APP_ID). Store it
-- per account alongside the rest of the WhatsApp credentials. Used by the
-- Resumable Upload API when submitting image-header message templates.
--
-- Not a secret (App ID is public-facing), so stored in plain text — no
-- encryption like access_token / app_secret.
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS meta_app_id TEXT;
