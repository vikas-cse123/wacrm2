-- ============================================================
-- 087_workspace_table_ordering.sql — view-dependent Workspace ordering
--
-- Problem: get_flow_table_rows() (084) ordered every view by
-- started_at, and worse, the page-selection subquery ordered DESC
-- while the outer jsonb_agg re-sorted ASC — so the Completed view
-- showed the oldest runs first instead of the newest completed
-- run at the top.
--
-- Fix (ordering only — no schema, classification, or API change):
--   - completed view: real completion timestamp DESC —
--     reached_at when a custom completion point is configured
--     (the timestamp the configured node was reached), else
--     ended_at (the existing END-completion timestamp).
--   - incomplete view: newest activity first —
--     COALESCE(last_advanced_at, started_at) DESC.
--   - all view: unchanged started_at DESC (previous behavior).
--   - Deterministic run_id DESC tiebreak everywhere.
--   - NULLS LAST on every timestamp key so missing values never
--     surface first.
--   - The jsonb_agg row ordering now mirrors the page-selection
--     ordering exactly, so page 1 holds the newest N rows for any
--     page size (25/50/75/100), search, flow, or view.
--
-- Security: unchanged (SECURITY INVOKER, account from auth.uid(),
-- flow must belong to that account).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

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
      END AS is_completed,
      -- Real completion timestamp: custom-point reach time, else
      -- the END-completion timestamp. Used only by the completed
      -- view ordering below.
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN b.reached_at
        ELSE b.ended_at
      END AS completed_sort,
      -- Newest activity with submission fallback. Used only by
      -- the incomplete view ordering below.
      COALESCE(b.last_advanced_at, b.started_at) AS activity_sort
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
      SELECT jsonb_agg(
        row
        ORDER BY
          CASE WHEN p_view = 'completed' THEN row_completed END DESC NULLS LAST,
          CASE WHEN p_view = 'incomplete' THEN row_activity END DESC NULLS LAST,
          CASE WHEN p_view NOT IN ('completed', 'incomplete') THEN row_started END DESC NULLS LAST,
          row_id DESC
      )
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
        f.completed_sort AS row_completed,
        f.activity_sort AS row_activity,
        f.started_at AS row_started,
        f.run_id AS row_id
        FROM filtered f
        ORDER BY
          CASE WHEN p_view = 'completed' THEN f.completed_sort END DESC NULLS LAST,
          CASE WHEN p_view = 'incomplete' THEN f.activity_sort END DESC NULLS LAST,
          CASE WHEN p_view NOT IN ('completed', 'incomplete') THEN f.started_at END DESC NULLS LAST,
          f.run_id DESC
        LIMIT v_page_size OFFSET v_offset
      ) s
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
