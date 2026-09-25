-- ============================================================
-- 099_reminder_fallback_template.sql — account-level fallback
-- template for WhatsApp reminders sent outside the 24-hour
-- customer-service window.
--
-- Two nullable columns on the tenant root (NULL = no fallback
-- configured; the scheduler then fails closed with a clear
-- reason instead of guessing). The existing accounts RLS
-- (members read, admins+ update) covers both columns with no
-- policy change; the reminder-template API enforces admin+
-- writes and validates the referenced row is APPROVED.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS reminder_template_name TEXT,
  ADD COLUMN IF NOT EXISTS reminder_template_language TEXT;
