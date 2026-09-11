-- 068_correct_all_sheets_collections.sql — All Sheets collection/tab model
--
-- CORRECTS 067 (which modeled one spreadsheet per flow — wrong).
-- The product model is: exactly ONE spreadsheet per (account, kind), with
-- one worksheet/tab per flow inside it. Total = 2 All Sheets spreadsheets
-- per account (completed + incomplete).
--
-- PRECONDITIONS (verified by the operator before running):
--   SELECT count(*) FROM all_sheet_links;          -- expect 3 test rows
--   SELECT count(*) FROM all_sheet_run_state;      -- expect 0
--   SELECT count(*) FROM all_sheet_sync_failures;  -- expect 0
-- The 067 rows are empty test artifacts pointing at empty test
-- spreadsheets; no All Sheets data needs migrating. If any count is
-- non-zero beyond the known test rows, STOP and re-plan instead of
-- running the DROP section below.
--
-- WHAT THIS DOES:
--   1. Creates the corrected tables:
--        all_sheet_collections  — one row per (account_id, kind), owns the
--                                  ONE spreadsheet for that kind.
--        all_sheet_flow_tabs    — one row per (collection_id, flow_id),
--                                  one worksheet/tab per flow.
--        all_sheet_tab_run_state      — per-tab/per-run watermark, fully
--                                  independent of flow_runs.incomplete_synced_at.
--        all_sheet_tab_sync_failures  — independent failure log.
--   2. Only afterwards, drops the obsolete 067 tables:
--        all_sheet_run_state, all_sheet_sync_failures, all_sheet_links.
--
-- WHAT THIS DOES NOT DO (guaranteed):
--   - No CREATE/ALTER/DROP/UPDATE on any existing Google Sheets table
--     (flow_sheet_configs, flow_incomplete_sheet_configs,
--      google_sheets_sync_failures).
--   - No ALTER on flow_runs, flows, contacts, or any other table.
--   - No modification of migrations 038/039/040/042/063/065/066/067.
--
-- Idempotent — safe to run multiple times (but run it ONCE per database).

-- ============================================================
-- 1. All Sheets collections (one spreadsheet per account × kind)
-- ============================================================
CREATE TABLE IF NOT EXISTS all_sheet_collections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('completed', 'incomplete')),
  -- The ONE Google spreadsheet for this (account, kind). A flow must never
  -- cause a second collection spreadsheet to be created.
  spreadsheet_id   TEXT NOT NULL,
  spreadsheet_url  TEXT,
  spreadsheet_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enforces: at most one completed + one incomplete collection per account.
  UNIQUE (account_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_all_sheet_collections_account
  ON all_sheet_collections(account_id);

ALTER TABLE all_sheet_collections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account all sheet collections" ON all_sheet_collections;
CREATE POLICY "Members can read own account all sheet collections"
  ON all_sheet_collections FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Admins can manage own account all sheet collections" ON all_sheet_collections;
CREATE POLICY "Admins can manage own account all sheet collections"
  ON all_sheet_collections FOR ALL
  USING (account_id IN (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

-- ============================================================
-- 2. All Sheets flow tabs (one worksheet per flow in a collection)
-- ============================================================
CREATE TABLE IF NOT EXISTS all_sheet_flow_tabs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id    UUID NOT NULL REFERENCES all_sheet_collections(id) ON DELETE CASCADE,
  flow_id          UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Stable Google worksheet identity (numeric sheetId). Titles are display
  -- metadata only and must NEVER be used as identity: flow names can be
  -- renamed and can contain spaces, plus signs, unicode, punctuation.
  worksheet_id     BIGINT NOT NULL,
  worksheet_title  TEXT NOT NULL,
  -- Independent per-tab header state. Same self-healing contract as the
  -- corrected model requires: stored positions frozen, new keys appended.
  answer_columns   TEXT[] NOT NULL DEFAULT '{}',
  answer_headers   TEXT[] NOT NULL DEFAULT '{}',
  header_written   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Completed tabs use 3; incomplete tabs use 6 (mirrors the approved
  -- completed/incomplete layout versions).
  schema_version   INT NOT NULL DEFAULT 3,
  name_column_key    TEXT,
  name_column_header TEXT,
  -- Creation-order slot for predictable tab ordering in the UI.
  display_order    INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One tab per flow inside each collection.
  UNIQUE (collection_id, flow_id)
);

CREATE INDEX IF NOT EXISTS idx_all_sheet_flow_tabs_collection
  ON all_sheet_flow_tabs(collection_id);

CREATE INDEX IF NOT EXISTS idx_all_sheet_flow_tabs_flow
  ON all_sheet_flow_tabs(flow_id);

ALTER TABLE all_sheet_flow_tabs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account all sheet flow tabs" ON all_sheet_flow_tabs;
CREATE POLICY "Members can read own account all sheet flow tabs"
  ON all_sheet_flow_tabs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM all_sheet_collections c
    WHERE c.id = all_sheet_flow_tabs.collection_id
      AND c.account_id IN (
        SELECT account_id FROM profiles WHERE user_id = auth.uid()
      )
  ));

DROP POLICY IF EXISTS "Admins can manage own account all sheet flow tabs" ON all_sheet_flow_tabs;
CREATE POLICY "Admins can manage own account all sheet flow tabs"
  ON all_sheet_flow_tabs FOR ALL
  USING (EXISTS (
    SELECT 1 FROM all_sheet_collections c
    WHERE c.id = all_sheet_flow_tabs.collection_id
      AND c.account_id IN (
        SELECT account_id FROM profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ));

-- ============================================================
-- 3. All Sheets tab run state (own watermark — never
--    flow_runs.incomplete_synced_at)
-- ============================================================
CREATE TABLE IF NOT EXISTS all_sheet_tab_run_state (
  tab_id      UUID NOT NULL REFERENCES all_sheet_flow_tabs(id) ON DELETE CASCADE,
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tab_id, flow_run_id)
);

CREATE INDEX IF NOT EXISTS idx_all_sheet_tab_run_state_tab
  ON all_sheet_tab_run_state(tab_id);

CREATE INDEX IF NOT EXISTS idx_all_sheet_tab_run_state_run
  ON all_sheet_tab_run_state(flow_run_id);

ALTER TABLE all_sheet_tab_run_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account all sheet tab run state" ON all_sheet_tab_run_state;
CREATE POLICY "Members can read own account all sheet tab run state"
  ON all_sheet_tab_run_state FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM all_sheet_flow_tabs t
    JOIN all_sheet_collections c ON c.id = t.collection_id
    WHERE t.id = all_sheet_tab_run_state.tab_id
      AND c.account_id IN (
        SELECT account_id FROM profiles WHERE user_id = auth.uid()
      )
  ));

DROP POLICY IF EXISTS "Admins can manage own account all sheet tab run state" ON all_sheet_tab_run_state;
CREATE POLICY "Admins can manage own account all sheet tab run state"
  ON all_sheet_tab_run_state FOR ALL
  USING (EXISTS (
    SELECT 1 FROM all_sheet_flow_tabs t
    JOIN all_sheet_collections c ON c.id = t.collection_id
    WHERE t.id = all_sheet_tab_run_state.tab_id
      AND c.account_id IN (
        SELECT account_id FROM profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ));

-- ============================================================
-- 4. All Sheets tab sync failures (isolated log — never
--    google_sheets_sync_failures)
-- ============================================================
CREATE TABLE IF NOT EXISTS all_sheet_tab_sync_failures (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tab_id      UUID REFERENCES all_sheet_flow_tabs(id) ON DELETE SET NULL,
  flow_id     UUID REFERENCES flows(id) ON DELETE SET NULL,
  flow_run_id UUID,
  contact_id  UUID,
  payload     JSONB NOT NULL,
  error       TEXT,
  retried     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_all_sheet_tab_sync_failures_account
  ON all_sheet_tab_sync_failures(account_id, retried);

ALTER TABLE all_sheet_tab_sync_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account all sheet tab failures" ON all_sheet_tab_sync_failures;
CREATE POLICY "Members can read own account all sheet tab failures"
  ON all_sheet_tab_sync_failures FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

-- ============================================================
-- 5. Remove the obsolete 067 tables (wrong one-spreadsheet-per-flow
--    model). Run ONLY after verifying the preconditions above: these
--    tables hold nothing but empty test artifacts. Children first.
-- ============================================================
DROP TABLE IF EXISTS all_sheet_run_state;
DROP TABLE IF EXISTS all_sheet_sync_failures;
DROP TABLE IF EXISTS all_sheet_links;
