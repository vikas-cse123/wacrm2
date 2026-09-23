-- ============================================================
-- 082_dashboard_daily_flows.sql — per-day flow split for the daily chart
--
-- Problem: "Contacts Messaged — Last 30 Days" shows one number per
-- day with no flow composition, while the monthly chart stacks each
-- month by flow. This adds the same per-period flow attribution at
-- day grain so the daily chart can stack identically.
--
-- What changed vs 081 (CREATE OR REPLACE — no schema change, same
-- signature, same security posture: SECURITY INVOKER, account from
-- auth.uid(), authenticated-only grant):
--   - `daily_msg` now also carries the conversation id so the
--     conversation-exact pick can see in-day conversations.
--   - New CTE chain (daily_pairs -> daily_conv_pick ->
--     daily_contact_flow -> daily_flow_agg): each DISTINCT
--     (day, contact) pair is attributed to exactly ONE flow with
--     the SAME rule as the monthly chain (conversation-exact run
--     first — newest active, else newest among the contact's
--     in-day conversations — else the contact's newest active run,
--     else newest run). NULL stays NULL ("No flow" in the UI), so
--     for every day SUM(flow segments) = that day's total. One
--     contact with ten messages on a day counts once.
--   - New `dailyFlows` key: 30 entries {date, total, flows[]}
--     (flows: {flowId, flowName, uniqueContacts} — the same shape
--     as `monthlyFlows` so the client reuses its model).
--   - Everything else (KPIs, flow/month/ad breakdowns, daily
--     totals, monthly keys) is byte-identical to 081.
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
  -- Distinct contacts messaged in range (NULL contact ignored,
  -- same as the uniqueContacts KPI).
  range_contacts AS (
    SELECT DISTINCT mc.contact_id AS contact_id
    FROM msg_convs mc
    WHERE mc.contact_id IS NOT NULL
  ),
  -- Per contact: best conversation-exact flow among the contact's
  -- in-range conversations (newest active, else newest). Same
  -- pick rule as the monthly per-(month, contact) logic.
  range_conv_pick AS (
    SELECT DISTINCT ON (mc.contact_id)
      mc.contact_id AS contact_id,
      cb.flow_id AS flow_id
    FROM msg_convs mc
    JOIN conv_best cb ON cb.conv_id = mc.conv_id
    WHERE mc.contact_id IS NOT NULL
    ORDER BY
      mc.contact_id,
      (cb.status = 'active') DESC,
      cb.started_at DESC,
      cb.flow_id
  ),
  -- Per contact: exactly one flow — conv-exact first, else the
  -- contact-level pick. NULL when neither exists ("No flow").
  range_contact_flow AS (
    SELECT
      rc.contact_id AS contact_id,
      COALESCE(cp.flow_id, ctb.flow_id) AS flow_id
    FROM range_contacts rc
    LEFT JOIN range_conv_pick cp
      ON cp.contact_id = rc.contact_id
    LEFT JOIN contact_best ctb
      ON ctb.contact_id = rc.contact_id
  ),
  range_flow_agg AS (
    SELECT
      rcf.flow_id AS flow_id,
      COALESCE(MAX(f.name), 'No flow') AS flow_name,
      COUNT(*)::INT AS contacts
    FROM range_contact_flow rcf
    LEFT JOIN flows f
      ON f.id = rcf.flow_id
      AND f.account_id = v_account_id
    GROUP BY rcf.flow_id
  ),
  -- Distinct contacts messaged in range with their stored
  -- first-touch ad URL (one row per contact — the URL is a
  -- contact attribute, so DISTINCT keeps the contact grain).
  range_ad_contacts AS (
    SELECT DISTINCT
      mc.contact_id AS contact_id,
      ct.source_url AS source_url
    FROM msg_convs mc
    JOIN contacts ct ON ct.id = mc.contact_id
    WHERE mc.contact_id IS NOT NULL
      AND ct.account_id = v_account_id
  ),
  -- Top ad URLs by contacts (blank URLs excluded here — they
  -- fall into '__no_ad__' below, never into '__other__').
  ad_top AS (
    SELECT rac.source_url AS source_url
    FROM range_ad_contacts rac
    WHERE rac.source_url IS NOT NULL
      AND btrim(rac.source_url) <> ''
    GROUP BY rac.source_url
    ORDER BY COUNT(*) DESC, rac.source_url
    LIMIT 8
  ),
  -- Per contact: exactly one ad bucket.
  ad_buckets AS (
    SELECT
      rac.contact_id AS contact_id,
      CASE
        WHEN rac.source_url IS NULL OR btrim(rac.source_url) = ''
          THEN '__no_ad__'
        WHEN t.source_url IS NOT NULL THEN rac.source_url
        ELSE '__other__'
      END AS ad_key
    FROM range_ad_contacts rac
    LEFT JOIN ad_top t ON t.source_url = rac.source_url
  ),
  -- Trailing-30-day window in the caller's timezone (today
  -- included). Boundaries are converted back to instants for the
  -- message range scan so the index on messages.created_at applies.
  daily_bounds AS (
    SELECT
      ((now() AT TIME ZONE v_tz)::date - 29) AS d_from,
      ((now() AT TIME ZONE v_tz)::date) AS d_to
  ),
  -- Distinct (day, contact, conversation) triples in the window:
  -- one contact with ten messages on a day counts once for that
  -- day, and the conversation id feeds the flow pick below.
  daily_msg AS (
    SELECT DISTINCT
      (m.created_at AT TIME ZONE v_tz)::date AS day,
      c.contact_id AS contact_id,
      m.conversation_id AS conv_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    CROSS JOIN daily_bounds b
    WHERE c.account_id = v_account_id
      AND c.contact_id IS NOT NULL
      AND m.created_at >= (b.d_from AT TIME ZONE v_tz)
      AND m.created_at < ((b.d_to + 1) AT TIME ZONE v_tz)
  ),
  daily_pairs AS (
    SELECT DISTINCT day, contact_id FROM daily_msg
  ),
  -- Per (day, contact): best conversation-exact flow among the
  -- contact's in-day conversations (newest active, else newest).
  daily_conv_pick AS (
    SELECT DISTINCT ON (dm.day, dm.contact_id)
      dm.day AS day,
      dm.contact_id AS contact_id,
      cb.flow_id AS flow_id
    FROM daily_msg dm
    JOIN conv_best cb ON cb.conv_id = dm.conv_id
    ORDER BY
      dm.day,
      dm.contact_id,
      (cb.status = 'active') DESC,
      cb.started_at DESC,
      cb.flow_id
  ),
  -- Per (day, contact): exactly one flow — conv-exact first,
  -- else the contact-level pick. NULL when neither exists.
  daily_contact_flow AS (
    SELECT
      p.day AS day,
      p.contact_id AS contact_id,
      COALESCE(cp.flow_id, ctb.flow_id) AS flow_id
    FROM daily_pairs p
    LEFT JOIN daily_conv_pick cp
      ON cp.day = p.day AND cp.contact_id = p.contact_id
    LEFT JOIN contact_best ctb
      ON ctb.contact_id = p.contact_id
  ),
  daily_flow_agg AS (
    SELECT
      dcf.day AS day,
      dcf.flow_id AS flow_id,
      f.name AS flow_name,
      COUNT(DISTINCT dcf.contact_id)::INT AS contacts
    FROM daily_contact_flow dcf
    LEFT JOIN flows f
      ON f.id = dcf.flow_id
      AND f.account_id = v_account_id
    GROUP BY dcf.day, dcf.flow_id, f.name
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
      )
    ),
    'flowBreakdown', jsonb_build_object(
      'totalContacts', (
        SELECT COUNT(*)::INT FROM range_contacts
      ),
      'rows', COALESCE((
        SELECT jsonb_agg(item ORDER BY (item->>'contacts')::INT DESC)
        FROM (
          SELECT jsonb_build_object(
            'flowId', fa.flow_id,
            'flowName', fa.flow_name,
            'contacts', fa.contacts,
            'pct', CASE
              WHEN (SELECT COUNT(*) FROM range_contacts) > 0
              THEN (fa.contacts::DOUBLE PRECISION
                / (SELECT COUNT(*)::DOUBLE PRECISION FROM range_contacts)) * 100
              ELSE 0
            END
          ) AS item
          FROM range_flow_agg fa
          WHERE fa.contacts > 0
        ) s
      ), '[]'::JSONB)
    ),
    'contactsByAd', jsonb_build_object(
      'totalContacts', (
        SELECT COUNT(*)::INT FROM range_ad_contacts
      ),
      'rows', COALESCE((
        SELECT jsonb_agg(
          item
          ORDER BY
            (item->>'adKey' = '__no_ad__'),
            (item->>'contacts')::INT DESC
        )
        FROM (
          SELECT jsonb_build_object(
            'adKey', b.ad_key,
            'adLabel', CASE b.ad_key
              WHEN '__no_ad__' THEN 'No Ad'
              WHEN '__other__' THEN 'Other'
              ELSE b.ad_key
            END,
            'contacts', COUNT(*)::INT,
            'pct', CASE
              WHEN (SELECT COUNT(*) FROM range_ad_contacts) > 0
              THEN (COUNT(*)::DOUBLE PRECISION
                / (SELECT COUNT(*)::DOUBLE PRECISION FROM range_ad_contacts)) * 100
              ELSE 0
            END
          ) AS item
          FROM ad_buckets b
          GROUP BY b.ad_key
          HAVING COUNT(*) > 0
        ) s
      ), '[]'::JSONB)
    ),
    'dailyContacts', (
      SELECT COALESCE(jsonb_agg(d ORDER BY (d->>'date')), '[]'::JSONB)
      FROM (
        SELECT jsonb_build_object(
          'date', gs.day::TEXT,
          'contacts', COUNT(DISTINCT dm.contact_id)::INT
        ) AS d
        FROM (
          SELECT generate_series(b.d_from, b.d_to, '1 day'::interval)::date AS day
          FROM daily_bounds b
        ) gs
        LEFT JOIN daily_msg dm ON dm.day = gs.day
        GROUP BY gs.day
      ) s
    ),
    'dailyFlows', (
      SELECT COALESCE(jsonb_agg(d ORDER BY (d->>'date')), '[]'::JSONB)
      FROM (
        SELECT jsonb_build_object(
          'date', gs.day::TEXT,
          'total', COUNT(DISTINCT dcf.contact_id)::INT,
          'flows', COALESCE((
            SELECT jsonb_agg(item ORDER BY (item->>'uniqueContacts')::INT DESC)
            FROM (
              SELECT jsonb_build_object(
                'flowId', dfa.flow_id,
                'flowName', COALESCE(dfa.flow_name, 'No flow'),
                'uniqueContacts', dfa.contacts
              ) AS item
              FROM daily_flow_agg dfa
              WHERE dfa.day = gs.day
            ) s2
          ), '[]'::JSONB)
        ) AS d
        FROM (
          SELECT generate_series(b.d_from, b.d_to, '1 day'::interval)::date AS day
          FROM daily_bounds b
        ) gs
        LEFT JOIN daily_contact_flow dcf ON dcf.day = gs.day
        GROUP BY gs.day
      ) s
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
