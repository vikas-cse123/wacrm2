-- ============================================================
-- 108_call_recordings_summary.sql — exact server-side summary
-- aggregation for GET /api/recordings?summary=1.
--
-- Why this exists: the summary used to page up to 5000 rows into
-- JS and aggregate there, so any account with more than 5000
-- recordings matching the filters got silently TRUNCATED metrics
-- (totals capped, duration under-summed). This function computes
-- all six metrics in ONE indexed scan with no row cap, so the
-- result is mathematically exact for any number of matches.
--
-- Predicates mirror the list endpoint exactly (same AND-group):
--   p_contact_id   — one lead's recordings (lead view).
--   p_contact_ids  — text-search lead candidates; NULL = no
--     search filter, EMPTY ARRAY = search matched nothing (and
--     like the list endpoint, matches nothing — never the
--     unfiltered set).
--   p_digits       — digit string; recording phone_number ILIKE.
--     The two search halves are ORed, ANDed with everything else.
--   p_from / p_to  — half-open [from, to) over EFFECTIVE time
--     (recorded_at ?? created_at), same rule as the list.
--   p_call_type    — phone | whatsapp | whatsapp_business.
--   p_direction    — in | out | unknown (unknown = IS NULL, never
--     folded into in/out).
--   p_uploaded_by  — auth user id.
--   p_status       — linked (contact_id IS NOT NULL) | unlinked
--     (contact_id IS NULL).
--
-- Security: SECURITY INVOKER, so the caller's RLS applies. The
-- caller must additionally be a member of p_account_id
-- (is_account_member, any role — mirrors the SELECT policy's
-- viewer+), and every row is explicitly scoped to p_account_id,
-- so a foreign account id matches zero rows, never an error
-- oracle beyond the membership check the list endpoint shares.
--
-- Grants: EXECUTE to `authenticated` only (same as the other
-- read-model RPCs). Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.call_recordings_summary(
  p_account_id UUID,
  p_contact_id UUID DEFAULT NULL,
  p_contact_ids UUID[] DEFAULT NULL,
  p_digits TEXT DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_call_type TEXT DEFAULT NULL,
  p_direction TEXT DEFAULT NULL,
  p_uploaded_by UUID DEFAULT NULL,
  p_status TEXT DEFAULT NULL
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
    'totalDurationSecs', COALESCE(SUM(duration_seconds), 0),
    'phone', COUNT(*) FILTER (WHERE call_type = 'phone'),
    'whatsapp', COUNT(*) FILTER (WHERE call_type = 'whatsapp'),
    'whatsappBusiness', COUNT(*) FILTER (WHERE call_type = 'whatsapp_business'),
    'unlinked', COUNT(*) FILTER (WHERE contact_id IS NULL)
  )
  INTO v_result
  FROM call_recordings
  WHERE account_id = p_account_id
    AND (p_contact_id IS NULL OR contact_id = p_contact_id)
    AND (p_call_type IS NULL OR call_type = p_call_type)
    AND (
      p_direction IS NULL
      OR (p_direction IN ('in', 'out') AND direction = p_direction)
      OR (p_direction = 'unknown' AND direction IS NULL)
    )
    AND (p_uploaded_by IS NULL OR uploaded_by = p_uploaded_by)
    AND (
      p_status IS NULL
      OR (p_status = 'linked' AND contact_id IS NOT NULL)
      OR (p_status = 'unlinked' AND contact_id IS NULL)
    )
    AND (
      p_from IS NULL OR p_to IS NULL
      OR (
        (recorded_at >= p_from AND recorded_at < p_to)
        OR (recorded_at IS NULL AND created_at >= p_from AND created_at < p_to)
      )
    )
    AND (
      p_contact_ids IS NULL AND p_digits IS NULL
      OR (
        (p_contact_ids IS NOT NULL AND contact_id = ANY (p_contact_ids))
        OR (p_digits IS NOT NULL AND phone_number ILIKE '%' || p_digits || '%')
      )
    );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_recordings_summary(
  UUID, UUID, UUID[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) TO authenticated;
