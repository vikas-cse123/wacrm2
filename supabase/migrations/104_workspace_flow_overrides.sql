-- ============================================================
-- 104_workspace_flow_overrides.sql — agent overrides for
-- flow-derived Workspace cells.
--
-- One row per (account, flow, run, question key): the Workspace
-- value an agent set over the original flow-run answer. The
-- original answer stays untouched in flow_runs.vars forever;
-- deleting the override row restores the original display
-- (displayValue = override ?? original).
--
-- value_text NULL = explicit empty override (clearing a value is
-- distinguishable from having no override, so a cleared cell does
-- NOT fall back to the original). Row absent = no override.
--
-- New additive table only: flow_runs.vars, workspace_fields,
-- workspace_values, and every Sheets/Travel CRM read path are
-- untouched. Google Sheets keeps reading original answers;
-- Travel CRM lead loading merges overrides explicitly.
--
-- Tenant isolation mirrors workspace_values: any account member
-- may read; agent+ may write. Idempotent — safe to run multiple
-- times.
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_flow_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalised tenant key so RLS needs no join (mirrors
  -- workspace_values in 088).
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- The flow run this override belongs to. Run deletion cascades
  -- its overrides so history never orphans.
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  -- Stable internal question identity (collect_input var_key or
  -- buttons/list node_key) — never the display label.
  field_key TEXT NOT NULL,
  -- All values as TEXT (mirrors workspace_values). NULL =
  -- explicitly cleared.
  value_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_flow_overrides_one_value
    UNIQUE (account_id, flow_id, flow_run_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_flow_overrides_run
  ON workspace_flow_overrides (account_id, flow_id, flow_run_id);

ALTER TABLE workspace_flow_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_flow_overrides_select ON workspace_flow_overrides;
CREATE POLICY workspace_flow_overrides_select
ON workspace_flow_overrides
FOR SELECT
USING (is_account_member(account_id));

DROP POLICY IF EXISTS workspace_flow_overrides_insert ON workspace_flow_overrides;
CREATE POLICY workspace_flow_overrides_insert
ON workspace_flow_overrides
FOR INSERT
WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_flow_overrides_update ON workspace_flow_overrides;
CREATE POLICY workspace_flow_overrides_update
ON workspace_flow_overrides
FOR UPDATE
USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_flow_overrides_delete ON workspace_flow_overrides;
CREATE POLICY workspace_flow_overrides_delete
ON workspace_flow_overrides
FOR DELETE
USING (is_account_member(account_id, 'agent'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON workspace_flow_overrides;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_flow_overrides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
