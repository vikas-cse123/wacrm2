-- 072_dedicated_incomplete_sync_locks.sql — Durable lease lock for Dedicated Incomplete sync
--
-- Fix for duplicate Incomplete rows when two workers concurrently read the same
-- Flow Run as unsynced (incomplete_synced_at IS NULL) before either updates it,
-- then both call Google Sheets append.
--
-- Lock key is flow_id (PRIMARY KEY of flow_incomplete_sheet_configs), which
-- uniquely identifies the Dedicated Incomplete destination (one sheet per flow).
-- Verified via 042_incomplete_flow_sheets.sql: flow_id PRIMARY KEY.
--
-- Lease lock (not transaction advisory) so it survives the external Google
-- Sheets HTTP request. Only one worker owns a lock at a time; expired locks
-- can be stolen. Release only by owner token prevents one worker releasing
-- another's lease.
--
-- Service-role only, like flow_advance_locks (064) and automation locks.
-- Idempotent.

CREATE TABLE IF NOT EXISTS dedicated_incomplete_sync_locks (
  flow_id UUID PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  locked_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dedicated_incomplete_sync_locks_expires
  ON dedicated_incomplete_sync_locks(expires_at);

ALTER TABLE dedicated_incomplete_sync_locks ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only
