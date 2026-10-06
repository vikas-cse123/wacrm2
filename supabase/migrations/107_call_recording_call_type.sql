-- ============================================================
-- 107_call_recording_call_type.sql
--
-- Phase 2B follow-up: classifies a recording by its source —
-- 'phone' (carrier), 'whatsapp', or 'whatsapp_business'.
-- NULL means old/unclassified; NULL is never guessed, inferred,
-- or backfilled. The Calls dashboard counts each value exactly.
--
-- No RLS, bucket, or relationship changes. Idempotent.
-- ============================================================

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS call_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_recordings_call_type_check'
  ) THEN
    ALTER TABLE call_recordings
      ADD CONSTRAINT call_recordings_call_type_check
      CHECK (
        call_type IS NULL
        OR call_type IN ('phone', 'whatsapp', 'whatsapp_business')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS call_recordings_account_call_type_idx
  ON call_recordings (account_id, call_type);
