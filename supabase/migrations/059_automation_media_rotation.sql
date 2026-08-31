-- ============================================================
-- 059_automation_media_rotation.sql
--
-- Per-contact rotation state for `send_media` automation steps that
-- use selection_mode = 'rotate' (see SendMediaStepConfig in
-- src/types/index.ts).
--
-- Why a table: rotation must survive browser refreshes, backend and
-- worker restarts, and be scoped per contact so two customers never
-- interfere with each other's sequence. Node scoping uses the step's
-- `rotation_key` (persisted inside step_config JSONB) rather than the
-- automation_steps.id UUID, because replaceSteps() re-inserts every
-- step with a fresh UUID on each save — a step-row FK would silently
-- reset every contact's rotation each time the automation is edited.
--
-- Concurrency: the engine never does a naive READ index / SEND /
-- WRITE index. It calls claim_automation_media_index(), which
-- atomically reads-and-advances the counter under the row lock taken
-- by INSERT ... ON CONFLICT DO UPDATE, so two concurrent executions
-- for the same contact + node get distinct indexes. If the send then
-- fails, the engine calls release_automation_media_index() to put the
-- counter back, so the failed message is retried instead of skipped
-- (migration 007's RPC pattern, extended with a return value).
--
-- RLS: service-role only, like automation_pending_executions — writes
-- never originate from the browser and the engine uses the
-- service-role client.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_media_rotation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- The send_media step's rotation_key from step_config (NOT the step
  -- row UUID, which changes on every save — see header comment).
  step_key TEXT NOT NULL,
  -- Index (0-based) of the message the NEXT execution will send.
  current_index INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One counter per automation + node + contact. The unique constraint
  -- is what makes the claim RPC's ON CONFLICT path atomic.
  UNIQUE (automation_id, contact_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_automation_media_rotation_automation
  ON automation_media_rotation(automation_id);

ALTER TABLE automation_media_rotation ENABLE ROW LEVEL SECURITY;
-- No policies: the engine alone touches this table via the service-role
-- client (mirrors automation_pending_executions in migration 006).

-- ------------------------------------------------------------
-- claim_automation_media_index
--
-- Atomically return the index this execution should send and park
-- next_index for the following one:
--   claimed = current_index % p_message_count
--   current_index = (current_index + 1) % p_message_count
--
-- The ON CONFLICT DO UPDATE takes a row lock on the
-- (automation_id, contact_id, step_key) row, so two concurrent runs
-- for the same contact + node can never read the same index twice.
-- Returns the 0-based index to send.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_automation_media_index(
  p_automation_id UUID,
  p_contact_id UUID,
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
    INSERT INTO automation_media_rotation
      (automation_id, contact_id, step_key, current_index)
    VALUES
      (p_automation_id, p_contact_id, p_step_key, 1 % v_count)
    ON CONFLICT (automation_id, contact_id, step_key)
    DO UPDATE SET
      current_index = (automation_media_rotation.current_index + 1) % v_count,
      updated_at = NOW()
    RETURNING (current_index + v_count - 1) % v_count INTO v_claimed;
    RETURN v_claimed;
  END;
$$;

-- ------------------------------------------------------------
-- release_automation_media_index
--
-- Roll the counter back one step after a FAILED send, so the next
-- execution retries the same message instead of skipping it. Only the
-- engine calls this, immediately after a failed claim-and-send, so a
-- simple modular decrement (row-locked, same ON CONFLICT path) is
-- sufficient.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_automation_media_index(
  p_automation_id UUID,
  p_contact_id UUID,
  p_step_key TEXT,
  p_message_count INTEGER
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO automation_media_rotation
    (automation_id, contact_id, step_key, current_index)
  VALUES
    (p_automation_id, p_contact_id, p_step_key, 0)
  ON CONFLICT (automation_id, contact_id, step_key)
  DO UPDATE SET
    current_index = (automation_media_rotation.current_index - 1 + GREATEST(p_message_count, 1)) % GREATEST(p_message_count, 1),
    updated_at = NOW();
$$;

-- Only the service role needs these (engine uses the service-role
-- client). Explicitly lock anon / authenticated out so an
-- authenticated user can't skew someone else's rotation via RPC
-- (same grant shape as increment_automation_execution_count, 007).
REVOKE ALL ON FUNCTION claim_automation_media_index(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_automation_media_index(UUID, UUID, TEXT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION claim_automation_media_index(UUID, UUID, TEXT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_automation_media_index(UUID, UUID, TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION release_automation_media_index(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_automation_media_index(UUID, UUID, TEXT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION release_automation_media_index(UUID, UUID, TEXT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION release_automation_media_index(UUID, UUID, TEXT, INTEGER) TO service_role;
