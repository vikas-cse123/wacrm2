-- ============================================================
-- 109_call_kpis_summary.sql — exact server-side KPI aggregation
-- for GET /api/calls/stats (the /calls dashboard cards).
--
-- Why this exists: the six KPI cards used to derive from a
-- bounded JS fetch (MAX_ROWS 5000 per window), so any account
-- with more than 5000 recordings in the window got silently
-- under-counted cards. This function computes the six numbers
-- in ONE indexed scan with no row cap — mathematically exact
-- for any number of matches.
--
-- Returned keys (null durations mean "nothing measured", which
-- the UI renders as "—"; counts are never null):
--   total, durationSecs, incoming, incomingDurationSecs,
--   outgoing, outgoingDurationSecs.
--
-- Predicates mirror the endpoint exactly (same AND-group):
--   p_from / p_to — half-open [from, to) over EFFECTIVE time
--     (recorded_at ?? created_at).
--   p_uploaded_by  — auth user id, or NULL for everyone.
--   p_direction    — 'in' | 'out' equality, or NULL for all
--     directions (NULL-direction rows included, never guessed).
-- NULL direction rows count toward total/duration but toward
-- neither side — the same rule as the list endpoint.
--
-- Security: SECURITY INVOKER, so the caller's RLS applies. The
-- caller must additionally be a member of p_account_id
-- (is_account_member, any role — mirrors the SELECT policy's
-- viewer+), and every row is explicitly scoped to p_account_id.
--
-- Grants: EXECUTE to `authenticated` only (same as the other
-- read-model RPCs). Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.call_kpis_summary(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_uploaded_by UUID DEFAULT NULL,
  p_direction TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_account_id IS NULL OR NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'total', COUNT(*),
    'durationSecs', SUM(duration_seconds),
    'incoming', COUNT(*) FILTER (WHERE direction = 'in'),
    'incomingDurationSecs', SUM(duration_seconds) FILTER (WHERE direction = 'in'),
    'outgoing', COUNT(*) FILTER (WHERE direction = 'out'),
    'outgoingDurationSecs', SUM(duration_seconds) FILTER (WHERE direction = 'out')
  )
  INTO v_result
  FROM call_recordings
  WHERE account_id = p_account_id
    AND (p_uploaded_by IS NULL OR uploaded_by = p_uploaded_by)
    AND (p_direction IS NULL OR direction = p_direction)
    AND (
      (recorded_at >= p_from AND recorded_at < p_to)
      OR (recorded_at IS NULL AND created_at >= p_from AND created_at < p_to)
    );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_kpis_summary(
  UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT
) TO authenticated;
