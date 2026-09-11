-- 067_all_sheets.sql — Independent "All Sheets" feature (isolated from Google Sheets)
--
-- ADDITIVE ONLY. Does not touch existing Google Sheets tables:
--   flow_sheet_configs, flow_incomplete_sheet_configs,
--   google_connections, google_sheets_sync_failures, flow_runs, flows.
-- No ALTER to flow_runs (All Sheets watermark lives in all_sheet_run_state).
--
--   1. all_sheet_links — one row per (flow_id, kind). Own spreadsheet
--      destination + independent header state. Deleting here never
--      touches flow_sheet_configs / flow_incomplete_sheet_configs.
--   2. all_sheet_run_state — own idempotency watermark per link.
--      Replaces flow_runs.incomplete_synced_at for All Sheets so the
--      existing incomplete sweep can never be starved or duplicated.
--   3. all_sheet_sync_failures — durable failed-append log for All Sheets
--      only. Existing google_sheets_sync_failures rows are never read here.
--
-- Idempotent — safe to run multiple times.

-- ============================================================
-- 1. All Sheets links (destinations)
-- ============================================================
CREATE TABLE IF NOT EXISTS all_sheet_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id          UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('completed', 'incomplete')),
  spreadsheet_id   TEXT NOT NULL,
  spreadsheet_url  TEXT,
  spreadsheet_name TEXT,
  sheet_tab        TEXT NOT NULL DEFAULT 'Sheet1',
  answer_columns   TEXT[] NOT NULL DEFAULT '{}',
  answer_headers   TEXT[] NOT NULL DEFAULT '{}',
  header_written   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Completed links use completed schema 3; incomplete links use 6.
  schema_version   INT NOT NULL DEFAULT 3,
  name_column_key    TEXT,
  name_column_header TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flow_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_all_sheet_links_account
  ON all_sheet_links(account_id);

CREATE INDEX IF NOT EXISTS idx_all_sheet_links_flow
  ON all_sheet_links(flow_id);

ALTER TABLE all_sheet_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account all sheet links" ON all_sheet_links;
CREATE POLICY "Members can read own account all sheet links"
  ON all_sheet_links FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Admins can manage own account all sheet links" ON all_sheet_links;
CREATE POLICY "Admins can manage own account all sheet links"
  ON all_sheet_links FOR ALL
  USING (account_id IN (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

-- ============================================================
-- 2. All Sheets run state (own watermark)
-- ============================================================
CREATE TABLE IF NOT EXISTS all_sheet_run_state (
  link_id     UUID NOT NULL REFERENCES all_sheet_links(id) ON DELETE CASCADE,
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, flow_run_id)
);

CREATE INDEX IF NOT EXISTS idx_all_sheet_run_state_link
  ON all_sheet_run_state(link_id);

CREATE INDEX IF NOT EXISTS idx_all_sheet_run_state_run
  ON all_sheet_run_state(flow_run_id);

ALTER TABLE all_sheet_run_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account all sheet run state" ON all_sheet_run_state;
CREATE POLICY "Members can read own account all sheet run state"
  ON all_sheet_run_state FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM all_sheet_links l
    WHERE l.id = all_sheet_run_state.link_id
      AND l.account_id IN (
        SELECT account_id FROM profiles WHERE user_id = auth.uid()
      )
  ));

DROP POLICY IF EXISTS "Admins can manage own account all sheet run state" ON all_sheet_run_state;
CREATE POLICY "Admins can manage own account all sheet run state"
  ON all_sheet_run_state FOR ALL
  USING (EXISTS (
    SELECT 1 FROM all_sheet_links l
    WHERE l.id = all_sheet_run_state.link_id
      AND l.account_id IN (
        SELECT account_id FROM profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ));

-- ============================================================
-- 3. All Sheets sync failures (isolated log)
-- ============================================================
CREATE TABLE IF NOT EXISTS all_sheet_sync_failures (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  link_id     UUID REFERENCES all_sheet_links(id) ON DELETE SET NULL,
  flow_id     UUID REFERENCES flows(id) ON DELETE SET NULL,
  flow_run_id UUID,
  contact_id  UUID,
  payload     JSONB NOT NULL,
  error       TEXT,
  retried     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_all_sheet_sync_failures_account
  ON all_sheet_sync_failures(account_id, retried);

ALTER TABLE all_sheet_sync_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read own account all sheet failures" ON all_sheet_sync_failures;
CREATE POLICY "Members can read own account all sheet failures"
  ON all_sheet_sync_failures FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));
