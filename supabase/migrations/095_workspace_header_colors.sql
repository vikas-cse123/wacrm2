-- ============================================================
-- 095_workspace_header_colors.sql — per-column Workspace header
-- background overrides.
--
-- One row per customized column, keyed by the STABLE visibility
-- id (`core:row`, `flow:<key>`, `custom:<field uuid>`,
-- `lead_source` — the same identity the visibility manager
-- uses). Defaults live in code (header-colors.ts); only user
-- overrides persist here, so hiding/showing columns, Show All,
-- and Reset visibility can never reset colors, and one column's
-- color can never affect another's.
--
-- Scope is (account_id, flow_id): one flow's tints never leak
-- into another's, and RLS keeps accounts isolated. Reads are
-- account members; writes are agent+ (cosmetic display
-- preference, same bar as editing cell values — viewers stay
-- read-only everywhere). Google Sheets never reads this table.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_header_colors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant + flow scope: overrides belong to exactly one flow's
  -- Workspace. Both cascade (account wipe, flow delete).
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Stable column identity (visibility id, NOT the display label
  -- — renames must not orphan a customization).
  column_key TEXT NOT NULL,
  -- Normalized lowercase #rrggbb (validated by the API).
  color TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_header_colors_key_unique
    UNIQUE (account_id, flow_id, column_key)
);

-- Hot path: "all overrides for this flow's Workspace".
CREATE INDEX IF NOT EXISTS idx_workspace_header_colors_flow
  ON workspace_header_colors (account_id, flow_id);

-- ============================================================
-- RLS — account isolation on every path.
-- ============================================================
ALTER TABLE workspace_header_colors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_header_colors_select ON workspace_header_colors;
CREATE POLICY workspace_header_colors_select ON workspace_header_colors FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS workspace_header_colors_insert ON workspace_header_colors;
CREATE POLICY workspace_header_colors_insert ON workspace_header_colors FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_header_colors_update ON workspace_header_colors;
CREATE POLICY workspace_header_colors_update ON workspace_header_colors FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_header_colors_delete ON workspace_header_colors;
CREATE POLICY workspace_header_colors_delete ON workspace_header_colors FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON workspace_header_colors;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_header_colors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
