-- ============================================================
-- 075_dashboard_monthly_flows.sql — per-flow monthly uniques
--
-- Extends get_dashboard_analytics() (074) with a `monthlyFlows`
-- key so the "Month Wise Unique Contacts Messaged" chart can
-- render STACKED bars (one segment per flow) with a per-flow
-- hover tooltip — still inside the SAME single RPC, so the
-- browser still makes exactly ONE analytics request.
--
-- What changed vs 074:
--   - `conv_best` now also carries the picked run's `status`
--     and `started_at` (same DISTINCT ON pick — the range flow
--     breakdown is unaffected, it only reads flow_id).
--   - New CTE chain (year_mc -> mc_pairs -> mc_conv_pick ->
--     monthly_contact_flow -> monthly_flow_agg) attributes each
--     DISTINCT (month, contact) pair to exactly ONE flow with
--     the SAME rule as the range breakdown: conversation-exact
--     run first (newest active, else newest among the contact's
--     in-month conversations), else the contact's newest active
--     run, else the newest run.
--   - Contacts with no attributable run land in a NULL flow_id
--     bucket ("No flow" in the UI) so that, for every month,
--     SUM(flow segments) = monthly total. No contact is ever
--     counted in two flows within one month.
--   - `monthlyUniqueContacts` (the totals array) is UNCHANGED —
--     same CTE, same output. The chart keeps reading totals
--     from it, so totals cannot drift.
--
-- Security: unchanged (SECURITY INVOKER, account from
-- auth.uid(), no account_id param, authenticated-only grant).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_analytics(
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ,
  p_prev_start TIMESTAMPTZ,
  p_prev_end TIMESTAMPTZ,
  p_year_start TIMESTAMPTZ,
  p_year_end TIMESTAMPTZ,
  p_year INT,
  p_tz TEXT DEFAULT 'UTC'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_tz TEXT := 'UTC';
  v_result JSONB;
BEGIN
  -- Caller must be authenticated and linked to an account.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id INTO v_account_id
  FROM profiles p
  WHERE p.user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Trust but verify the timezone: an unknown name falls back
  -- to UTC rather than erroring the whole dashboard.
  IF p_tz IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_timezone_names WHERE name = p_tz
  ) THEN
    v_tz := p_tz;
  END IF;

  WITH
  -- Distinct conversations messaged in range (+ contact + count).
  msg_convs AS (
    SELECT
      m.conversation_id AS conv_id,
      c.contact_id AS contact_id,
      COUNT(*)::INT AS msg_count
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = v_account_id
      AND m.created_at >= p_start
      AND m.created_at < p_end
    GROUP BY m.conversation_id, c.contact_id
  ),
  -- Best flow run per conversation: newest active, else newest.
  -- status/started_at are carried for the monthly per-contact
  -- pick below; the range breakdown only reads flow_id.
  conv_best AS (
    SELECT DISTINCT ON (r.conversation_id)
      r.conversation_id AS conv_id,
      r.flow_id AS flow_id,
      r.status AS status,
      r.started_at AS started_at
    FROM flow_runs r
    JOIN flows f ON f.id = r.flow_id
    WHERE r.account_id = v_account_id
      AND f.account_id = v_account_id
      AND r.conversation_id IS NOT NULL
    ORDER BY
      r.conversation_id,
      (r.status = 'active') DESC,
      r.started_at DESC,
      r.id DESC
  ),
  -- Best flow run per contact: newest active, else newest.
  contact_best AS (
    SELECT DISTINCT ON (r.contact_id)
      r.contact_id AS contact_id,
      r.flow_id AS flow_id
    FROM flow_runs r
    JOIN flows f ON f.id = r.flow_id
    WHERE r.account_id = v_account_id
      AND f.account_id = v_account_id
      AND r.contact_id IS NOT NULL
    ORDER BY
      r.contact_id,
      (r.status = 'active') DESC,
      r.started_at DESC,
      r.id DESC
  ),
  -- Each in-range conversation attributed once (conv exact
  -- match first, else contact fallback). Unattributed stays
  -- NULL and is excluded from the breakdown, as before.
  attributed AS (
    SELECT
      mc.msg_count AS msg_count,
      mc.contact_id AS contact_id,
      COALESCE(cb.flow_id, ctb.flow_id) AS flow_id
    FROM msg_convs mc
    LEFT JOIN conv_best cb ON cb.conv_id = mc.conv_id
    LEFT JOIN contact_best ctb ON ctb.contact_id = mc.contact_id
  ),
  flow_agg AS (
    SELECT
      a.flow_id AS flow_id,
      MAX(f.name) AS flow_name,
      SUM(a.msg_count)::INT AS messages,
      COUNT(DISTINCT a.contact_id)::INT AS unique_contacts
    FROM attributed a
    JOIN flows f ON f.id = a.flow_id
    WHERE a.flow_id IS NOT NULL
      AND f.account_id = v_account_id
    GROUP BY a.flow_id
  ),
  -- Per-month distinct contacts for the year, bucketed in the
  -- caller's timezone (matches browser-local getMonth()).
  -- UNCHANGED from 074 — the chart totals read from here.
  monthly AS (
    SELECT
      EXTRACT(MONTH FROM (m.created_at AT TIME ZONE v_tz))::INT AS mth,
      COUNT(DISTINCT c.contact_id)::INT AS contacts
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = v_account_id
      AND c.contact_id IS NOT NULL
      AND m.created_at >= p_year_start
      AND m.created_at < p_year_end
      AND EXTRACT(YEAR FROM (m.created_at AT TIME ZONE v_tz))::INT = p_year
    GROUP BY 1
  ),
  -- Distinct (month, contact, conversation) triples in the year.
  -- Same filters as `monthly`, so every contact counted in the
  -- monthly total appears here exactly once per month.
  year_mc AS (
    SELECT DISTINCT
      EXTRACT(MONTH FROM (m.created_at AT TIME ZONE v_tz))::INT AS mth,
      c.contact_id AS contact_id,
      m.conversation_id AS conv_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = v_account_id
      AND c.contact_id IS NOT NULL
      AND m.created_at >= p_year_start
      AND m.created_at < p_year_end
      AND EXTRACT(YEAR FROM (m.created_at AT TIME ZONE v_tz))::INT = p_year
  ),
  mc_pairs AS (
    SELECT DISTINCT mth, contact_id FROM year_mc
  ),
  -- Per (month, contact): best conversation-exact flow among the
  -- contact's in-month conversations (newest active, else newest).
  mc_conv_pick AS (
    SELECT DISTINCT ON (ym.mth, ym.contact_id)
      ym.mth AS mth,
      ym.contact_id AS contact_id,
      cb.flow_id AS flow_id
    FROM year_mc ym
    JOIN conv_best cb ON cb.conv_id = ym.conv_id
    ORDER BY
      ym.mth,
      ym.contact_id,
      (cb.status = 'active') DESC,
      cb.started_at DESC,
      cb.flow_id
  ),
  -- Per (month, contact): exactly one flow — conv-exact first,
  -- else the contact-level pick. NULL when neither exists.
  monthly_contact_flow AS (
    SELECT
      p.mth AS mth,
      p.contact_id AS contact_id,
      COALESCE(cp.flow_id, ctb.flow_id) AS flow_id
    FROM mc_pairs p
    LEFT JOIN mc_conv_pick cp
      ON cp.mth = p.mth AND cp.contact_id = p.contact_id
    LEFT JOIN contact_best ctb
      ON ctb.contact_id = p.contact_id
  ),
  monthly_flow_agg AS (
    SELECT
      mcf.mth AS mth,
      mcf.flow_id AS flow_id,
      f.name AS flow_name,
      COUNT(DISTINCT mcf.contact_id)::INT AS contacts
    FROM monthly_contact_flow mcf
    LEFT JOIN flows f
      ON f.id = mcf.flow_id
      AND f.account_id = v_account_id
    GROUP BY mcf.mth, mcf.flow_id, f.name
  )
  SELECT jsonb_build_object(
    'kpis', jsonb_build_object(
      'totalMessages', jsonb_build_object(
        'current', (
          SELECT COUNT(*)::INT FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.account_id = v_account_id
            AND m.created_at >= p_start AND m.created_at < p_end
        ),
        'previous', (
          SELECT COUNT(*)::INT FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.account_id = v_account_id
            AND m.created_at >= p_prev_start AND m.created_at < p_prev_end
        )
      ),
      'uniqueContacts', jsonb_build_object(
        'current', (
          SELECT COUNT(DISTINCT c.contact_id)::INT FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.account_id = v_account_id
            AND c.contact_id IS NOT NULL
            AND m.created_at >= p_start AND m.created_at < p_end
        ),
        'previous', (
          SELECT COUNT(DISTINCT c.contact_id)::INT FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.account_id = v_account_id
            AND c.contact_id IS NOT NULL
            AND m.created_at >= p_prev_start AND m.created_at < p_prev_end
        )
      ),
      'newContacts', jsonb_build_object(
        'current', (
          SELECT COUNT(*)::INT FROM contacts
          WHERE account_id = v_account_id
            AND created_at >= p_start AND created_at < p_end
        ),
        'previous', (
          SELECT COUNT(*)::INT FROM contacts
          WHERE account_id = v_account_id
            AND created_at >= p_prev_start AND created_at < p_prev_end
        )
      ),
      'newConversations', jsonb_build_object(
        'current', (
          SELECT COUNT(*)::INT FROM conversations
          WHERE account_id = v_account_id
            AND created_at >= p_start AND created_at < p_end
        ),
        'previous', (
          SELECT COUNT(*)::INT FROM conversations
          WHERE account_id = v_account_id
            AND created_at >= p_prev_start AND created_at < p_prev_end
        )
      )
    ),
    'flowBreakdown', jsonb_build_object(
      'totalMessages', (
        SELECT COALESCE(SUM(msg_count), 0)::INT FROM msg_convs
      ),
      'rows', COALESCE((
        SELECT jsonb_agg(item ORDER BY (item->>'messages')::INT DESC)
        FROM (
          SELECT jsonb_build_object(
            'flowId', fa.flow_id,
            'flowName', fa.flow_name,
            'messages', fa.messages,
            'uniqueContacts', fa.unique_contacts,
            'pct', CASE
              WHEN (SELECT COALESCE(SUM(msg_count), 0) FROM msg_convs) > 0
              THEN (fa.messages::DOUBLE PRECISION
                / (SELECT COALESCE(SUM(msg_count), 0)::DOUBLE PRECISION FROM msg_convs)) * 100
              ELSE 0
            END
          ) AS item
          FROM flow_agg fa
          WHERE fa.messages > 0
        ) s
      ), '[]'::JSONB)
    ),
    'monthlyUniqueContacts', (
      SELECT COALESCE(jsonb_agg(v ORDER BY ord), '[]'::JSONB)
      FROM (
        SELECT
          gs.mth AS ord,
          COALESCE(mo.contacts, 0) AS v
        FROM generate_series(1, 12) AS gs(mth)
        LEFT JOIN monthly mo ON mo.mth = gs.mth
      ) s
    ),
    'monthlyFlows', (
      SELECT COALESCE(jsonb_agg(m ORDER BY (m->>'month')::INT), '[]'::JSONB)
      FROM (
        SELECT jsonb_build_object(
          'month', gs.mth,
          'total', COALESCE(mo.contacts, 0),
          'flows', COALESCE((
            SELECT jsonb_agg(item ORDER BY (item->>'uniqueContacts')::INT DESC)
            FROM (
              SELECT jsonb_build_object(
                'flowId', mfa.flow_id,
                'flowName', COALESCE(mfa.flow_name, 'No flow'),
                'uniqueContacts', mfa.contacts
              ) AS item
              FROM monthly_flow_agg mfa
              WHERE mfa.mth = gs.mth
            ) s2
          ), '[]'::JSONB)
        ) AS m
        FROM generate_series(1, 12) AS gs(mth)
        LEFT JOIN monthly mo ON mo.mth = gs.mth
      ) s
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.get_dashboard_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_dashboard_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_dashboard_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) TO authenticated;
