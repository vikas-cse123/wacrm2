-- 064_flow_advance_locks.sql
--
-- Per-contact flow-advance mutex for inbound webhook dispatch.
--
-- Problem: two Meta webhook deliveries seconds apart (different Meta
-- message ids: redelivery, double-tap) can both be processed as advances
-- of the same suspended flow run. Meta message-id idempotency cannot
-- catch this (ids differ), and `current_node_key` is only persisted at
-- suspending/end points — so while the first advance is still walking
-- its auto-advance chain (set_tag, sends, sheets sync), the second
-- inbound still sees the old suspended node and advances the run again,
-- executing every side effect twice (notably `set_tag` automation
-- dispatches, which fan out to full duplicate automation executions).
--
-- Fix: serialize dispatch per (account_id, contact_id). The PK makes the
-- INSERT the atomic acquire (23505 = held); holders delete their row on
-- release. Crashed holders are taken over via locked_at age — no stuck
-- locks, no background reaper. Different contacts never contend.
--
-- Service-role only: all access is server-side via the engine, exactly
-- like automation_pending_executions (no user-facing policies).
-- Idempotent — safe to run multiple times. UNAPPLIED: runs at deploy.

CREATE TABLE IF NOT EXISTS flow_advance_locks (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, contact_id)
);

ALTER TABLE flow_advance_locks ENABLE ROW LEVEL SECURITY;
