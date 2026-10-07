-- ============================================================
-- 112_user_recording_settings.sql — per-user WhatsApp recording
-- source (mutually exclusive).
--
-- One row per (account, user): which WhatsApp app CallVault may
-- record for that user — exactly one of 'none' | 'whatsapp' |
-- 'whatsapp_business'. No independent booleans (two toggles could
-- claim both apps at once); the single value IS the allowlist.
--
-- Absence of a row means 'none' (safe default for new and
-- existing users — recording an app nobody chose must be
-- opt-in, never inherited).
--
-- Ownership: keyed by (account_id, user_id) like every parent
-- table (migration 017). ON DELETE CASCADE on both: a removed
-- account or user takes its setting with it (no orphaned
-- allowlist entries pointing at deleted users).
--
-- RLS: any member may read their account's settings (the Team
-- roster and the owner's editor need them); writes require
-- owner (is_account_member(account_id, 'owner')) — agents and
-- viewers cannot grant themselves recording. The API path uses
-- the service role with a server-side requireRole("owner")
-- check, mirroring POST /api/account/members.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_recording_settings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  whatsapp_recording_source text NOT NULL DEFAULT 'none'
    CHECK (whatsapp_recording_source IN ('none', 'whatsapp', 'whatsapp_business')),
  updated_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_recording_settings_account_user_unique UNIQUE (account_id, user_id)
);

-- Owner editor roster + per-user lookup, newest-first irrelevant
-- (one row per user by constraint).
CREATE INDEX IF NOT EXISTS user_recording_settings_account_idx
  ON user_recording_settings (account_id, user_id);

ALTER TABLE user_recording_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+).
DROP POLICY IF EXISTS user_recording_settings_select ON user_recording_settings;
CREATE POLICY user_recording_settings_select ON user_recording_settings FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: owner only. Agents/viewers cannot
-- grant recording to themselves or anyone else.
DROP POLICY IF EXISTS user_recording_settings_insert ON user_recording_settings;
CREATE POLICY user_recording_settings_insert ON user_recording_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS user_recording_settings_update ON user_recording_settings;
CREATE POLICY user_recording_settings_update ON user_recording_settings FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS user_recording_settings_delete ON user_recording_settings;
CREATE POLICY user_recording_settings_delete ON user_recording_settings FOR DELETE
  USING (is_account_member(account_id, 'owner'));
