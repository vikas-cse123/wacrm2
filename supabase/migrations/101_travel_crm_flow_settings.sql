-- ============================================================
-- 101_travel_crm_flow_settings.sql — per-flow Travel CRM
-- service defaults for Workspace lead creation.
--
-- One row per (account, flow): the services preselected when
-- creating a Travel CRM lead from that flow's Workspace.
-- Per-lead dialog overrides never touch these rows.
--
-- Tenant isolation mirrors travel_crm_lead_links (100): any
-- account member may read; agent+ may write (operational data).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS travel_crm_flow_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Service labels as picked in Workspace settings (never Travel
  -- CRM database IDs); resolved to enum values at send time.
  services JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT travel_crm_flow_settings_one_row
    UNIQUE (account_id, flow_id)
);

CREATE INDEX IF NOT EXISTS idx_travel_crm_flow_settings_account
  ON travel_crm_flow_settings (account_id);

ALTER TABLE travel_crm_flow_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS travel_crm_flow_settings_select ON travel_crm_flow_settings;
CREATE POLICY travel_crm_flow_settings_select
ON travel_crm_flow_settings
FOR SELECT
USING (is_account_member(account_id));

DROP POLICY IF EXISTS travel_crm_flow_settings_insert ON travel_crm_flow_settings;
CREATE POLICY travel_crm_flow_settings_insert
ON travel_crm_flow_settings
FOR INSERT
WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS travel_crm_flow_settings_update ON travel_crm_flow_settings;
CREATE POLICY travel_crm_flow_settings_update
ON travel_crm_flow_settings
FOR UPDATE
USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS travel_crm_flow_settings_delete ON travel_crm_flow_settings;
CREATE POLICY travel_crm_flow_settings_delete
ON travel_crm_flow_settings
FOR DELETE
USING (is_account_member(account_id, 'agent'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON travel_crm_flow_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON travel_crm_flow_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
