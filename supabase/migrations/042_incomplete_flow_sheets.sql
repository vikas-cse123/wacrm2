-- 042_incomplete_flow_sheets.sql — Live Google Sheet for incomplete flow runs
--
-- Replaces the one-shot "Generate" export on the Data Export page with a
-- persistent, self-updating sheet per flow:
--   1. flow_incomplete_sheet_configs — the spreadsheet each flow's
--      dropped-off (terminal, non-completed) runs are appended to. One
--      row per flow ⇒ one live sheet per flow, mirroring
--      flow_sheet_configs for completed runs.
--   2. flow_runs.incomplete_synced_at — watermark stamped when a run's
--      row lands in the sheet, so the cron sweep only ever appends each
--      run once (idempotent; a missed pass self-heals on the next one).

-- ============================================================
-- 1. Per-flow incomplete-runs spreadsheet link
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_incomplete_sheet_configs (
  flow_id          UUID PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  spreadsheet_id   TEXT NOT NULL,
  spreadsheet_url  TEXT,
  spreadsheet_name TEXT,
  -- Tab (worksheet) name rows are appended to.
  sheet_tab        TEXT NOT NULL DEFAULT 'Sheet1',
  -- Ordered var_keys already present as header columns. New keys found
  -- in later runs are appended at the end (existing positions never
  -- move), same self-healing contract as flow_sheet_configs.
  answer_columns   TEXT[] NOT NULL DEFAULT '{}',
  -- Whether the header row has been written to the sheet yet.
  header_written   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_incomplete_sheet_configs_account
  ON flow_incomplete_sheet_configs(account_id);

ALTER TABLE flow_incomplete_sheet_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read own account incomplete sheet configs"
  ON flow_incomplete_sheet_configs FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Admins can manage own account incomplete sheet configs"
  ON flow_incomplete_sheet_configs FOR ALL
  USING (account_id IN (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

-- ============================================================
-- 2. Sync watermark on flow_runs
-- ============================================================
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS incomplete_synced_at TIMESTAMPTZ;

-- The sweep's hot path: unsynced terminal runs for one flow.
CREATE INDEX IF NOT EXISTS idx_flow_runs_incomplete_unsynced
  ON flow_runs(flow_id, started_at)
  WHERE incomplete_synced_at IS NULL
    AND status NOT IN ('active', 'completed');
