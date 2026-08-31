-- ============================================================
-- 060_automation_media_rotation_global.sql
--
-- GLOBAL rotation state for `send_media` automation steps that use
-- selection_mode = 'rotate' with rotation_scope = 'global'
-- (see SendMediaStepConfig / SendMediaRotationScope in
-- src/types/index.ts).
--
-- Migration 059 introduced PER-CONTACT rotation: every contact's
-- sequence starts at Message 1. The global scope shares ONE counter
-- across all contacts of the automation, so consecutive contacts get
-- different messages (A→1, B→2, C→3, wrapping) — the broadcast-style
-- use case.
--
-- Why a separate table instead of touching 059's: that table's
-- contact_id is NOT NULL and its unique constraint treats NULLs as
-- distinct, so a shared counter can't live there without a breaking
-- alter. A dedicated table keeps both scopes independent and the 059
-- path byte-for-byte unchanged.
--
-- Concurrency + rollback mirror 059 exactly: the claim RPC reads and
-- advances the counter atomically under the row lock taken by
-- INSERT ... ON CONFLICT DO UPDATE; the engine calls the release RPC
-- after a failed send so the same message is retried, not skipped.
--
-- RLS: service-role only, like 059 — writes never originate from the
-- browser; the engine uses the service-role client.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_media_rotation_global (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  -- The send_media step's rotation_key from step_config (NOT the step
  -- row UUID, which changes on every save — see 059's header comment).
  step_key TEXT NOT NULL,
  -- Index (0-based) of the message the NEXT execution will send.
  current_index INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One shared counter per automation + node, regardless of contact.
  UNIQUE (automation_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_automation_media_rotation_global_automation
  ON automation_media_rotation_global(automation_id);

ALTER TABLE automation_media_rotation_global ENABLE ROW LEVEL SECURITY;
-- No policies: the engine alone touches this table via the service-role
-- client (mirrors automation_media_rotation in 059).

-- ------------------------------------------------------------
-- claim_automation_media_index_global
--
-- Same claim semantics as 059's claim_automation_media_index, minus
-- the contact dimension: atomically return the index this execution
-- should send and park next_index for the following one.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_automation_media_index_global(
  p_automation_id UUID,
  p_step_key TEXT,
  p_message_count INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
  DECLARE
    v_claimed INTEGER;
    v_count INTEGER;
  BEGIN
    v_count := GREATEST(p_message_count, 1);
    INSERT INTO automation_media_rotation_global
      (automation_id, step_key, current_index)
    VALUES
      (p_automation_id, p_step_key, 1 % v_count)
    ON CONFLICT (automation_id, step_key)
    DO UPDATE SET
      current_index = (automation_media_rotation_global.current_index + 1) % v_count,
      updated_at = NOW()
    RETURNING (current_index + v_count - 1) % v_count INTO v_claimed;
    RETURN v_claimed;
  END;
$$;

-- ------------------------------------------------------------
-- release_automation_media_index_global
--
-- Roll the shared counter back one step after a FAILED send, so the
-- next execution retries the same message instead of skipping it
-- (same modular decrement as 059's release RPC).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_automation_media_index_global(
  p_automation_id UUID,
  p_step_key TEXT,
  p_message_count INTEGER
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO automation_media_rotation_global
    (automation_id, step_key, current_index)
  VALUES
    (p_automation_id, p_step_key, 0)
  ON CONFLICT (automation_id, step_key)
  DO UPDATE SET
    current_index = (automation_media_rotation_global.current_index - 1 + GREATEST(p_message_count, 1)) % GREATEST(p_message_count, 1),
    updated_at = NOW();
$$;

-- Only the service role needs these (engine uses the service-role
-- client). Explicitly lock anon / authenticated out — same grant shape
-- as 059.
REVOKE ALL ON FUNCTION claim_automation_media_index_global(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_automation_media_index_global(UUID, TEXT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION claim_automation_media_index_global(UUID, TEXT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_automation_media_index_global(UUID, TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION release_automation_media_index_global(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_automation_media_index_global(UUID, TEXT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION release_automation_media_index_global(UUID, TEXT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION release_automation_media_index_global(UUID, TEXT, INTEGER) TO service_role;
