-- ============================================================
-- 113_user_recording_phone_source.sql — per-user phone (SIM)
-- recording source, alongside the WhatsApp source from 112.
--
-- Adds `phone_recording_source` to `user_recording_settings`:
-- exactly one of 'none' | 'sim1' | 'sim2'. The value is
-- intentionally logical (a SIM slot), never an Android
-- subscription id, broadcast value, or runtime slot state —
-- CallVault maps the logical slot to the device's CURRENT
-- active subscription at call time.
--
-- Absence semantics are unchanged: no row, or (defensively) any
-- unexpected value, reads as 'none'. Never default to a SIM.
--
-- No RLS change: the 112 policies already gate reads to members
-- and writes to owners, and they apply to the whole row.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE user_recording_settings
  ADD COLUMN IF NOT EXISTS phone_recording_source text NOT NULL DEFAULT 'none'
    CHECK (phone_recording_source IN ('none', 'sim1', 'sim2'));
