-- ============================================================
-- 085_inbox_search_history.sql — search ALL historical message content
--
-- Problem: search_inbox_conversations() (078) matched only
-- conversations.last_message_text (the single newest message preview)
-- plus contact name / phone. A term from any older message
-- (e.g. "oceanarium" in a mid-thread customer reply when the
-- conversation preview has since moved on to "[document]") matched
-- nothing, even though the message is stored in messages.content_text.
--
-- Fix: extend ONLY the text-match predicate with an account-scoped
-- EXISTS over messages.content_text, using the same escaped
-- ILIKE '%query%' substring semantics as the existing branches.
--
-- Scope notes:
--   - messages has no account_id column (see 074_dashboard_analytics):
--     rows are scoped to the account through their conversation, so
--     correlating m.conversation_id = c.id inside the EXISTS inherits
--     the outer c.account_id = v_account_id filter. Cross-account
--     leakage is impossible: a message can only match via a
--     conversation the caller already owns.
--   - RLS is unchanged: the function stays SECURITY INVOKER, so the
--     messages_select policy (membership via the parent conversation,
--     see 017_account_sharing) applies to the caller as before.
--   - EXISTS (not JOIN) keeps one row per conversation regardless of
--     how many messages match — pagination, ordering, keyset cursor,
--     and has_more behave exactly as in 078.
--   - NULL content_text (media without caption, etc.) never matches
--     ILIKE, so those rows are silently skipped — no special-casing.
--
-- Performance: leading-% ILIKE over messages needs trigram support
-- at production scale, so pg_trgm is enabled and a GIN index on
-- messages(content_text) is added. The correlation still uses the
-- existing idx_messages_conversation btree. Short (<3 char) queries
-- can't use the trigram index but stay correct via the same plan
-- shape 078 already accepted for the conversations-side scan.
--
-- What is NOT changed: signature, filters (status/tags/company/flow/
-- team/date), ordering (last_message_at DESC NULLS FIRST, id DESC),
-- keyset pagination, response envelope, grants, security mode.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Trigram support for substring search (bundled with Postgres;
-- same IF NOT EXISTS pattern as pgcrypto in 001 / vector in 030).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index backing `content_text ILIKE '%q%'` for queries
-- of 3+ characters. Purely additive, no behaviour change.
CREATE INDEX IF NOT EXISTS idx_messages_content_text_trgm
  ON messages USING gin (content_text gin_trgm_ops);

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
      -- Text match: name / raw phone / normalized phone / last message /
      -- ANY historical message. The messages branch is EXISTS (never a
      -- join), so one conversation yields one row no matter how many of
      -- its messages match. Scoping rides on m.conversation_id = c.id:
      -- the outer c.account_id filter already owns the conversation,
      -- and messages carries no account_id of its own.
      AND (
        c.last_message_text ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR ct.name ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR ct.phone ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR (
          v_digits IS NOT NULL
          AND ct.phone_normalized ILIKE '%' || v_digits || '%' ESCAPE '\'
        )
        OR EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
            AND m.content_text ILIKE '%' || v_qesc || '%' ESCAPE '\'
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
