-- ============================================================
-- 084_flow_tables.sql — Workspace foundation: per-flow completion
-- point + server-side flow-table rows.
--
-- Part 1: flows.completion_node_id
--   Nullable TEXT referencing flow_nodes.node_key (the stable
--   per-flow node identity — NOT the uuid id). NULL = no custom
--   point → the END node decides completion (backwards compatible).
--   Deliberately NO database FK: PUT /api/flows/:id rewrites
--   flow_nodes delete-then-insert, so a composite FK would reject
--   valid saves mid-rewrite. The API validates the key against the
--   flow's nodes instead. One scalar column = at most one custom
--   completion point per flow, enforced by shape.
--
-- Part 2: get_flow_table_rows()
--   One paginated, server-filtered read over the EXISTING
--   flow_runs (+ contacts + flow_run_events) — no data duplication,
--   no per-flow tables. SECURITY INVOKER: the account comes from
--   auth.uid(), and the flow must belong to that account.
--   Completion reach comes from flow_run_events (node_entered on
--   the configured node); the function returns the raw reach
--   timestamp and the caller classifies Completed / Incomplete.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS completion_node_id TEXT DEFAULT NULL;

COMMENT ON COLUMN public.flows.completion_node_id IS
  'Workspace table classification point: flow_nodes.node_key that marks a run COMPLETED when reached. NULL = END node decides. Intentionally no FK (node rewrite ordering); validated in the API.';

CREATE OR REPLACE FUNCTION public.get_flow_table_rows(
  p_flow_id UUID,
  p_view TEXT DEFAULT 'all',
  p_search TEXT DEFAULT NULL,
  p_page INT DEFAULT 0,
  p_page_size INT DEFAULT 25
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_flow RECORD;
  v_page INT := GREATEST(COALESCE(p_page, 0), 0);
  v_page_size INT := LEAST(GREATEST(COALESCE(p_page_size, 25), 1), 100);
  v_offset INT;
  v_search TEXT := NULLIF(BTRIM(COALESCE(p_search, '')), '');
  v_result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id INTO v_account_id
  FROM profiles p
  WHERE p.user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  SELECT f.id, f.account_id, f.name, f.completion_node_id
  INTO v_flow
  FROM flows f
  WHERE f.id = p_flow_id;

  IF v_flow.id IS NULL OR v_flow.account_id IS DISTINCT FROM v_account_id THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_view IS NOT NULL AND p_view NOT IN ('all', 'completed', 'incomplete') THEN
    RAISE EXCEPTION 'Invalid view (all|completed|incomplete)' USING ERRCODE = '22023';
  END IF;

  v_offset := v_page * v_page_size;

  WITH base AS (
    SELECT
      r.id AS run_id,
      r.contact_id AS contact_id,
      c.name AS contact_name,
      c.phone AS contact_phone,
      r.conversation_id AS conversation_id,
      r.status AS status,
      r.started_at AS started_at,
      r.last_advanced_at AS last_advanced_at,
      r.ended_at AS ended_at,
      r.vars AS vars,
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN (
          SELECT MAX(e.created_at)
          FROM flow_run_events e
          WHERE e.flow_run_id = r.id
            AND e.node_key = v_flow.completion_node_id
        )
        ELSE NULL
      END AS reached_at
    FROM flow_runs r
    LEFT JOIN contacts c ON c.id = r.contact_id
    WHERE r.flow_id = p_flow_id
      AND r.account_id = v_account_id
      AND (
        v_search IS NULL
        OR c.name ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR c.phone ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
  ),
  classified AS (
    SELECT
      b.*,
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN (b.reached_at IS NOT NULL)
        ELSE (b.status = 'completed')
      END AS is_completed
    FROM base b
  ),
  filtered AS (
    SELECT c.*
    FROM classified c
    WHERE p_view IS NULL OR p_view = 'all'
      OR (p_view = 'completed' AND c.is_completed)
      OR (p_view = 'incomplete' AND NOT c.is_completed)
  )
  SELECT jsonb_build_object(
    'flow', jsonb_build_object(
      'id', v_flow.id,
      'name', v_flow.name,
      'completion_node_id', v_flow.completion_node_id
    ),
    'total', (SELECT COUNT(*)::INT FROM filtered),
    'page', v_page,
    'page_size', v_page_size,
    'rows', COALESCE((
      SELECT jsonb_agg(row ORDER BY row_started, row_id)
      FROM (
        SELECT jsonb_build_object(
          'run_id', f.run_id,
          'contact_id', f.contact_id,
          'contact_name', f.contact_name,
          'contact_phone', f.contact_phone,
          'conversation_id', f.conversation_id,
          'status', f.status,
          'started_at', f.started_at,
          'last_advanced_at', f.last_advanced_at,
          'ended_at', f.ended_at,
          'reached_at', f.reached_at,
          'is_completed', f.is_completed,
          'vars', COALESCE(f.vars, '{}'::JSONB)
        ) AS row,
        f.started_at AS row_started,
        f.run_id AS row_id
        FROM filtered f
        ORDER BY f.started_at DESC, f.run_id DESC
        LIMIT v_page_size OFFSET v_offset
      ) s
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
