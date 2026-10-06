-- ============================================================
-- 111_call_event_outcomes_summary.sql — exact server-side
-- Missed / Rejected aggregation for GET /api/calls/stats.
--
-- Counts phone call-events by outcome in ONE indexed scan with
-- no row cap — mathematically exact for any number of matches,
-- following the same pattern as 108/109. Only `phone` events
-- can exist (migration 110 CHECK), so no call-type predicate is
-- needed; WhatsApp outcomes are never synthesized.
--
-- Predicates mirror the endpoint exactly (same AND-group):
--   p_from / p_to — half-open [from, to) over `occurred_at`
--     (the CallLog timestamp — always present, no fallback).
--   p_user_id    — event uploader, or NULL for everyone.
--   p_direction  — 'in' | 'out' equality, or NULL for all.
--     (Missed/rejected are inherently incoming, so an
--     Outgoing filter correctly yields zero — same behavior as
--     the recording directional metrics under a direction
--     filter.)
--
-- Security: SECURITY INVOKER, so the caller's RLS applies. The
-- caller must additionally be a member of p_account_id
-- (is_account_member, any role — mirrors the SELECT policy's
-- viewer+), and every row is explicitly scoped to p_account_id.
--
-- Grants: EXECUTE to `authenticated` only (same as the other
-- read-model RPCs). Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.call_event_outcomes_summary(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_user_id UUID DEFAULT NULL,
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
    'missed', COUNT(*) FILTER (WHERE outcome = 'missed'),
    'rejected', COUNT(*) FILTER (WHERE outcome = 'rejected')
  )
  INTO v_result
  FROM call_events
  WHERE account_id = p_account_id
    AND (p_user_id IS NULL OR user_id = p_user_id)
    AND (p_direction IS NULL OR direction = p_direction)
    AND occurred_at >= p_from
    AND occurred_at < p_to;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_event_outcomes_summary(
  UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT
) TO authenticated;
