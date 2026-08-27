-- ============================================================
-- 057_flow_email_notifications.sql — "Notify by email" flow node
--
-- Background job table for the `email_notification` flow node.
--
-- The WhatsApp flow runner NEVER sends email synchronously. When a
-- contact reaches the node the engine INSERTs one row here (a fast,
-- durable outbox write) and immediately advances to the next node.
-- The actual SMTP delivery happens later, drained by the existing
-- flows cron (`runFlowCron` → `drainFlowEmailNotifications`), so a
-- slow / failing / hanging email provider can never stall a flow.
--
-- Lifecycle (mirrors the requirement's "queued → sending → sent" /
-- "…→ failed → retry"):
--   queued   → claimed by the cron (status='sending', attempt++)
--   sending  → sent    (sent_at set) | failed (attempt++, next_attempt_at)
--   failed   → retried until attempt >= max_attempts, then terminal
--
-- A row left in `sending` for > 10 minutes is treated as a crashed
-- process (network call dropped the connection mid-send) and reset to
-- `queued` by the next sweep so it gets retried.
--
-- `recipient` is NULL for recipient_mode='my_email' (the account owner's
-- email is resolved at send time) and holds the address for 'custom'.
-- `subject` / `body` keep the raw {{vars.*}} / {{contact.*}} / {{flow.*}}
-- templates; `vars` snapshots flow_runs.vars at enqueue time so the
-- email reflects the run's state when the node fired, not when the cron
-- happens to send it.
--
-- Service-role only — writes originate from the flow engine and the
-- cron, never from the browser (mirrors automation_pending_executions).
-- A read policy is exposed so account members can inspect delivery
-- status for debugging/monitoring.
-- ============================================================

CREATE TABLE IF NOT EXISTS flow_email_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenancy + audit, same split as flow_runs / automation_logs.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Cascade with the run so deleting a flow cleans up its jobs too.
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- node_key of the email_notification node that enqueued this job.
  node_key TEXT,
  recipient_mode TEXT NOT NULL DEFAULT 'my_email'
    CHECK (recipient_mode IN ('my_email', 'custom')),
  -- NULL for 'my_email' (resolved at send time); validated address for 'custom'.
  recipient TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Snapshot of flow_runs.vars when the node fired (interpolation input).
  vars JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  -- Number of send attempts STARTED (claims). Bounded by max_attempts.
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When the next retry becomes eligible; NULL once sent / final-failed.
  -- Defaults to NOW() on insert so a queued job is immediately due.
  next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  -- Provider message id when the email was accepted (Resend id / SMTP Message-Id).
  sent_message_id TEXT,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cron drain hot path: due, not-yet-sent jobs. Partial index so the
-- sweep stays cheap as sent/failed history accumulates.
CREATE INDEX IF NOT EXISTS idx_flow_email_notifications_due
  ON flow_email_notifications(next_attempt_at)
  WHERE status IN ('queued', 'failed');

-- Crash recovery: reset stale 'sending' rows (cron claim is idempotent).
CREATE INDEX IF NOT EXISTS idx_flow_email_notifications_sending
  ON flow_email_notifications(updated_at)
  WHERE status = 'sending';

-- Audit viewer: recent jobs per flow, newest first.
CREATE INDEX IF NOT EXISTS idx_flow_email_notifications_flow_created
  ON flow_email_notifications(flow_id, created_at DESC);

ALTER TABLE flow_email_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can view email notification jobs" ON flow_email_notifications;
CREATE POLICY "Account members can view email notification jobs"
  ON flow_email_notifications FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

DROP TRIGGER IF EXISTS set_updated_at ON flow_email_notifications;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON flow_email_notifications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Allow the new node type in flow_nodes
--
-- The original inline CHECK (migration 010) didn't know about
-- `email_notification`; drop and re-create it with the new member.
-- ============================================================
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'send_cta_url',
    'collect_input',
    'condition',
    'set_tag',
    'google_sheets_sync',
    'email_notification',
    'handoff',
    'http_fetch',
    'end'
  ));