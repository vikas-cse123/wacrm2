-- ============================================================
-- 110_call_events.sql — phone-call outcome telemetry.
--
-- A missed or rejected carrier call has NO audio recording, so
-- `call_recordings` can never represent it. This table records
-- one row per carrier call outcome, reported by CallVault from
-- the authoritative Android CallLog `Calls.TYPE` (MISSED /
-- REJECTED / INCOMING / OUTGOING) — never inferred from
-- direction, duration, filenames, or recording existence.
--
-- Scope is deliberately phone-only (`call_type = 'phone'`):
-- there is no equally reliable outcome source for WhatsApp /
-- WhatsApp Business calls, and their outcomes must not be
-- fabricated. WhatsApp support needs its own migration.
--
-- Idempotency: CallVault generates one UUID per call
-- (`client_event_id`) and carries it through retries;
-- UNIQUE(account_id, client_event_id) makes a retried POST
-- return the existing row instead of a duplicate. The event ID
-- is opaque — never a filename, never a phone number.
--
-- No recording link is stored: there is no safe stable join key
-- between a CallLog row and a recording file (filenames are
-- timestamps, not ids), and events must exist without
-- recordings. Forcing a link would corrupt both datasets.
--
-- Ownership: account-scoped like every parent table (017).
-- `contact_id` SET NULL on delete (server-side exact phone
-- match at insert, same helper as recordings). `user_id` is the
-- actual authenticated uploader (device user or key minter),
-- SET NULL on user delete — mirrors the `uploaded_by` audit
-- pattern, never an auth principal.
--
-- RLS: any member may read their account's events; writes
-- require agent+ (a device posts through the service-role API
-- path with the account fixed at credential lookup, same as
-- recordings). Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  client_event_id text NOT NULL,
  call_type       text NOT NULL DEFAULT 'phone' CHECK (call_type = 'phone'),
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  outcome         text NOT NULL CHECK (outcome IN ('answered', 'missed', 'rejected', 'unknown')),
  phone_number    text,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  duration_seconds integer,
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_events_client_id_unique UNIQUE (account_id, client_event_id)
);

-- Dashboard outcome cards: per-account outcome counts over time.
CREATE INDEX IF NOT EXISTS call_events_account_occurred_idx
  ON call_events (account_id, occurred_at DESC, id DESC);
-- Outcome-filtered counts (missed / rejected cards).
CREATE INDEX IF NOT EXISTS call_events_account_outcome_idx
  ON call_events (account_id, outcome, occurred_at DESC);
-- Per-user filtering (dashboard user filter).
CREATE INDEX IF NOT EXISTS call_events_account_user_idx
  ON call_events (account_id, user_id, occurred_at DESC);

ALTER TABLE call_events ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+).
DROP POLICY IF EXISTS call_events_select ON call_events;
CREATE POLICY call_events_select ON call_events FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: agent+ (mirrors call_recordings —
-- operational tables, not settings).
DROP POLICY IF EXISTS call_events_insert ON call_events;
CREATE POLICY call_events_insert ON call_events FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS call_events_update ON call_events;
CREATE POLICY call_events_update ON call_events FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS call_events_delete ON call_events;
CREATE POLICY call_events_delete ON call_events FOR DELETE
  USING (is_account_member(account_id, 'agent'));
