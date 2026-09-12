-- ============================================================
-- 071_automation_assignment_reservations.sql — Early SWRR reservation
--
-- Flow set_tag → synchronously reserve SWRR winner BEFORE Flow
-- continues to completion/sheet insertion. Later Assign Person step
-- reuses the reservation, never runs SWRR again. Ensures FIRST sheet
-- row already contains Assign = <person>.
--
-- Why new table: automation_assignment_picks is per-execution
-- (UNIQUE automation_id,log_id,step_key) where log_id is created at
-- automation execution time. Early reservation has no log_id yet,
-- only flow_run_id. Using log_id=NULL would break UNIQUE (NULL!=NULL)
-- and would allow duplicate reservations. New table keyed by
-- (flow_run_id, automation_id, step_key) gives exactly-one per Flow
-- Run, independent of log_id, with same SWRR state table (070).
--
-- RLS: service_role only, like 069/070.
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_assignment_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  person_index INT NOT NULL,
  person_name TEXT NOT NULL,
  percentage NUMERIC NOT NULL,
  message TEXT NOT NULL,
  message_type TEXT NOT NULL,
  media_url TEXT,
  tag_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_run_id, automation_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_assignment_reservations_flow_run
  ON automation_assignment_reservations(flow_run_id);
CREATE INDEX IF NOT EXISTS idx_assignment_reservations_automation
  ON automation_assignment_reservations(automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignment_reservations_flow_auto_step
  ON automation_assignment_reservations(flow_run_id, automation_id, step_key);

ALTER TABLE automation_assignment_reservations ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only

-- ------------------------------------------------------------
-- reserve_assignment_for_flow_run
--
-- Atomically reserves next SWRR winner for a specific Flow Run's
-- future Assign Person execution. Uses same SWRR state as 070
-- (automation_assignment_state) with FOR UPDATE lock.
--
-- Same flow_run+automation+step concurrent: exactly one SWRR turn,
-- both callers receive same person (second finds existing reservation).
-- Different flow_run: each consumes one distinct SWRR turn, serialized
-- via SWRR row lock.
--
-- Returns person_index (0-based). Also inserts reservation row with
-- snapshot (name/percentage/message/etc) so sheet can see Assign
-- before Picks exists, and later Picks can be created from snapshot
-- without second SWRR.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserve_assignment_for_flow_run(
  p_flow_run_id UUID,
  p_automation_id UUID,
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
    RAISE EXCEPTION 'reserve_assignment_for_flow_run: no persons';
  END IF;
  IF array_length(p_person_weights, 1) != v_n THEN
    RAISE EXCEPTION 'reserve_assignment_for_flow_run: names/weights length mismatch';
  END IF;
  SELECT sum(w) INTO v_total FROM unnest(p_person_weights) w;
  IF v_total IS NULL OR v_total <= 0 THEN
    RAISE EXCEPTION 'reserve_assignment_for_flow_run: total weight must be >0';
  END IF;

  -- Fast path: reservation already exists for this exact Flow Run
  SELECT person_index INTO v_existing_idx
  FROM automation_assignment_reservations
  WHERE flow_run_id = p_flow_run_id AND automation_id = p_automation_id AND step_key = p_step_key;
  IF v_existing_idx IS NOT NULL THEN
    RETURN v_existing_idx;
  END IF;

  -- Ensure SWRR state row exists
  INSERT INTO automation_assignment_state
    (automation_id, step_key, person_names, person_weights, current_weights)
  VALUES
    (p_automation_id, p_step_key, p_person_names, p_person_weights, array_fill(0::numeric, ARRAY[v_n]))
  ON CONFLICT (automation_id, step_key) DO NOTHING;

  -- Lock SWRR row
  SELECT person_names, person_weights, current_weights
    INTO v_old_names, v_old_weights, v_old_cur
  FROM automation_assignment_state
  WHERE automation_id = p_automation_id AND step_key = p_step_key
  FOR UPDATE;

  -- Re-check reservation after acquiring lock (covers same flow_run concurrent winner)
  SELECT person_index INTO v_existing_idx
  FROM automation_assignment_reservations
  WHERE flow_run_id = p_flow_run_id AND automation_id = p_automation_id AND step_key = p_step_key;
  IF v_existing_idx IS NOT NULL THEN
    RETURN v_existing_idx;
  END IF;

  -- Reconciliation (same as 070) by lower(name) identity
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
  v_picked_idx := v_picked - 1;

  -- Atomically insert reservation; RETURNING tells us if we won (inserted) or lost (conflict, no row)
  DECLARE v_inserted_idx INTEGER;
  BEGIN
    INSERT INTO automation_assignment_reservations
      (flow_run_id, automation_id, step_key, person_index, person_name, percentage, message, message_type, media_url, tag_id)
    VALUES
      (p_flow_run_id, p_automation_id, p_step_key, v_picked_idx, p_person_names[v_picked], p_person_percentages[v_picked], p_person_messages[v_picked], p_person_message_types[v_picked], NULLIF(p_person_media_urls[v_picked], ''), (NULLIF(p_person_tag_ids[v_picked], ''))::uuid)
    ON CONFLICT (flow_run_id, automation_id, step_key) DO NOTHING
    RETURNING person_index INTO v_inserted_idx;
    IF v_inserted_idx IS NOT NULL THEN
      -- Winner: commit SWRR advancement
      UPDATE automation_assignment_state
      SET person_names = p_person_names, person_weights = p_person_weights, current_weights = v_new_cur, updated_at = NOW()
      WHERE automation_id = p_automation_id AND step_key = p_step_key;
      RETURN v_picked_idx;
    ELSE
      -- Loser: reservation already exists (concurrent winner), do NOT advance SWRR
      SELECT person_index INTO v_existing_idx
      FROM automation_assignment_reservations
      WHERE flow_run_id = p_flow_run_id AND automation_id = p_automation_id AND step_key = p_step_key;
      RETURN v_existing_idx;
    END IF;
  END;
END;
$$;

REVOKE ALL ON FUNCTION reserve_assignment_for_flow_run(UUID, UUID, TEXT, TEXT[], NUMERIC[], TEXT[], TEXT[], TEXT[], TEXT[], NUMERIC[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_assignment_for_flow_run(UUID, UUID, TEXT, TEXT[], NUMERIC[], TEXT[], TEXT[], TEXT[], TEXT[], NUMERIC[]) FROM anon;
REVOKE ALL ON FUNCTION reserve_assignment_for_flow_run(UUID, UUID, TEXT, TEXT[], NUMERIC[], TEXT[], TEXT[], TEXT[], TEXT[], NUMERIC[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION reserve_assignment_for_flow_run(UUID, UUID, TEXT, TEXT[], NUMERIC[], TEXT[], TEXT[], TEXT[], TEXT[], NUMERIC[]) TO service_role;

-- ------------------------------------------------------------
-- Patch claim_assignment_pick_swrr to reuse early reservation
-- (071 additive, does not modify 070's SWRR state table)
-- If a reservation exists for flow_run+automation+step, use it
-- without advancing SWRR. This ensures Flow's early reservation
-- (before sheet insert) and later Assign Person execution use SAME
-- person, and exactly one SWRR turn is consumed (at reservation time).
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
  v_reserved_idx INTEGER;
  v_reserved_row RECORD;
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
  IF v_n IS NULL OR v_n = 0 THEN RAISE EXCEPTION 'claim_assignment_pick_swrr: no persons'; END IF;
  IF p_log_id IS NOT NULL THEN
    SELECT person_index INTO v_existing_idx FROM automation_assignment_picks WHERE automation_id = p_automation_id AND log_id = p_log_id AND step_key = p_step_key;
    IF v_existing_idx IS NOT NULL THEN RETURN v_existing_idx; END IF;
  END IF;

  -- Early reservation fast-path: if Flow Run already has a reserved assignment, reuse it
  IF p_flow_run_id IS NOT NULL THEN
    SELECT person_index, person_name, percentage, message, message_type, media_url, tag_id INTO v_reserved_row
    FROM automation_assignment_reservations
    WHERE flow_run_id = p_flow_run_id AND automation_id = p_automation_id AND step_key = p_step_key;
    IF v_reserved_row.person_index IS NOT NULL THEN
      -- Create picks row from reservation snapshot if not already exists
      IF p_log_id IS NOT NULL THEN
        INSERT INTO automation_assignment_picks
          (automation_id, account_id, contact_id, flow_run_id, log_id, step_key, person_name, person_index, percentage, message, message_type, media_url, tag_id)
        VALUES
          (p_automation_id, p_account_id, p_contact_id, p_flow_run_id, p_log_id, p_step_key, v_reserved_row.person_name, v_reserved_row.person_index, v_reserved_row.percentage, v_reserved_row.message, v_reserved_row.message_type, v_reserved_row.media_url, v_reserved_row.tag_id)
        ON CONFLICT (automation_id, log_id, step_key) DO NOTHING;
        SELECT person_index INTO v_existing_idx FROM automation_assignment_picks WHERE automation_id = p_automation_id AND log_id = p_log_id AND step_key = p_step_key;
        IF v_existing_idx IS NOT NULL THEN RETURN v_existing_idx; END IF;
      END IF;
      RETURN v_reserved_row.person_index;
    END IF;
  END IF;

  -- No reservation and no existing pick: need SWRR (only for flow_run with reservation not yet created, or independent)
  -- For flow_run with no reservation, we should have reserved earlier, but if not, we create reservation now atomically
  IF p_flow_run_id IS NOT NULL THEN
    -- Try to reserve now (this will do SWRR and insert reservation)
    SELECT reserve_assignment_for_flow_run(p_flow_run_id, p_automation_id, p_step_key, p_person_names, p_person_weights, p_person_messages, p_person_message_types, p_person_media_urls, p_person_tag_ids, p_person_percentages) INTO v_reserved_idx;
    IF v_reserved_idx IS NOT NULL THEN
      SELECT person_index, person_name, percentage, message, message_type, media_url, tag_id INTO v_reserved_row
      FROM automation_assignment_reservations
      WHERE flow_run_id = p_flow_run_id AND automation_id = p_automation_id AND step_key = p_step_key;
      IF p_log_id IS NOT NULL THEN
        INSERT INTO automation_assignment_picks
          (automation_id, account_id, contact_id, flow_run_id, log_id, step_key, person_name, person_index, percentage, message, message_type, media_url, tag_id)
        VALUES
          (p_automation_id, p_account_id, p_contact_id, p_flow_run_id, p_log_id, p_step_key, v_reserved_row.person_name, v_reserved_row.person_index, v_reserved_row.percentage, v_reserved_row.message, v_reserved_row.message_type, v_reserved_row.media_url, v_reserved_row.tag_id)
        ON CONFLICT (automation_id, log_id, step_key) DO NOTHING;
      END IF;
      RETURN v_reserved_idx;
    END IF;
  END IF;

  -- Fallback for independent (no flow_run) or reservation RPC failed: do SWRR directly (old 070 logic)
  SELECT sum(w) INTO v_total FROM unnest(p_person_weights) w;
  IF v_total IS NULL OR v_total <= 0 THEN RAISE EXCEPTION 'total weight must be >0'; END IF;
  INSERT INTO automation_assignment_state (automation_id, step_key, person_names, person_weights, current_weights)
  VALUES (p_automation_id, p_step_key, p_person_names, p_person_weights, array_fill(0::numeric, ARRAY[v_n]))
  ON CONFLICT (automation_id, step_key) DO NOTHING;
  SELECT person_names, person_weights, current_weights INTO v_old_names, v_old_weights, v_old_cur FROM automation_assignment_state WHERE automation_id = p_automation_id AND step_key = p_step_key FOR UPDATE;
  SELECT person_index INTO v_existing_idx FROM automation_assignment_picks WHERE automation_id = p_automation_id AND log_id = p_log_id AND step_key = p_step_key;
  IF v_existing_idx IS NOT NULL THEN RETURN v_existing_idx; END IF;
  IF v_old_names IS NOT NULL AND v_old_weights IS NOT NULL AND v_old_cur IS NOT NULL AND array_length(v_old_names,1)=v_n AND array_length(v_old_cur,1)=v_n THEN
    DECLARE v_exact BOOLEAN:=true; BEGIN FOR i IN 1..v_n LOOP IF lower(COALESCE(v_old_names[i],'')) != lower(COALESCE(p_person_names[i],'')) OR v_old_weights[i] != p_person_weights[i] THEN v_exact:=false; EXIT; END IF; END LOOP; IF v_exact THEN v_new_cur:=v_old_cur; ELSE v_new_cur:=array_fill(0::numeric, ARRAY[v_n]); FOR i IN 1..v_n LOOP v_found_idx:=NULL; FOR j IN 1..array_length(v_old_names,1) LOOP IF lower(v_old_names[j])=lower(p_person_names[i]) THEN v_found_idx:=j; EXIT; END IF; END LOOP; IF v_found_idx IS NOT NULL AND v_found_idx <= array_length(v_old_cur,1) THEN v_new_cur[i]:=v_old_cur[v_found_idx]; ELSE v_new_cur[i]:=0; END IF; END LOOP; SELECT sum(x) INTO v_sum FROM unnest(v_new_cur) x; IF v_sum IS NOT NULL AND v_sum !=0 THEN v_mean:=v_sum/v_n; FOR i IN 1..v_n LOOP v_new_cur[i]:=v_new_cur[i]-v_mean; END LOOP; END IF; END IF; END;
  ELSE
    IF v_old_names IS NOT NULL AND v_old_cur IS NOT NULL THEN
      v_new_cur:=array_fill(0::numeric, ARRAY[v_n]); FOR i IN 1..v_n LOOP v_found_idx:=NULL; IF v_old_names IS NOT NULL THEN FOR j IN 1..array_length(v_old_names,1) LOOP IF lower(v_old_names[j])=lower(p_person_names[i]) THEN v_found_idx:=j; EXIT; END IF; END LOOP; END IF; IF v_found_idx IS NOT NULL AND v_found_idx <= array_length(v_old_cur,1) THEN v_new_cur[i]:=v_old_cur[v_found_idx]; ELSE v_new_cur[i]:=0; END IF; END LOOP; SELECT sum(x) INTO v_sum FROM unnest(v_new_cur) x; IF v_sum IS NOT NULL AND v_sum !=0 THEN v_mean:=v_sum/v_n; FOR i IN 1..v_n LOOP v_new_cur[i]:=v_new_cur[i]-v_mean; END LOOP; END IF;
    ELSE v_new_cur:=array_fill(0::numeric, ARRAY[v_n]); END IF;
  END IF;
  FOR i IN 1..v_n LOOP v_new_cur[i]:=v_new_cur[i]+p_person_weights[i]; END LOOP;
  v_max:=v_new_cur[1]; v_picked:=1; FOR i IN 2..v_n LOOP IF v_new_cur[i] > v_max THEN v_max:=v_new_cur[i]; v_picked:=i; END IF; END LOOP;
  v_new_cur[v_picked]:=v_new_cur[v_picked]-v_total; v_picked_idx:=v_picked-1;
  INSERT INTO automation_assignment_picks (automation_id, account_id, contact_id, flow_run_id, log_id, step_key, person_name, person_index, percentage, message, message_type, media_url, tag_id)
  VALUES (p_automation_id, p_account_id, p_contact_id, p_flow_run_id, p_log_id, p_step_key, p_person_names[v_picked], v_picked_idx, p_person_percentages[v_picked], p_person_messages[v_picked], p_person_message_types[v_picked], NULLIF(p_person_media_urls[v_picked],''), (NULLIF(p_person_tag_ids[v_picked],''))::uuid)
  ON CONFLICT (automation_id, log_id, step_key) DO NOTHING;
  SELECT person_index INTO v_existing_idx FROM automation_assignment_picks WHERE automation_id = p_automation_id AND log_id = p_log_id AND step_key = p_step_key;
  IF v_existing_idx IS NOT NULL AND v_existing_idx != v_picked_idx THEN RETURN v_existing_idx; END IF;
  UPDATE automation_assignment_state SET person_names=p_person_names, person_weights=p_person_weights, current_weights=v_new_cur, updated_at=NOW() WHERE automation_id=p_automation_id AND step_key=p_step_key;
  RETURN v_picked_idx;
END;
$$;
