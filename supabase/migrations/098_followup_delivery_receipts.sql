-- ============================================================
-- 098_followup_delivery_receipts.sql — delivery timestamps for
-- WhatsApp reminders.
--
-- The scheduler marks a reminder `sent` when Meta ACCEPTS the
-- message (HTTP 2xx + wamid). Meta's later delivery callbacks
-- (`delivered` / `read` / `failed`) previously landed nowhere
-- for reminders — the webhook only mirrors `messages` and
-- `broadcast_recipients` — so a row could sit on `sent` forever
-- even after Meta reported failure. These two nullable
-- timestamps close that blind spot; the `failed` path reuses the
-- existing `failed_at` / `failure_reason` columns (nothing
-- duplicated).
--
-- No data migration: existing rows keep NULL receipts (unknown,
-- displayed as plain Sent). New writes/updates flow through the
-- webhook reconciliation keyed by `whatsapp_message_id`.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_followups
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
