-- ============================================================
-- 034_push_subscriptions.sql — Web Push (mobile / PWA notifications)
--
-- Stores one row per browser/device push subscription so the server
-- can fan out a Web Push message to every member of an account when a
-- new inbound WhatsApp message lands.
--
-- Design notes
--   - Keyed by the push `endpoint` (globally unique per browser +
--     subscription), so a device that re-subscribes upserts its row
--     instead of piling up duplicates.
--   - `user_id` is the recipient agent; `account_id` scopes the fan-out
--     to the right tenant. Both cascade-delete so removing a user or
--     account cleans up their subscriptions.
--   - The on/off toggle in Settings is expressed by the *presence* of a
--     row: enabling subscribes (insert), disabling unsubscribes
--     (delete). No separate boolean needed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Recipient — the agent this subscription pushes to.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The browser push endpoint URL. Globally unique per subscription.
  endpoint TEXT NOT NULL UNIQUE,
  -- Encryption material returned by PushManager.subscribe().
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Diagnostics / "which device is this" in a future devices list.
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account
  ON push_subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- A user manages only their own subscriptions. The server-side fan-out
-- runs with the service-role key and bypasses RLS, so it can read every
-- member's subscription regardless of these policies.
DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_insert ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;

CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY push_subscriptions_insert ON push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);
