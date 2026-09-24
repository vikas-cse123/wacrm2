-- ============================================================
-- 097_workspace_column_widths.sql — per-column Workspace table
-- widths (drag-to-resize persistence).
--
-- One row per resized column, keyed by the STABLE visibility id
-- (`core:row`, `flow:<key>`, `custom:<field uuid>`,
-- `lead_source` — the same identity visibility, header colors,
-- and widths share). Only user-set widths persist here; natural
-- (auto) widths store nothing, so hiding/showing columns,
-- Show All, and Reset visibility can never disturb widths, and
-- one column's width can never affect another's.
--
-- Scope is (account_id, flow_id): Completed and Incomplete share
-- one configuration per flow, and flows never see each other's
-- widths. Reads are account members; writes are agent+ (same bar
-- as cell edits and header colors — viewers stay read-only
-- everywhere). Google Sheets never reads this table.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_column_widths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant + flow scope: widths belong to exactly one flow's
  -- Workspace. Both cascade (account wipe, flow delete).
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Stable column identity (visibility id, NOT the display label
  -- — renames must not orphan a saved width).
  column_key TEXT NOT NULL,
  -- Pixels, validated by the API to the 80–500 safe band.
  width_px INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_column_widths_key_unique
    UNIQUE (account_id, flow_id, column_key)
);

-- Hot path: "all widths for this flow's Workspace".
CREATE INDEX IF NOT EXISTS idx_workspace_column_widths_flow
  ON workspace_column_widths (account_id, flow_id);

-- ============================================================
-- RLS — account isolation on every path.
-- ============================================================
ALTER TABLE workspace_column_widths ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_column_widths_select ON workspace_column_widths;
CREATE POLICY workspace_column_widths_select ON workspace_column_widths FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS workspace_column_widths_insert ON workspace_column_widths;
CREATE POLICY workspace_column_widths_insert ON workspace_column_widths FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_column_widths_update ON workspace_column_widths;
CREATE POLICY workspace_column_widths_update ON workspace_column_widths FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_column_widths_delete ON workspace_column_widths;
CREATE POLICY workspace_column_widths_delete ON workspace_column_widths FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON workspace_column_widths;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_column_widths
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
