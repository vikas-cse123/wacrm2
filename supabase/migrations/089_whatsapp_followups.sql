-- ============================================================
-- 089_whatsapp_followups.sql — scheduled WhatsApp follow-up messages
--
-- Standalone feature (independent of Workspace and Google Sheets):
-- an agent schedules a text message for a contact; a cron worker
-- claims due rows and sends them through the connected WhatsApp
-- Business number. Meta is the transport; the persisted outbound
-- `messages` row (existing table) is the Inbox record — no second
-- message store. Status webhooks correlate by the stored wamid.
--
-- Claim safety: workers claim with
--   UPDATE ... SET status='processing'
--   WHERE id = ? AND status IN ('scheduled', <stale processing>)
-- and only proceed when exactly one row flips, so overlapping
-- workers can never double-send. `attempts` bounds reclaims.
--
-- Tenant isolation mirrors message_templates (017): any account
-- member may read; agent+ may write (operational data, like sends).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'whatsapp_followup_status') THEN
    CREATE TYPE whatsapp_followup_status AS ENUM (
      'scheduled',
      'processing',
      'sent',
      'failed',
      'cancelled'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS whatsapp_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant key: every query scopes by account, and a deleted
  -- account cascades its follow-ups away.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Recipient contact. Contact deletion nulls the link (history
  -- preserved) — a nulled row can no longer send.
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Thread the outbound message lands in. Resolved at schedule
  -- time via get-or-create semantics; re-resolved at send time
  -- if missing. Never cascades (conversation deletion must not
  -- silently drop a scheduled send — the worker fails loudly).
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  -- UTC instant to send at. Interpreted from the agent's local
  -- date/time picker at creation; stored as TIMESTAMPTZ.
  scheduled_for TIMESTAMPTZ NOT NULL,
  message_text TEXT NOT NULL,
  -- Optional approved-template fallback when the 24h customer
  -- service window is closed at send time. NULL = text only.
  template_name TEXT,
  template_language TEXT,
  status whatsapp_followup_status NOT NULL DEFAULT 'scheduled',
  -- Scheduler bookkeeping: bounded reclaims of crashed workers.
  attempts INT NOT NULL DEFAULT 0,
  -- Outcome linkage + diagnostics. wamid correlates webhook
  -- delivered/read/failed updates on the messages row.
  whatsapp_message_id TEXT,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  -- Audit: creator. Survives user deletion as NULL (mirrors
  -- flow_runs re-pointing rather than history loss).
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: "due follow-ups" for the cron worker.
CREATE INDEX IF NOT EXISTS idx_whatsapp_followups_due
  ON whatsapp_followups (status, scheduled_for)
  WHERE status IN ('scheduled', 'processing');

-- Hot path: "this account's follow-ups, newest first".
CREATE INDEX IF NOT EXISTS idx_whatsapp_followups_account
  ON whatsapp_followups (account_id, scheduled_for DESC);

-- Webhook/idempotency lookup is by wamid on messages (existing
-- idx_messages_message_id); no extra index needed here.

ALTER TABLE whatsapp_followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_followups_select ON whatsapp_followups;
CREATE POLICY whatsapp_followups_select ON whatsapp_followups FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_followups_insert ON whatsapp_followups;
CREATE POLICY whatsapp_followups_insert ON whatsapp_followups FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS whatsapp_followups_update ON whatsapp_followups;
CREATE POLICY whatsapp_followups_update ON whatsapp_followups FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS whatsapp_followups_delete ON whatsapp_followups;
CREATE POLICY whatsapp_followups_delete ON whatsapp_followups FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Keep updated_at fresh (same trigger as every table since 001).
-- The worker's stale-processing reclaim reads updated_at.
DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_followups;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_followups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
