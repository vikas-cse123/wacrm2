-- ============================================================
-- 077_message_media_reference.sql — lightweight media references
--
-- Problem: Flow/Automation bot sends (engineSendMedia) persisted
-- only content_type + caption — no media_url — so the Inbox had
-- nothing to render ("Document unavailable" / "Image unavailable").
-- Manual sends persisted media_url but dropped the filename, and
-- sticker sends failed the INSERT entirely (CHECK lacked 'sticker'
-- although the TS ContentType + send paths already allow it).
--
-- Fix (reference, NOT media): two nullable TEXT columns —
--   - media_file_name: original filename (Meta only knows it
--     transiently at send time; Storage object keys are NOT the
--     original name). Needed for document cards.
--   - media_mime_type: MIME known at webhook-parse/send time.
--     Needed for correct audio/video/proxy Content-Types.
-- Plus 'sticker' in the content_type CHECK so sticker sends insert.
--
-- Deliberately NOT added: media bytes, base64, Meta media IDs for
-- link-based outbound sends (no Meta ID exists by design — sends
-- use `link` to account Storage objects), new tables, backfills,
-- indexes (never filtered on).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_file_name TEXT;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_mime_type TEXT;

-- Widen the CHECK from migration 010 to admit 'sticker'.
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_content_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video', 'sticker',
    'location', 'template', 'interactive'
  ));
