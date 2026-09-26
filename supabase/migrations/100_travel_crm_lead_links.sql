-- ============================================================
-- 100_travel_crm_lead_links.sql — idempotency foundation for the
-- WACRM → Travel CRM lead-creation integration (Phase 1: WACRM
-- side only — no external calls, no credentials).
--
-- One row per (account, WACRM lead, integration). The UNIQUE
-- constraint is the duplicate guard: a lead already linked to
-- `travel-crm` is never sent twice. `external_lead_id` stays
-- NULL until Travel CRM actually returns a real lead ID — Phase
-- 1 only ever writes `pending` rows, never `created`.
--
-- Tenant isolation mirrors whatsapp_followups (089): any account
-- member may read; agent+ may write (operational data).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS travel_crm_lead_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Stable WACRM lead identity: the flow run (never a row number).
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  -- Integration discriminator (one namespace per target system).
  integration_type TEXT NOT NULL DEFAULT 'travel-crm',
  -- Real external lead ID. NULL until the target system confirms
  -- creation — a NULL here must never render as "Created".
  external_lead_id TEXT,
  -- Lifecycle: Phase 1 writes `pending` only. `created` requires
  -- a real external_lead_id; `failed` carries last_error.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'created', 'failed')
  ),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT travel_crm_lead_links_one_link
    UNIQUE (account_id, flow_run_id, integration_type)
);

CREATE INDEX IF NOT EXISTS idx_travel_crm_lead_links_account
  ON travel_crm_lead_links (account_id);

ALTER TABLE travel_crm_lead_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS travel_crm_lead_links_select ON travel_crm_lead_links;
CREATE POLICY travel_crm_lead_links_select
ON travel_crm_lead_links
FOR SELECT
USING (is_account_member(account_id));

DROP POLICY IF EXISTS travel_crm_lead_links_insert ON travel_crm_lead_links;
CREATE POLICY travel_crm_lead_links_insert
ON travel_crm_lead_links
FOR INSERT
WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS travel_crm_lead_links_update ON travel_crm_lead_links;
CREATE POLICY travel_crm_lead_links_update
ON travel_crm_lead_links
FOR UPDATE
USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS travel_crm_lead_links_delete ON travel_crm_lead_links;
CREATE POLICY travel_crm_lead_links_delete
ON travel_crm_lead_links
FOR DELETE
USING (is_account_member(account_id, 'agent'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON travel_crm_lead_links;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON travel_crm_lead_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
