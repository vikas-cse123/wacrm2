-- ============================================================
-- 088_workspace_custom_columns.sql — Workspace custom columns
--
-- Lets agents add their own columns (Status, Follow-up Date,
-- Budget…) to a flow's Workspace table and edit cell values
-- inline. Strictly Workspace-scoped: Google Sheets (mappings,
-- sync, responses, routes) is untouched and never reads these
-- tables, and custom values never touch flow vars/node config.
--
-- Model (no table per column, no table per flow):
--   - workspace_fields: one row per custom column — account +
--     flow scope, stable UUID identity (display names are NOT
--     identity), type, position, options JSONB, nullable default.
--   - workspace_values: one row per (field, flow_run) — all
--     values as TEXT (checkbox "true"/"false", multi-select JSON
--     array string), UNIQUE(field_id, flow_run_id).
--
-- Tenant isolation mirrors message_templates (017): any account
-- member may read; field schema writes are admin+; value writes
-- are agent+ (operational data, like sending messages).
-- Deleting a flow/account cascades its fields; deleting a field
-- cascades its values; deleting a flow run cascades its values.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Supported custom column types (phase 1 — no others accepted).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_field_type') THEN
    CREATE TYPE workspace_field_type AS ENUM (
      'text',
      'number',
      'currency',
      'date',
      'datetime',
      'single_select',
      'multi_select',
      'checkbox',
      'url'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant key + flow scope: definitions belong to exactly one
  -- flow's Workspace. Both cascade (account wipe, flow delete).
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Display label (trimmed, case-insensitively unique per flow).
  name TEXT NOT NULL,
  field_type workspace_field_type NOT NULL,
  -- Append order. No drag-reorder in phase 1, but the column
  -- exists so ordering support never needs a migration later.
  position INT NOT NULL DEFAULT 0,
  -- Select options: JSON array of strings. NULL for other types.
  options JSONB,
  -- Default for NEW records only (never backfilled). TEXT for
  -- every type (checkbox "true"/"false", multi-select single
  -- option value). NULL = no default.
  default_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One name per flow (case-insensitive): "Status"/"status" collide
-- rather than silently forking into two columns.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_fields_flow_name_unique
  ON workspace_fields (account_id, flow_id, lower(name));

-- Hot path: "all custom columns for this flow's Workspace".
CREATE INDEX IF NOT EXISTS idx_workspace_fields_flow
  ON workspace_fields (account_id, flow_id);

CREATE TABLE IF NOT EXISTS workspace_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalised tenant key so RLS needs no join (mirrors
  -- conversation_pins in 054).
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  field_id UUID NOT NULL REFERENCES workspace_fields(id) ON DELETE CASCADE,
  -- The flow run this cell belongs to. Run deletion cascades its
  -- custom cells so history never orphans.
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  -- All values as TEXT: plain text/number/currency/date strings,
  -- checkbox "true"/"false", single-select option, multi-select
  -- JSON array string, URL string. NULL = explicitly cleared.
  value_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_values_field_run_key
    UNIQUE (field_id, flow_run_id)
);

-- Hot path: "custom cells for these runs" (page fetch joins by
-- run id set) + "all cells of one field" (column delete audit).
CREATE INDEX IF NOT EXISTS idx_workspace_values_run
  ON workspace_values (flow_run_id);
CREATE INDEX IF NOT EXISTS idx_workspace_values_field
  ON workspace_values (field_id);

-- ============================================================
-- RLS — account isolation on every path.
-- ============================================================
ALTER TABLE workspace_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_values ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_fields_select ON workspace_fields;
CREATE POLICY workspace_fields_select ON workspace_fields FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS workspace_fields_insert ON workspace_fields;
CREATE POLICY workspace_fields_insert ON workspace_fields FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS workspace_fields_update ON workspace_fields;
CREATE POLICY workspace_fields_update ON workspace_fields FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS workspace_fields_delete ON workspace_fields;
CREATE POLICY workspace_fields_delete ON workspace_fields FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS workspace_values_select ON workspace_values;
CREATE POLICY workspace_values_select ON workspace_values FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS workspace_values_insert ON workspace_values;
CREATE POLICY workspace_values_insert ON workspace_values FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_values_update ON workspace_values;
CREATE POLICY workspace_values_update ON workspace_values FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_values_delete ON workspace_values;
CREATE POLICY workspace_values_delete ON workspace_values FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON workspace_fields;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_fields
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON workspace_values;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_values
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
