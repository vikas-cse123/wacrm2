-- ============================================================
-- 054_conversation_pins.sql — Per-user pinned inbox chats
--
-- Lets a team member pin important WhatsApp chats so they float to
-- the top of their inbox. Pins are PER USER, not per account: one
-- teammate pinning a chat must not pin it for everyone else.
--
-- What this migration does
--   1. `conversation_pins` — one row per (user, conversation) pin,
--      carrying account_id for tenant scoping + fast reads and
--      pinned_at for ordering. UNIQUE(user_id, conversation_id)
--      makes a duplicate pin impossible at the DB level.
--   2. RLS: a member may only SELECT their OWN pins, and only inside
--      an account they belong to. There are deliberately NO client
--      INSERT/UPDATE/DELETE policies — every write goes through the
--      two SECURITY DEFINER RPCs below, so the 30-pin cap cannot be
--      bypassed by inserting rows directly.
--   3. `pin_conversation` / `unpin_conversation` RPCs that self-check
--      the caller, enforce tenant isolation + the 30-pin limit, are
--      idempotent (re-pin / re-unpin is a no-op success), and take a
--      per-user advisory lock so simultaneous pin requests can't race
--      past the limit.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The member who pinned. auth.users, not profiles — matches every
  -- other user_id FK in the schema and cascades on user deletion.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Denormalised tenant key: lets the SELECT policy scope by account
  -- without a join, and lets a deleted account cascade its pins away.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One pin per (user, conversation): re-pinning is a no-op, never a
  -- second row. This is the DB-level guarantee behind "prevent
  -- duplicate pin records".
  CONSTRAINT conversation_pins_user_conversation_key
    UNIQUE (user_id, conversation_id)
);

-- Hot path: "give me this user's pins (within their account)".
CREATE INDEX IF NOT EXISTS idx_conversation_pins_user_account
  ON conversation_pins(user_id, account_id);
-- Supports the ON DELETE CASCADE from conversations and any
-- "who pinned this conversation" lookups.
CREATE INDEX IF NOT EXISTS idx_conversation_pins_conversation
  ON conversation_pins(conversation_id);

-- ============================================================
-- RLS
--
-- Read-only for clients, scoped to the caller's own pins inside an
-- account they belong to. Writes are RPC-only (see below) so the
-- cap enforcement can't be side-stepped.
-- ============================================================
ALTER TABLE conversation_pins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_pins_select ON conversation_pins;
CREATE POLICY conversation_pins_select ON conversation_pins FOR SELECT
  USING (user_id = auth.uid() AND is_account_member(account_id));

-- ============================================================
-- pin_conversation(p_conversation_id) -> new pin count
--
-- Pins a conversation for the calling user. Returns the caller's
-- total pin count after the operation.
--
-- Guarantees:
--   - auth required                              (42501)
--   - conversation must be in the caller's account
--     (missing or cross-account -> "not found")  (22023)
--   - at most 30 pins per user; the 31st raises   (P0001 / 'PIN_LIMIT_REACHED')
--   - idempotent: re-pinning an already-pinned chat succeeds and
--     does NOT create a duplicate or count against the limit
--   - concurrency-safe: a per-user transaction advisory lock
--     serialises simultaneous pin calls so two in-flight requests
--     can't both pass the count check and land pin #31.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pin_conversation(p_conversation_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_conv_account_id UUID;
  v_count INTEGER;
  v_already BOOLEAN;
  c_max CONSTANT INTEGER := 30;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Resolve caller's account (also proves they have a profile).
  SELECT account_id INTO v_caller_account_id
  FROM profiles WHERE user_id = v_user_id;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Serialise this user's pin operations. Transaction-scoped: auto-
  -- released on commit/rollback. Without it, two concurrent requests
  -- could each read count = 29 and both insert, yielding 31 pins.
  PERFORM pg_advisory_xact_lock(hashtext('conversation_pins:' || v_user_id::text));

  -- Tenant isolation + "can the user access this chat": the pinnable
  -- set is exactly the conversations in the caller's account. A
  -- missing row and a cross-account row are indistinguishable to the
  -- caller by design (no existence oracle).
  SELECT account_id INTO v_conv_account_id
  FROM conversations WHERE id = p_conversation_id;
  IF v_conv_account_id IS NULL OR v_conv_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Conversation not found in your account'
      USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM conversation_pins
    WHERE user_id = v_user_id AND conversation_id = p_conversation_id
  ) INTO v_already;

  SELECT COUNT(*) INTO v_count
  FROM conversation_pins WHERE user_id = v_user_id;

  -- Idempotent: already pinned -> success, current count, no dupe.
  IF v_already THEN
    RETURN v_count;
  END IF;

  IF v_count >= c_max THEN
    RAISE EXCEPTION 'PIN_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO conversation_pins (user_id, account_id, conversation_id)
  VALUES (v_user_id, v_conv_account_id, p_conversation_id)
  ON CONFLICT (user_id, conversation_id) DO NOTHING;

  SELECT COUNT(*) INTO v_count
  FROM conversation_pins WHERE user_id = v_user_id;
  RETURN v_count;
END;
$$;

-- ============================================================
-- unpin_conversation(p_conversation_id) -> new pin count
--
-- Removes the caller's pin for a conversation. Idempotent — unpinning
-- something not pinned is a no-op success. Only ever touches the
-- caller's own rows, so tenant isolation is inherent (no cross-user
-- delete is possible).
-- ============================================================
CREATE OR REPLACE FUNCTION public.unpin_conversation(p_conversation_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  DELETE FROM conversation_pins
  WHERE user_id = v_user_id AND conversation_id = p_conversation_id;

  SELECT COUNT(*) INTO v_count
  FROM conversation_pins WHERE user_id = v_user_id;
  RETURN v_count;
END;
$$;

-- SECURITY DEFINER functions run as their owner; make that explicit
-- and grant execute to authenticated callers only (mirrors 018).
ALTER FUNCTION public.pin_conversation(UUID) OWNER TO postgres;
ALTER FUNCTION public.unpin_conversation(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.pin_conversation(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unpin_conversation(UUID) TO authenticated, service_role;
