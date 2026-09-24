-- ============================================================
-- 090_profiles_whatsapp_number.sql — agent's own WhatsApp number
--
-- Adds `profiles.whatsapp_number`: the team member's personal
-- WhatsApp number, stored digits-only (E.164 without the leading
-- `+`, see `sanitizePhoneForMeta` in src/lib/whatsapp/phone-utils).
--
-- Purpose: Reminders (whatsapp_followups) are delivered TO the
-- creating agent. At creation the API snapshots this number into
-- `whatsapp_followups.recipient_phone`; the scheduler sends ONLY
-- to that snapshot and never re-reads this column.
--
-- NULL = agent has not set a number yet. Reminder creation fails
-- closed in that case (no fallback to customer, business, or
-- email-derived numbers).
--
-- No RLS change: the existing `profiles_select` (self + account
-- members) and `profiles_update` (own row only) policies already
-- give exactly self-service semantics — an agent edits only their
-- own number, admins cannot write teammates' rows. The member-list
-- API selects explicit columns and does not expose this field.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;

-- Defensive: reject blank strings at the DB boundary so NULL
-- remains the single "not set" state. Normalization (digits-only)
-- happens app-side before write.
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_whatsapp_number_not_blank;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_whatsapp_number_not_blank
  CHECK (whatsapp_number IS NULL OR length(btrim(whatsapp_number)) > 0);
