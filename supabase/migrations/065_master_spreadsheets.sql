-- 065_master_spreadsheets.sql — Optional "Master Spreadsheet" Google Sheets mode
--
-- Adds an ADDITIVE, opt-in destination mode alongside the existing Dedicated
-- mode. Nothing here migrates, rewrites, or touches existing Dedicated rows:
--
--   1. account_sheet_collections — one Master spreadsheet per account per
--      kind ('completed' | 'incomplete'). V1 uniqueness is
--      UNIQUE(account_id, kind).
--   2. shared_flow_tabs — one worksheet-tab binding per (flow_id, kind)
--      inside the account's Master spreadsheet. Each tab owns INDEPENDENT
--      header/schema state (answer_columns, answer_headers, header_written,
--      schema_version, name_column_*) so Flow A healing can never shift
--      Flow B's tab. Worksheet identity is the stable Google worksheet_id
--      (numeric sheetId); worksheet_title is display metadata only.
--   3. flow_run_sheet_destinations — IMMUTABLE per-run destination snapshot,
--      written at run start. Sync/retry/cleanup MUST use the snapshot, never
--      the live flow configuration, so switching a flow Dedicated<->Master
--      mid-run cannot misroute in-flight runs. First insert wins; unique
--      conflicts re-read (see getOrCreateRunSheetDestination).
--   4. google_sheets_sync_failures — ADDITIVE nullable columns for durable
--      Master retry state (attempts, next_retry_at, last_error, claimed_at,
--      sync_id, collection_id, worksheet_id). Existing Dedicated rows and
--      the {headers, values, spreadsheet_id, sheet_tab} payload contract
--      are unchanged.
--   5. flows.completed_sheet_mode / flows.incomplete_sheet_mode — per-flow,
--      per-kind mode switch, DEFAULT 'dedicated'. Dedicated remains the
--      default for new flows. Presence of a shared_flow_tabs row alone does
--      NOT imply Master mode (rows are kept frozen when switching back).
--   6. master_sheet_tab_locks — durable per-tab mutex for serializing
--      header-healing + column-insert + append sequences on the SAME
--      worksheet. Key is (account_id, spreadsheet_id, worksheet_id); the PK
--      makes INSERT the atomic acquire (mirrors flow_advance_locks).
--      Different tabs never contend.
--
-- Idempotent — safe to run multiple times. Schema-only: no Google Sheets
-- are modified, no rows rewritten, no data migrated.

-- ============================================================
-- 1. Account-level Master spreadsheet collections
-- ============================================================
CREATE TABLE IF NOT EXISTS account_sheet_collections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('completed', 'incomplete')),
  spreadsheet_id   TEXT NOT NULL,
  spreadsheet_url  TEXT,
  spreadsheet_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- V1: exactly one Completed Master + one Incomplete Master per account.
  UNIQUE (account_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_account_sheet_collections_account
  ON account_sheet_collections(account_id);

ALTER TABLE account_sheet_collections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account sheet collections" ON account_sheet_collections;
CREATE POLICY "Members can read own account sheet collections"
  ON account_sheet_collections FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Admins can manage own account sheet collections" ON account_sheet_collections;
CREATE POLICY "Admins can manage own account sheet collections"
  ON account_sheet_collections FOR ALL
  USING (account_id IN (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

-- ============================================================
-- 2. Per-flow worksheet-tab bindings inside a Master spreadsheet
-- ============================================================
CREATE TABLE IF NOT EXISTS shared_flow_tabs (
  flow_id            UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('completed', 'incomplete')),
  collection_id      UUID NOT NULL REFERENCES account_sheet_collections(id) ON DELETE RESTRICT,
  -- Stable Google worksheet (sheetId). NULL only before the first
  -- successful tab resolution; afterwards always set. Title is display
  -- metadata — NEVER identity (see master-tabs.ts).
  worksheet_id       BIGINT,
  worksheet_title    TEXT NOT NULL,
  -- Creation-order slot for predictable tab ordering. Google tab position
  -- is never treated as identity.
  display_order      INT NOT NULL DEFAULT 0,
  -- Independent per-tab header state. Same self-healing contract as the
  -- Dedicated tables: stored positions frozen, new keys appended.
  answer_columns     TEXT[] NOT NULL DEFAULT '{}',
  answer_headers     TEXT[] NOT NULL DEFAULT '{}',
  header_written     BOOLEAN NOT NULL DEFAULT FALSE,
  -- Completed Master tabs use MASTER_COMPLETED_SCHEMA_VERSION (4);
  -- Incomplete Master tabs use the approved V6 semantics (6). Existing
  -- Dedicated V1/V2/V3/V5 layouts are never stored here.
  schema_version     INT NOT NULL,
  name_column_key    TEXT,
  name_column_header TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_shared_flow_tabs_collection
  ON shared_flow_tabs(collection_id);

ALTER TABLE shared_flow_tabs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account shared flow tabs" ON shared_flow_tabs;
CREATE POLICY "Members can read own account shared flow tabs"
  ON shared_flow_tabs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM account_sheet_collections c
    WHERE c.id = shared_flow_tabs.collection_id
      AND c.account_id IN (
        SELECT account_id FROM profiles WHERE user_id = auth.uid()
      )
  ));

DROP POLICY IF EXISTS "Admins can manage own account shared flow tabs" ON shared_flow_tabs;
CREATE POLICY "Admins can manage own account shared flow tabs"
  ON shared_flow_tabs FOR ALL
  USING (EXISTS (
    SELECT 1 FROM account_sheet_collections c
    WHERE c.id = shared_flow_tabs.collection_id
      AND c.account_id IN (
        SELECT account_id FROM profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ));

-- ============================================================
-- 3. Immutable per-run destination snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_run_sheet_destinations (
  flow_run_id     UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('completed', 'incomplete')),
  mode            TEXT NOT NULL CHECK (mode IN ('dedicated', 'master')),
  collection_id   UUID REFERENCES account_sheet_collections(id) ON DELETE SET NULL,
  spreadsheet_id  TEXT NOT NULL,
  worksheet_id    BIGINT,
  worksheet_title TEXT NOT NULL,
  schema_version  INT NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_run_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_flow_run_sheet_destinations_run
  ON flow_run_sheet_destinations(flow_run_id);

ALTER TABLE flow_run_sheet_destinations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account run destinations" ON flow_run_sheet_destinations;
CREATE POLICY "Members can read own account run destinations"
  ON flow_run_sheet_destinations FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM flow_runs r
    WHERE r.id = flow_run_sheet_destinations.flow_run_id
      AND r.account_id IN (
        SELECT account_id FROM profiles WHERE user_id = auth.uid()
      )
  ));

-- Writes go through the service-role engine/cron only (mirrors flow_runs:
-- no user-facing INSERT/UPDATE/DELETE policies, SELECT for visibility).

-- ============================================================
-- 4. Durable Master retry state on google_sheets_sync_failures (additive)
-- ============================================================
ALTER TABLE google_sheets_sync_failures
  ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES account_sheet_collections(id) ON DELETE SET NULL;

ALTER TABLE google_sheets_sync_failures
  ADD COLUMN IF NOT EXISTS worksheet_id BIGINT;

ALTER TABLE google_sheets_sync_failures
  ADD COLUMN IF NOT EXISTS mode TEXT CHECK (mode IN ('dedicated', 'master'));

ALTER TABLE google_sheets_sync_failures
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

ALTER TABLE google_sheets_sync_failures
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE google_sheets_sync_failures
  ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE google_sheets_sync_failures
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Stable per-attempt logical sync id for Master idempotency
-- (Flow Run ID + Sync ID dedup). NULL on all pre-existing Dedicated rows.
ALTER TABLE google_sheets_sync_failures
  ADD COLUMN IF NOT EXISTS sync_id TEXT;

-- Retry worker hot path: due Master retries per account.
CREATE INDEX IF NOT EXISTS idx_sheets_sync_failures_master_retry
  ON google_sheets_sync_failures(account_id, next_retry_at)
  WHERE mode = 'master' AND claimed_at IS NULL;

-- Idempotency lookup: has this logical sync already been recorded?
CREATE INDEX IF NOT EXISTS idx_sheets_sync_failures_sync_id
  ON google_sheets_sync_failures(sync_id)
  WHERE sync_id IS NOT NULL;

-- ============================================================
-- 5. Per-flow, per-kind mode switch (Dedicated default)
-- ============================================================
ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS completed_sheet_mode TEXT NOT NULL DEFAULT 'dedicated'
    CHECK (completed_sheet_mode IN ('dedicated', 'master'));

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS incomplete_sheet_mode TEXT NOT NULL DEFAULT 'dedicated'
    CHECK (incomplete_sheet_mode IN ('dedicated', 'master'));

-- ============================================================
-- 6. Durable per-tab locks for Master header-heal + append sequences
-- ============================================================
CREATE TABLE IF NOT EXISTS master_sheet_tab_locks (
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  worksheet_id   BIGINT NOT NULL,
  owner          TEXT NOT NULL,
  locked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, spreadsheet_id, worksheet_id)
);

ALTER TABLE master_sheet_tab_locks ENABLE ROW LEVEL SECURITY;

-- Service-role only: all access is server-side via the Master sync engine,
-- exactly like flow_advance_locks (no user-facing policies).
