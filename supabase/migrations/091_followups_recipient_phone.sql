-- ============================================================
-- 091_followups_recipient_phone.sql — immutable reminder recipient
--
-- Adds `whatsapp_followups.recipient_phone`: the creating agent's
-- own WhatsApp number (digits-only E.164, no leading `+`),
-- snapshotted at creation time from `profiles.whatsapp_number`.
--
-- The scheduler sends ONLY to this snapshot. It never re-reads
-- the agent's profile, never reads `contacts.phone`, never opens
-- a customer conversation, and never applies the 24-hour
-- customer-service window to reminder delivery.
--
-- NULL is permitted for rows created before this migration (legacy
-- customer-facing follow-ups). The scheduler fails such rows loudly
-- instead of guessing a recipient. New rows are required by API
-- validation to carry a number (fail closed when the agent has no
-- stored WhatsApp number), so no backfill is possible or desired —
-- backfilling would mean inventing recipients.
--
-- `contact_id` / `conversation_id` stay as-is (both already
-- nullable): `contact_id` is now optional context only, and new
-- reminder rows store NULL `conversation_id` (no thread is created
-- for a self-reminder).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_followups
  ADD COLUMN IF NOT EXISTS recipient_phone TEXT;

-- Defensive: a present snapshot must be a non-blank string so NULL
-- remains the single "legacy / unset" state.
ALTER TABLE whatsapp_followups
  DROP CONSTRAINT IF EXISTS whatsapp_followups_recipient_not_blank;

ALTER TABLE whatsapp_followups
  ADD CONSTRAINT whatsapp_followups_recipient_not_blank
  CHECK (recipient_phone IS NULL OR length(btrim(recipient_phone)) > 0);
