-- ============================================================
-- 106_call_recording_contact_metadata.sql
--
-- Phase 2B contact association: stores the call's phone number
-- and direction (as sent by CallVault) on `call_recordings`, so
-- the upload endpoint can resolve `contact_id` server-side.
--
-- `phone_number` is the raw trimmed value from the device — the
-- matching EVIDENCE, never normalized in place. Matching compares
-- `normalizePhone(phone_number)` against `contacts.phone_normalized`
-- (the digits-only generated column from migration 022) within
-- the API key's account. `contact_id` stays the canonical
-- association; these columns only explain how it was derived.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Raw device-supplied phone number (evidence for matching).

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS phone_number TEXT;

-- Call direction as sent by CallVault. Nullable: VoIP sends
-- neither field, and pre-2B rows predate both columns.
ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS direction TEXT;

-- 'in' | 'out' | NULL (VoIP path sends neither). Enforced, so no
-- other value can ever land here regardless of caller.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_recordings_direction_check'
  ) THEN
    ALTER TABLE call_recordings
      ADD CONSTRAINT call_recordings_direction_check
      CHECK (direction IN ('in', 'out'));
  END IF;
END $$;

-- Matching lookup: contacts of one account by phone evidence.
CREATE INDEX IF NOT EXISTS call_recordings_account_phone_idx
  ON call_recordings (account_id, phone_number);


