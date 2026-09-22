-- ============================================================
-- 078_inbox_search.sql — server-side paginated Inbox search
--
-- Problem: Inbox search was client-side over one unbounded fetch —
-- conversations outside the loaded window were unsearchable, and
-- phone search used the raw `phone` column only.
--
-- Fix: one SECURITY INVOKER RPC returning ordered conversation IDs
-- (keyset-paginated) for the browser to hydrate via the existing
-- CONVERSATION_SELECT. The browser makes ONE request per search
-- page; the DB does the matching.
--
-- Scope parity with the old client filter (ANDed):
--   - text: contact name / raw phone / normalized phone /
--     last_message_text (ILIKE; email/company NOT searched — the
--     old client never searched them either).
--   - status: all/unread/open/pending/closed.
--   - tags (OR across tag ids), company (trimmed exact),
--     flow (contact's resolved flow, incl. '__no_flow__'),
--     team (assigned_agent_id incl. 'unassigned'), date range.
-- Flow resolution mirrors pickContactFlowRun exactly:
-- conversation-exact run first (newest active, else newest), else
-- the contact's newest active run, else the newest run — runs
-- without a readable flow are skipped.
--
-- Security:
--   - SECURITY INVOKER: RLS applies as the caller.
--   - NO account_id parameter: the account comes from
--     profiles.user_id = auth.uid(); every table is additionally
--     filtered to it. Cross-account search is impossible.
--   - LIKE wildcards in the query are escaped; digit matching uses
--     the generated contacts.phone_normalized column.
--   - GRANT EXECUTE to `authenticated` only.
--
-- Ordering (matches the Inbox list): last_message_at DESC
-- NULLS FIRST, id DESC tiebreak (PostgREST has no tiebreaker, so
-- this only makes the existing order deterministic for paging).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Composite for the account scope + keyset order. All other joins
-- hit PKs (contacts.id, flows.id) or existing indexes
-- (contact_tags.contact_id, conversations.contact_id). Leading-%LIKE
-- matches can't use btree — acceptable at inbox scale; revisit with
-- pg_trgm only if search latency demands it.
CREATE INDEX IF NOT EXISTS idx_conversations_account_lastmsg
  ON conversations(account_id, last_message_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.search_inbox_conversations(
  p_search TEXT,
  p_status TEXT DEFAULT 'all',
  p_tag_ids UUID[] DEFAULT '{}',
  p_company TEXT DEFAULT NULL,
  p_flow_id TEXT DEFAULT NULL,
  p_member_ids TEXT[] DEFAULT '{}',
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_cur_ts TIMESTAMPTZ DEFAULT NULL,
  p_cur_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 25
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_q TEXT;
  v_qesc TEXT;
  v_digits TEXT;
  v_limit INT;
  v_ids UUID[];
  v_has_more BOOLEAN;
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

  -- Empty queries match nothing (the client never sends them; this
  -- just makes the function total instead of surprising).
  v_q := btrim(COALESCE(p_search, ''));
  IF v_q = '' THEN
    RETURN jsonb_build_object('ids', '[]'::JSONB, 'has_more', false);
  END IF;

  -- Escape LIKE metacharacters so '+', '%', '_' etc. are literal.
  v_qesc := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  -- Digits-only form for phone_normalized (mirrors normalizePhone).
  v_digits := NULLIF(regexp_replace(v_q, '\D', '', 'g'), '');

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);

  WITH matches AS (
    SELECT c.id AS id, c.last_message_at AS last_message_at
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.account_id = v_account_id
      AND ct.account_id = v_account_id
      -- Status facet (mirrors the client filter exactly).
      AND (
        p_status IS NULL OR p_status = 'all'
        OR (p_status = 'unread' AND c.unread_count > 0)
        OR (p_status <> 'unread' AND p_status <> 'all' AND c.status = p_status)
      )
      -- Tags facet (OR across ids).
      AND (
        COALESCE(cardinality(p_tag_ids), 0) = 0
        OR EXISTS (
          SELECT 1 FROM contact_tags t
          WHERE t.contact_id = c.contact_id
            AND t.tag_id = ANY (p_tag_ids)
        )
      )
      -- Company facet (client compares trimmed contact company).
      AND (p_company IS NULL OR btrim(ct.company) = p_company)
      -- Flow facet (same resolution as pickContactFlowRun).
      AND (
        p_flow_id IS NULL
        OR COALESCE(
          (
            SELECT r.flow_id
            FROM flow_runs r
            JOIN flows f ON f.id = r.flow_id
            WHERE r.account_id = v_account_id
              AND f.account_id = v_account_id
              AND r.conversation_id = c.id
            ORDER BY (r.status = 'active') DESC, r.started_at DESC, r.id DESC
            LIMIT 1
          ),
          (
            SELECT r.flow_id
            FROM flow_runs r
            JOIN flows f ON f.id = r.flow_id
            WHERE r.account_id = v_account_id
              AND f.account_id = v_account_id
              AND r.contact_id = c.contact_id
            ORDER BY (r.status = 'active') DESC, r.started_at DESC, r.id DESC
            LIMIT 1
          )
        ) IS NOT DISTINCT FROM CASE
          WHEN p_flow_id = '__no_flow__' THEN NULL::UUID
          ELSE p_flow_id::UUID
        END
      )
      -- Team facet ('unassigned' member = NULL agent).
      AND (
        COALESCE(cardinality(p_member_ids), 0) = 0
        OR c.assigned_agent_id::TEXT = ANY (p_member_ids)
        OR ('unassigned' = ANY (p_member_ids) AND c.assigned_agent_id IS NULL)
      )
      -- Date facet (inclusive both ends, like the client range).
      AND (p_from IS NULL OR c.last_message_at >= p_from)
      AND (p_to IS NULL OR c.last_message_at <= p_to)
      -- Text match: name / raw phone / normalized phone / last message.
      AND (
        c.last_message_text ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR ct.name ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR ct.phone ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR (
          v_digits IS NOT NULL
          AND ct.phone_normalized ILIKE '%' || v_digits || '%' ESCAPE '\'
        )
      )
      -- Keyset: strictly past the cursor under
      -- (last_message_at DESC NULLS FIRST, id DESC).
      AND (
        p_cur_id IS NULL
        OR (p_cur_ts IS NULL AND c.last_message_at IS NULL AND c.id < p_cur_id)
        OR (c.last_message_at < p_cur_ts)
        OR (c.last_message_at = p_cur_ts AND c.id < p_cur_id)
      )
    ORDER BY c.last_message_at DESC NULLS FIRST, c.id DESC
    LIMIT v_limit + 1
  )
  SELECT
    COALESCE(
      array_agg(s.id ORDER BY s.last_message_at DESC NULLS FIRST, s.id DESC),
      '{}'
    ),
    COUNT(*) > v_limit
  INTO v_ids, v_has_more
  FROM matches s;

  -- Trim the over-fetched probe row; the array is already ordered.
  IF v_has_more THEN
    v_ids := v_ids[1:v_limit];
  END IF;

  RETURN jsonb_build_object(
    'ids', COALESCE(to_jsonb(v_ids), '[]'::JSONB),
    'has_more', v_has_more
  );
END;
$$;

ALTER FUNCTION public.search_inbox_conversations(
  TEXT, TEXT, UUID[], TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, UUID, INT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.search_inbox_conversations(
  TEXT, TEXT, UUID[], TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, UUID, INT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.search_inbox_conversations(
  TEXT, TEXT, UUID[], TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, UUID, INT
) TO authenticated;
