-- ============================================================
-- 058_add_email_sent_message_id.sql — traceability for sent emails
--
-- Records the provider's message id on the job row when the email is
-- accepted, so operators (and tests) can trace the exact message at the
-- provider (Resend id / SMTP Message-Id) instead of only knowing the
-- job was marked 'sent'.
-- ============================================================

ALTER TABLE flow_email_notifications
  ADD COLUMN IF NOT EXISTS sent_message_id TEXT;