-- ============================================================
-- 070_automation_assignment_swrr.sql — Smooth Weighted Round Robin
--
-- Replaces weighted-random selection with deterministic SWRR.
-- Persistent state survives restarts, deploys, multi-process,
-- and concurrent executions via row-level lock (SELECT FOR UPDATE).
--
-- State is global per automation+step_key (NOT per contact), so
-- Vikas 50/Akash 25/Vivek 25 yields long-run 50/25/25 across
-- all leads, with bounded deficit and no clustering.
--
-- Why separate table from automation_assignment_picks:
-- picks is per-execution (log_id) retry safety; this table is
-- per-automation-step allocation state (current_weight per person).
-- Same split as 059/061 media rotation (per-contact vs global).
--
-- Config-change handling (NOT blind reset):
--  * percentage change (same names, same order) → keep
--    current_weights for matched names, update person_weights.
--    Sum stays 0, next pick reflects new proportions smoothly.
--  * reordering → permute current_weights by name (lowercase)
--    identity, not position, so Akash keeps his accumulator
--    even if swapped with Vikas. Documented below.
--  * adding a person → matched keep, new gets 0. Sum stays 0
--    (new has no history, fairly interleaved; e.g., after
--    [-50,25,25], adding D 10 → [-50,25,25,0] → next pick
--    correctly favors Akash/Vivek over new D).
--  * removing a person → matched keep, dropped discarded,
--    remaining sum may be non-zero (e.g., [-50,25,25] remove
--    middle → [-50,25] sum -25). Re-center by subtracting
--    mean (sum/n) from each remaining to restore sum=0
--    invariant, preserving relative deficits without bias.
--    Blindly keeping [-50,25] would permanently bias remaining.
--  * renaming → treated as remove old + add new (no stable ID
--    without person UUID; name is validation-unique key).
--    Old accumulator discarded, new gets 0 then re-centered.
--    Necessary because we cannot distinguish rename from
--    genuine remove+add without stable ID. Tag_id not used as
--    identity since tags need not be unique per person.
--
-- All reconciliations make sum(current_weights)=0 before the
-- SWRR step, then SWRR does: current_weight[i]+=weight[i],
-- pick max (tie smallest index), current_weight[picked]-=total.
-- Sum returns to 0. See also python verification in PR.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_assignment_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  -- Snapshot of last reconciled config (for drift detection)
  person_names TEXT[] NOT NULL,
  person_weights NUMERIC[] NOT NULL,
  -- SWRR accumulator, same length as above, sum = 0 invariant
  current_weights NUMERIC[] NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (automation_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_assignment_state_automation
  ON automation_assignment_state(automation_id);

ALTER TABLE automation_assignment_state ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, like 059/061/069

-- ------------------------------------------------------------
-- claim_assignment_swrr_pick
--
-- Atomically selects next person via Smooth Weighted Round Robin.
-- Handles concurrent callers via row lock (SELECT FOR UPDATE) so
-- two leads hitting same automation+step never read same state.
-- Returns 0-based index into p_person_names/weights.
--
-- Reconciliation is deterministic and preserves fairness:
--  see table header for per-case handling.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_assignment_swrr_pick(
  p_automation_id UUID,
  p_step_key TEXT,
  p_person_names TEXT[],
  p_person_weights NUMERIC[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
  v_total NUMERIC;
  v_old_names TEXT[];
  v_old_weights NUMERIC[];
  v_old_cur NUMERIC[];
  v_new_cur NUMERIC[];
  v_sum NUMERIC;
  v_mean NUMERIC;
  v_picked INTEGER := 1;
  v_max NUMERIC;
  v_found_idx INTEGER;
BEGIN
  v_n := array_length(p_person_names, 1);
  IF v_n IS NULL OR v_n = 0 THEN
    RAISE EXCEPTION 'claim_assignment_swrr_pick: no persons';
  END IF;
  IF array_length(p_person_weights, 1) != v_n THEN
    RAISE EXCEPTION 'claim_assignment_swrr_pick: names/weights length mismatch';
  END IF;
  SELECT sum(w) INTO v_total FROM unnest(p_person_weights) w;
  IF v_total IS NULL OR v_total <= 0 THEN
    RAISE EXCEPTION 'claim_assignment_swrr_pick: total weight must be >0';
  END IF;

  -- Ensure row exists (insert zeros if first time)
  INSERT INTO automation_assignment_state
    (automation_id, step_key, person_names, person_weights, current_weights)
  VALUES
    (p_automation_id, p_step_key, p_person_names, p_person_weights, array_fill(0::numeric, ARRAY[v_n]))
  ON CONFLICT (automation_id, step_key) DO NOTHING;

  -- Lock row
  SELECT person_names, person_weights, current_weights
    INTO v_old_names, v_old_weights, v_old_cur
  FROM automation_assignment_state
  WHERE automation_id = p_automation_id AND step_key = p_step_key
  FOR UPDATE;

  -- If row was just inserted, v_old_* will be the inserted values (p_*)
  -- Detect first-time or config drift by checking if we need reconciliation:
  --  - length mismatch
  --  - or any old name/weight differs from new (case-insensitive name)
  -- We already have v_old_* from SELECT; if they match exactly, we can reuse v_old_cur directly.
  -- Otherwise rebuild v_new_cur via identity matching.

  -- Fast path: exact match (same order, same names case-insensitive, same weights) → keep cur
  IF v_old_names IS NOT NULL AND v_old_weights IS NOT NULL AND v_old_cur IS NOT NULL
     AND array_length(v_old_names,1) = v_n
     AND array_length(v_old_cur,1) = v_n THEN
    -- Check exact match
    DECLARE
      v_exact BOOLEAN := true;
    BEGIN
      FOR i IN 1..v_n LOOP
        IF lower(COALESCE(v_old_names[i],'')) != lower(COALESCE(p_person_names[i],'')) OR v_old_weights[i] != p_person_weights[i] THEN
          v_exact := false;
          EXIT;
        END IF;
      END LOOP;
      IF v_exact THEN
        v_new_cur := v_old_cur;
      ELSE
        -- Need reconciliation: map by lower(name) identity
        v_new_cur := array_fill(0::numeric, ARRAY[v_n]);
        FOR i IN 1..v_n LOOP
          v_found_idx := NULL;
          FOR j IN 1..array_length(v_old_names,1) LOOP
            IF lower(v_old_names[j]) = lower(p_person_names[i]) THEN
              v_found_idx := j;
              EXIT;
            END IF;
          END LOOP;
          IF v_found_idx IS NOT NULL AND v_found_idx <= array_length(v_old_cur,1) THEN
            v_new_cur[i] := v_old_cur[v_found_idx];
          ELSE
            v_new_cur[i] := 0;
          END IF;
        END LOOP;
        -- Re-center to sum=0 to undo drift from removals/renames
        SELECT sum(x) INTO v_sum FROM unnest(v_new_cur) x;
        IF v_sum IS NOT NULL AND v_sum != 0 THEN
          v_mean := v_sum / v_n;
          FOR i IN 1..v_n LOOP v_new_cur[i] := v_new_cur[i] - v_mean; END LOOP;
        END IF;
      END IF;
    END;
  ELSE
    -- Length mismatch or null → reconciliation same as above
    IF v_old_names IS NOT NULL AND v_old_cur IS NOT NULL THEN
      v_new_cur := array_fill(0::numeric, ARRAY[v_n]);
      FOR i IN 1..v_n LOOP
        v_found_idx := NULL;
        IF v_old_names IS NOT NULL THEN
          FOR j IN 1..array_length(v_old_names,1) LOOP
            IF lower(v_old_names[j]) = lower(p_person_names[i]) THEN
              v_found_idx := j;
              EXIT;
            END IF;
          END LOOP;
        END IF;
        IF v_found_idx IS NOT NULL AND v_found_idx <= array_length(v_old_cur,1) THEN
          v_new_cur[i] := v_old_cur[v_found_idx];
        ELSE
          v_new_cur[i] := 0;
        END IF;
      END LOOP;
      SELECT sum(x) INTO v_sum FROM unnest(v_new_cur) x;
      IF v_sum IS NOT NULL AND v_sum != 0 THEN
        v_mean := v_sum / v_n;
        FOR i IN 1..v_n LOOP v_new_cur[i] := v_new_cur[i] - v_mean; END LOOP;
      END IF;
    ELSE
      v_new_cur := array_fill(0::numeric, ARRAY[v_n]);
    END IF;
  END IF;

  -- SWRR step: add weights, pick max (tie smallest index), subtract total
  FOR i IN 1..v_n LOOP v_new_cur[i] := v_new_cur[i] + p_person_weights[i]; END LOOP;
  v_max := v_new_cur[1];
  v_picked := 1;
  FOR i IN 2..v_n LOOP
    IF v_new_cur[i] > v_max THEN
      v_max := v_new_cur[i];
      v_picked := i;
    END IF;
  END LOOP;
  v_new_cur[v_picked] := v_new_cur[v_picked] - v_total;

  UPDATE automation_assignment_state
  SET person_names = p_person_names,
      person_weights = p_person_weights,
      current_weights = v_new_cur,
      updated_at = NOW()
  WHERE automation_id = p_automation_id AND step_key = p_step_key;

  RETURN v_picked - 1; -- 0-based for JS
END;
$$;

REVOKE ALL ON FUNCTION claim_assignment_swrr_pick(UUID, TEXT, TEXT[], NUMERIC[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_assignment_swrr_pick(UUID, TEXT, TEXT[], NUMERIC[]) FROM anon;
REVOKE ALL ON FUNCTION claim_assignment_swrr_pick(UUID, TEXT, TEXT[], NUMERIC[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_assignment_swrr_pick(UUID, TEXT, TEXT[], NUMERIC[]) TO service_role;

-- ------------------------------------------------------------
-- claim_assignment_pick_swrr (atomic SWRR + durable pick)
--
-- Correct concurrency for same log_id: exactly one worker advances
-- SWRR and creates the durable pick; loser reuses winner and does
-- NOT consume another SWRR turn.
--
-- Two-worker example (same automation+step, same log_id):
--   Initial cur [0,0,0] weights 50/25/25
--   Worker A locks SWRR row, computes Vikas (-50,25,25) but not yet committed.
--   Worker B waits for lock.
--   A: INSERT picks log-1 Vikas ON CONFLICT DO NOTHING → success (1 row)
--      → UPDATE SWRR to [-50,25,25], COMMIT, release lock.
--   B: acquires lock, SELECT picks WHERE log_id=log-1 → finds Vikas (winner)
--      → return Vikas WITHOUT touching SWRR (no v_new_cur update).
--   Final SWRR = [-50,25,25] (one turn consumed), both workers return Vikas.
--   Next new lead (log-2) correctly gets Akash, not Vivek (no skipped turn).
--
-- For different log_ids, lock serializes: A picks Vikas, B picks Akash,
-- each consumes one turn, picks rows distinct (different log_id) → both succeed.
--
-- Retries (existing pick) never enter SWRR: early return before lock.
-- Send failure keeps pick (and SWRR already consumed) → retry reuses pick.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_assignment_pick_swrr(
  p_automation_id UUID,
  p_account_id UUID,
  p_contact_id UUID,
  p_flow_run_id UUID,
  p_log_id UUID,
  p_step_key TEXT,
  p_person_names TEXT[],
  p_person_weights NUMERIC[],
  p_person_messages TEXT[],
  p_person_message_types TEXT[],
  p_person_media_urls TEXT[],
  p_person_tag_ids TEXT[],
  p_person_percentages NUMERIC[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
  v_total NUMERIC;
  v_existing_idx INTEGER;
  v_picked_idx INTEGER;
  v_old_names TEXT[];
  v_old_weights NUMERIC[];
  v_old_cur NUMERIC[];
  v_new_cur NUMERIC[];
  v_sum NUMERIC;
  v_mean NUMERIC;
  v_max NUMERIC;
  v_found_idx INTEGER;
  v_picked INTEGER := 1;
BEGIN
  v_n := array_length(p_person_names, 1);
  IF v_n IS NULL OR v_n = 0 THEN
    RAISE EXCEPTION 'claim_assignment_pick_swrr: no persons';
  END IF;
  IF p_log_id IS NOT NULL THEN
    -- Fast path: retry without touching SWRR
    SELECT person_index INTO v_existing_idx
    FROM automation_assignment_picks
    WHERE automation_id = p_automation_id AND log_id = p_log_id AND step_key = p_step_key;
    IF v_existing_idx IS NOT NULL THEN
      RETURN v_existing_idx;
    END IF;
  END IF;

  -- Need SWRR lock for new assignment (or degraded transient)
  -- Ensure state row exists
  SELECT sum(w) INTO v_total FROM unnest(p_person_weights) w;
  IF v_total IS NULL OR v_total <= 0 THEN
    RAISE EXCEPTION 'claim_assignment_pick_swrr: total weight must be >0';
  END IF;

  INSERT INTO automation_assignment_state
    (automation_id, step_key, person_names, person_weights, current_weights)
  VALUES
    (p_automation_id, p_step_key, p_person_names, p_person_weights, array_fill(0::numeric, ARRAY[v_n]))
  ON CONFLICT (automation_id, step_key) DO NOTHING;

  SELECT person_names, person_weights, current_weights
    INTO v_old_names, v_old_weights, v_old_cur
  FROM automation_assignment_state
  WHERE automation_id = p_automation_id AND step_key = p_step_key
  FOR UPDATE;

  -- Re-check picks after acquiring lock (covers same log_id concurrent winner)
  IF p_log_id IS NOT NULL THEN
    SELECT person_index INTO v_existing_idx
    FROM automation_assignment_picks
    WHERE automation_id = p_automation_id AND log_id = p_log_id AND step_key = p_step_key;
    IF v_existing_idx IS NOT NULL THEN
      -- Loser: do NOT advance SWRR, just return winner
      RETURN v_existing_idx;
    END IF;
  END IF;

  -- Reconciliation (same as claim_assignment_swrr_pick)
  IF v_old_names IS NOT NULL AND v_old_weights IS NOT NULL AND v_old_cur IS NOT NULL
     AND array_length(v_old_names,1) = v_n
     AND array_length(v_old_cur,1) = v_n THEN
    DECLARE v_exact BOOLEAN := true;
    BEGIN
      FOR i IN 1..v_n LOOP
        IF lower(COALESCE(v_old_names[i],'')) != lower(COALESCE(p_person_names[i],'')) OR v_old_weights[i] != p_person_weights[i] THEN
          v_exact := false; EXIT;
        END IF;
      END LOOP;
      IF v_exact THEN
        v_new_cur := v_old_cur;
      ELSE
        v_new_cur := array_fill(0::numeric, ARRAY[v_n]);
        FOR i IN 1..v_n LOOP
          v_found_idx := NULL;
          FOR j IN 1..array_length(v_old_names,1) LOOP
            IF lower(v_old_names[j]) = lower(p_person_names[i]) THEN v_found_idx := j; EXIT; END IF;
          END LOOP;
          IF v_found_idx IS NOT NULL AND v_found_idx <= array_length(v_old_cur,1) THEN v_new_cur[i] := v_old_cur[v_found_idx];
          ELSE v_new_cur[i] := 0; END IF;
        END LOOP;
        SELECT sum(x) INTO v_sum FROM unnest(v_new_cur) x;
        IF v_sum IS NOT NULL AND v_sum != 0 THEN v_mean := v_sum / v_n; FOR i IN 1..v_n LOOP v_new_cur[i] := v_new_cur[i] - v_mean; END LOOP; END IF;
      END IF;
    END;
  ELSE
    IF v_old_names IS NOT NULL AND v_old_cur IS NOT NULL THEN
      v_new_cur := array_fill(0::numeric, ARRAY[v_n]);
      FOR i IN 1..v_n LOOP
        v_found_idx := NULL;
        IF v_old_names IS NOT NULL THEN
          FOR j IN 1..array_length(v_old_names,1) LOOP
            IF lower(v_old_names[j]) = lower(p_person_names[i]) THEN v_found_idx := j; EXIT; END IF;
          END LOOP;
        END IF;
        IF v_found_idx IS NOT NULL AND v_found_idx <= array_length(v_old_cur,1) THEN v_new_cur[i] := v_old_cur[v_found_idx];
        ELSE v_new_cur[i] := 0; END IF;
      END LOOP;
      SELECT sum(x) INTO v_sum FROM unnest(v_new_cur) x;
      IF v_sum IS NOT NULL AND v_sum != 0 THEN v_mean := v_sum / v_n; FOR i IN 1..v_n LOOP v_new_cur[i] := v_new_cur[i] - v_mean; END LOOP; END IF;
    ELSE
      v_new_cur := array_fill(0::numeric, ARRAY[v_n]);
    END IF;
  END IF;

  FOR i IN 1..v_n LOOP v_new_cur[i] := v_new_cur[i] + p_person_weights[i]; END LOOP;
  v_max := v_new_cur[1]; v_picked := 1;
  FOR i IN 2..v_n LOOP IF v_new_cur[i] > v_max THEN v_max := v_new_cur[i]; v_picked := i; END IF; END LOOP;
  v_new_cur[v_picked] := v_new_cur[v_picked] - v_total;
  v_picked_idx := v_picked - 1; -- 0-based

  -- Degraded mode (no log_id): just advance SWRR and return, no durable pick
  IF p_log_id IS NULL THEN
    UPDATE automation_assignment_state
    SET person_names = p_person_names, person_weights = p_person_weights, current_weights = v_new_cur, updated_at = NOW()
    WHERE automation_id = p_automation_id AND step_key = p_step_key;
    RETURN v_picked_idx;
  END IF;

  -- Try to insert durable pick; if concurrent winner inserted first, ON CONFLICT DO NOTHING returns 0 rows
  -- Use INSERT ... ON CONFLICT DO NOTHING and check via FOUND or via second SELECT
  INSERT INTO automation_assignment_picks
    (automation_id, account_id, contact_id, flow_run_id, log_id, step_key, person_name, person_index, percentage, message, message_type, media_url, tag_id)
  VALUES
    (p_automation_id, p_account_id, p_contact_id, p_flow_run_id, p_log_id, p_step_key,
     p_person_names[v_picked], v_picked_idx, p_person_percentages[v_picked], p_person_messages[v_picked], p_person_message_types[v_picked], p_person_media_urls[v_picked],
     (p_person_tag_ids[v_picked])::uuid)
  ON CONFLICT (automation_id, log_id, step_key) DO NOTHING;

  -- Did we win? Check if row now exists with our picked index
  SELECT person_index INTO v_existing_idx
  FROM automation_assignment_picks
  WHERE automation_id = p_automation_id AND log_id = p_log_id AND step_key = p_step_key;

  IF v_existing_idx = v_picked_idx THEN
    -- Winner: commit SWRR advancement
    UPDATE automation_assignment_state
    SET person_names = p_person_names, person_weights = p_person_weights, current_weights = v_new_cur, updated_at = NOW()
    WHERE automation_id = p_automation_id AND step_key = p_step_key;
    RETURN v_picked_idx;
  ELSE
    -- Loser: someone else inserted different pick (should be same as winner's pick if winner used SWRR, but could be random fallback?), do NOT advance SWRR
    -- Return winner's index without touching SWRR (keep old state)
    RETURN v_existing_idx;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION claim_assignment_pick_swrr(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT[], NUMERIC[], TEXT[], TEXT[], TEXT[], TEXT[], NUMERIC[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_assignment_pick_swrr(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT[], NUMERIC[], TEXT[], TEXT[], TEXT[], TEXT[], NUMERIC[]) FROM anon;
REVOKE ALL ON FUNCTION claim_assignment_pick_swrr(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT[], NUMERIC[], TEXT[], TEXT[], TEXT[], TEXT[], NUMERIC[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_assignment_pick_swrr(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT[], NUMERIC[], TEXT[], TEXT[], TEXT[], TEXT[], NUMERIC[]) TO service_role;
