-- 038_google_sheets_sync.sql — Auto Sync completed flow responses to Google Sheets
--
-- Adds:
--   1. A new 'google_sheets_sync' node type on flow_nodes.
--   2. google_connections — one Google OAuth connection per account
--      (tokens stored encrypted, mirroring whatsapp_config.access_token).
--   3. flow_sheet_configs — the spreadsheet each flow appends rows to,
--      plus the ordered column list and a header-written flag. One row
--      per flow ⇒ one sheet per flow.
--   4. google_sheets_sync_failures — a durable log of failed appends so a
--      Sheets API outage never loses a submission; rows can be retried.

-- ============================================================
-- 1. flow_nodes.node_type — add 'google_sheets_sync'
-- ============================================================
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'google_sheets_sync',
    'end'
  ));

-- ============================================================
-- 2. Account-level Google connection (one per account)
-- ============================================================
CREATE TABLE IF NOT EXISTS google_connections (
  account_id     UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  google_email   TEXT,
  -- Encrypted with lib/whatsapp/encryption (AES-256-GCM), never plaintext.
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  token_expiry   TIMESTAMPTZ NOT NULL,
  scope          TEXT,
  connected_by   UUID REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE google_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read own account google connection"
  ON google_connections FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Admins can manage own account google connection"
  ON google_connections FOR ALL
  USING (account_id IN (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

-- ============================================================
-- 3. Per-flow spreadsheet link (one sheet per flow)
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_sheet_configs (
  flow_id          UUID PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  spreadsheet_id   TEXT NOT NULL,
  spreadsheet_url  TEXT,
  spreadsheet_name TEXT,
  -- Tab (worksheet) name rows are appended to.
  sheet_tab        TEXT NOT NULL DEFAULT 'Sheet1',
  -- Ordered var_keys captured by this flow's collect_input nodes. Standard
  -- columns (Name, Phone, …) are prepended at write time; this array is
  -- just the dynamic answer columns, kept in a stable order.
  answer_columns   TEXT[] NOT NULL DEFAULT '{}',
  -- Whether the header row has been written to the sheet yet.
  header_written   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_sheet_configs_account
  ON flow_sheet_configs(account_id);

ALTER TABLE flow_sheet_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read own account sheet configs"
  ON flow_sheet_configs FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Admins can manage own account sheet configs"
  ON flow_sheet_configs FOR ALL
  USING (account_id IN (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

-- ============================================================
-- 4. Failed-append log (durable, retryable)
-- ============================================================
CREATE TABLE IF NOT EXISTS google_sheets_sync_failures (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id      UUID REFERENCES flows(id) ON DELETE SET NULL,
  flow_run_id  UUID,
  contact_id   UUID,
  -- The row we tried to append (values + headers), kept so it can be
  -- replayed without re-deriving from the run.
  payload      JSONB NOT NULL,
  error        TEXT,
  retried      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_failures_account
  ON google_sheets_sync_failures(account_id, retried);

ALTER TABLE google_sheets_sync_failures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read own account sync failures"
  ON google_sheets_sync_failures FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));
