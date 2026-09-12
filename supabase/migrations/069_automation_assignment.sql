-- ============================================================
-- 069_automation_assignment.sql — Automation-specific assignment
--
-- Lightweight per-automation people (NOT CRM users/agents) with
-- weighted selection, durable per-execution picks keyed by the exact
-- flow run, and sheet enrichment via flow_run_id.
--
-- Why tables: step_config JSONB holds static persons authoring, but
-- weighted selection needs atomic per-execution durable state
-- surviving restarts + concurrent dispatches (same argument as
-- 059_automation_media_rotation header). Step row UUIDs churn on
-- every save (steps-tree.ts), so stable step_key lives in config.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. automation_logs.flow_run_id (exact Flow run this execution
--    belongs to, when applicable; NULL = independent automation)
-- ------------------------------------------------------------
ALTER TABLE automation_logs
  ADD COLUMN IF NOT EXISTS flow_run_id UUID REFERENCES flow_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_automation_logs_flow_run
  ON automation_logs(flow_run_id);

-- ------------------------------------------------------------
-- 2. automation_pending_executions.flow_run_id (survives wait/resume;
--    re-injected into context on resume so retries stay pinned)
-- ------------------------------------------------------------
ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS flow_run_id UUID REFERENCES flow_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_automation_pending_flow_run
  ON automation_pending_executions(flow_run_id);

-- ------------------------------------------------------------
-- 3. automation_assignment_picks — durable pick per execution
--
-- UNIQUE(automation_id, log_id, step_key) gives exactly-once per
-- execution: retries/reprocesses read-before-pick, concurrent
-- workers converge via INSERT ... ON CONFLICT DO NOTHING.
-- flow_run_id is deliberately EXCLUDED from the unique key so
-- independent (NULL) picks still dedupe by (log, step).
-- Snapshot columns preserve history if config changes later.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_assignment_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  flow_run_id UUID REFERENCES flow_runs(id) ON DELETE SET NULL,
  log_id UUID REFERENCES automation_logs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  person_name TEXT NOT NULL,
  person_index INTEGER NOT NULL,
  percentage NUMERIC NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  -- 'text' = WhatsApp text via engineSendText; 'image' = image with
  -- caption via engineSendMedia (same transport as Send Media steps).
  -- Absent on legacy configs means 'text'.
  message_type TEXT NOT NULL DEFAULT 'text',
  media_url TEXT,
  tag_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (automation_id, log_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_assignment_picks_automation
  ON automation_assignment_picks(automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignment_picks_flow_run
  ON automation_assignment_picks(flow_run_id);
CREATE INDEX IF NOT EXISTS idx_assignment_picks_auto_flow
  ON automation_assignment_picks(automation_id, flow_run_id);
CREATE INDEX IF NOT EXISTS idx_assignment_picks_log
  ON automation_assignment_picks(log_id);

ALTER TABLE automation_assignment_picks ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, mirrors automation_pending_executions
-- (006) and automation_media_rotation (059). Reads for sheet sync also
-- use the service-role admin client; logs UI joins via service role.
