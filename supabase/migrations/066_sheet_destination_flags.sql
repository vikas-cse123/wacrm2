-- 066_sheet_destination_flags.sql — Independent Dedicated + Master destinations
--
-- Corrects 065's mutually-exclusive `*_sheet_mode` model: Dedicated and
-- Master are INDEPENDENT destinations. Each flow × kind supports four
-- states: none / dedicated only / master only / both.
--
--   1. flows — four boolean flags replacing completed_sheet_mode /
--      incomplete_sheet_mode. Backfilled 1:1 from the old modes
--      (mode='dedicated' → dedicated only; mode='master' → master only),
--      so every existing flow behaves exactly as before. New flows default
--      to Dedicated ON, Master OFF. The old mode columns are dropped —
--      there must never be two sources of truth for this.
--   2. flow_run_sheet_destinations — one row per (flow_run_id, kind,
--      destination) instead of one row per (flow_run_id, kind). A run may
--      snapshot BOTH destinations; each row is still immutable after
--      insert (first insert wins; conflicts re-read — see
--      getOrCreateRunSheetDestination). Existing rows map 1:1
--      (mode → destination), so uniqueness is preserved.
--   3. flow_runs.incomplete_master_synced_at — destination-aware watermark
--      for the Master incomplete sweep. The existing incomplete_synced_at
--      keeps its exact Dedicated meaning. Backfilled from
--      incomplete_synced_at for runs whose Master row exists (under 065 a
--      set watermark on a Master-snapshotted run means the Master append
--      landed), so enabling both destinations later can never re-sync
--      (duplicate) those rows.
--
-- Idempotent — safe to run multiple times. Schema-only: no Google Sheets
-- are modified, no rows rewritten, no data migrated.

-- ============================================================
-- 1. Per-flow, per-kind independent destination flags
-- ============================================================
ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS completed_dedicated_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS completed_master_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS incomplete_dedicated_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS incomplete_master_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill from the 065 single-mode columns when they exist (fresh DBs
-- that never ran 065 skip this: defaults already encode dedicated-only).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flows'
      AND column_name = 'completed_sheet_mode'
  ) THEN
    UPDATE flows
    SET completed_dedicated_enabled = (completed_sheet_mode = 'dedicated'),
        completed_master_enabled = (completed_sheet_mode = 'master');
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flows'
      AND column_name = 'incomplete_sheet_mode'
  ) THEN
    UPDATE flows
    SET incomplete_dedicated_enabled = (incomplete_sheet_mode = 'dedicated'),
        incomplete_master_enabled = (incomplete_sheet_mode = 'master');
  END IF;
END $$;

-- Single source of truth from here on: the old exclusive mode is gone.
ALTER TABLE flows DROP COLUMN IF EXISTS completed_sheet_mode;
ALTER TABLE flows DROP COLUMN IF EXISTS incomplete_sheet_mode;

-- ============================================================
-- 2. Snapshots keyed by (run, kind, destination)
-- ============================================================
ALTER TABLE flow_run_sheet_destinations
  ADD COLUMN IF NOT EXISTS destination TEXT;

-- Pre-existing rows carry the 065 `mode` value 1:1 into `destination`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flow_run_sheet_destinations'
      AND column_name = 'mode'
  ) THEN
    UPDATE flow_run_sheet_destinations
    SET destination = mode
    WHERE destination IS NULL;
  END IF;
END $$;

ALTER TABLE flow_run_sheet_destinations
  ALTER COLUMN destination SET NOT NULL;

ALTER TABLE flow_run_sheet_destinations
  DROP CONSTRAINT IF EXISTS flow_run_sheet_destinations_destination_check;

ALTER TABLE flow_run_sheet_destinations
  ADD CONSTRAINT flow_run_sheet_destinations_destination_check
  CHECK (destination IN ('dedicated', 'master'));

-- Replace the (flow_run_id, kind) primary key with
-- (flow_run_id, kind, destination). Safe: every pre-existing row maps
-- 1:1 from the old key (old rows are unique on (flow_run_id, kind) and
-- each carries exactly one destination), so the new key stays unique.
ALTER TABLE flow_run_sheet_destinations
  DROP CONSTRAINT IF EXISTS flow_run_sheet_destinations_pkey;

ALTER TABLE flow_run_sheet_destinations
  ADD PRIMARY KEY (flow_run_id, kind, destination);

-- `destination` is now authoritative; the 065 `mode` column (and its
-- auto-named CHECK, which drops with it) must not linger as a second
-- source of truth.
ALTER TABLE flow_run_sheet_destinations
  DROP COLUMN IF EXISTS mode;

-- ============================================================
-- 3. Destination-aware incomplete watermark for Master
-- ============================================================
-- The existing incomplete_synced_at keeps its exact Dedicated meaning.
-- Master gets its own watermark so one destination's success can never
-- suppress the other's retry.
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS incomplete_master_synced_at TIMESTAMPTZ;

-- Backfill: under 065 the watermark was shared, so a set watermark on a
-- Master-snapshotted run means its Master append already landed. Runs
-- with no Master row, or an unset watermark, are untouched (NULL stays
-- NULL → legitimately unsynced).
UPDATE flow_runs r
SET incomplete_master_synced_at = r.incomplete_synced_at
WHERE r.incomplete_synced_at IS NOT NULL
  AND r.incomplete_master_synced_at IS NULL
  AND EXISTS (
    SELECT 1 FROM flow_run_sheet_destinations d
    WHERE d.flow_run_id = r.id
      AND d.kind = 'incomplete'
      AND d.destination = 'master'
  );

-- Master sweep hot path (mirrors idx_flow_runs_incomplete_unsynced for
-- the Dedicated watermark).
CREATE INDEX IF NOT EXISTS idx_flow_runs_incomplete_master_unsynced
  ON flow_runs(flow_id, started_at)
  WHERE incomplete_master_synced_at IS NULL
    AND status NOT IN ('active', 'completed');
