-- 037_chat_assignment.sql — Account-level auto-assignment configuration
--
-- Stores the default routing mode (round-robin / equal-load / none),
-- behavioural toggles (online-only, reassign-on-offline), and custom
-- routing rules that match on contact traits.

-- ============================================================
-- 1. Account-level assignment config (one row per account)
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_assignment_config (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  default_mode TEXT CHECK (default_mode IN ('round_robin', 'equal_load')),
  online_only BOOLEAN NOT NULL DEFAULT TRUE,
  reassign_offline BOOLEAN NOT NULL DEFAULT FALSE,
  round_robin_cursor UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chat_assignment_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read own account config"
  ON chat_assignment_config FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Admins can upsert own account config"
  ON chat_assignment_config FOR ALL
  USING (account_id IN (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

-- ============================================================
-- 2. Custom assignment rules (evaluated before the default mode)
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_assignment_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trait_field TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('is', 'contains', 'starts_with')),
  trait_values TEXT[] NOT NULL DEFAULT '{}',
  agent_ids UUID[] NOT NULL DEFAULT '{}',
  position INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chat_assignment_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read own account rules"
  ON chat_assignment_rules FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Admins can manage own account rules"
  ON chat_assignment_rules FOR ALL
  USING (account_id IN (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

CREATE INDEX IF NOT EXISTS idx_chat_assignment_rules_account
  ON chat_assignment_rules(account_id, position);
