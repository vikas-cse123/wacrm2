-- ============================================================
-- 060_messages_interactive_buttons.sql
--
-- Stores the buttons OFFERED on an outgoing interactive button
-- message (Send Buttons flow node), so the Inbox can render the
-- prompt's choices on the bot's bubble.
--
-- Shape: [{"id": "<reply_id>", "title": "<label>"}, ...] — exactly
-- the ids/titles (and order) that were sent to Meta. NULL for
-- everything else:
--   - inbound interactive rows (the customer's tapped option lives in
--     content_text / interactive_reply_id — see migration 010),
--   - interactive list prompts (rows/sections are a different shape),
--   - all historical rows (the column is additive and nullable).
--
-- This is presentation metadata only — never read by the flows
-- engine for routing, which continues to use interactive_reply_id.
--
-- Idempotent — safe to run once or repeatedly.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS interactive_buttons JSONB;
