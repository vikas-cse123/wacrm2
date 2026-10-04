-- ============================================================
-- 105_call_recordings.sql — Phase 1 phone call recordings
--
-- Adds the `call_recordings` table backing CallVault uploads
-- (`POST /api/v1/recordings`) and the WACRM Recordings page.
-- One row = one uploaded audio file. Audio BYTES live only in
-- the dedicated PRIVATE `call-recordings` Storage bucket created
-- below — never in the public `chat-media` bucket (which stays
-- exactly as-is for WhatsApp voice/media). This table is the
-- queryable metadata catalog, the same split `messages`
-- (reference) vs `storage.objects` (bytes) already uses.
--
-- Ownership: account-scoped like every other parent table
-- (migration 017). `contact_id` / `conversation_id` are nullable
-- and SET NULL on delete — Phase 1 ships recordings unlinked
-- (no contact matching), links are attached later without
-- losing the recording. `uploaded_by` mirrors the `api_keys`
-- audit pattern (migration 026): the minter's auth.users id,
-- ON DELETE SET NULL, never an auth principal.
--
-- RLS: settings-adjacent but operational — any member may read
-- their account's recordings; writes require agent+ (a device
-- uploads through the service-role API path, which bypasses RLS,
-- but dashboard-side writes stay member-gated like contacts).
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_recordings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  uploaded_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  storage_bucket  text NOT NULL DEFAULT 'call-recordings',
  storage_path    text NOT NULL,
  file_name       text,
  mime_type       text,
  file_size       bigint,
  duration_seconds integer,
  recorded_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- List page: newest-first per account.
CREATE INDEX IF NOT EXISTS call_recordings_account_recorded_idx
  ON call_recordings (account_id, recorded_at DESC NULLS LAST, created_at DESC, id DESC);
-- Future contact / conversation linking (Phase 2+).
CREATE INDEX IF NOT EXISTS call_recordings_conversation_id_idx
  ON call_recordings (conversation_id);
CREATE INDEX IF NOT EXISTS call_recordings_contact_id_idx
  ON call_recordings (contact_id);

ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+).
DROP POLICY IF EXISTS call_recordings_select ON call_recordings;
CREATE POLICY call_recordings_select ON call_recordings FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: agent+ (mirrors contacts / conversations
-- in migration 017 — operational tables, not settings).
DROP POLICY IF EXISTS call_recordings_insert ON call_recordings;
CREATE POLICY call_recordings_insert ON call_recordings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS call_recordings_update ON call_recordings;
CREATE POLICY call_recordings_update ON call_recordings FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS call_recordings_delete ON call_recordings;
CREATE POLICY call_recordings_delete ON call_recordings FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- Private `call-recordings` Storage bucket
--
-- Dedicated bucket for phone call recordings. PRIVATE (no public
-- reads) — unlike `chat-media` (migration 023), which must stay
-- public so Meta can fetch WhatsApp media links. Nothing here
-- touches `chat-media`, `flow-media`, or `avatars`.
--
-- Access shape:
--   - Reads: account members only, via the path's first segment
--     (`account-<account_id>/…`, same convention as 020/023).
--     Playback goes through `GET /api/recordings/[id]/audio`,
--     which verifies account ownership and redirects to a
--     60-second signed URL — the raw object URL is never exposed.
--   - Writes: account members via policy; the device upload path
--     (`POST /api/v1/recordings`) uses the service-role client,
--     which bypasses RLS, with the account fixed at API-key lookup.
--
-- Size limit 100 MB; MIME list is exactly the audio set the
-- upload endpoint accepts (see `RECORDING_ALLOWED_MIME_TYPES` in
-- `src/lib/recordings/recordings.ts`) — nothing else may land here.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'call-recordings',
  'call-recordings',
  FALSE,
  104857600, -- 100 MB (mirrors RECORDING_MAX_BYTES)
  ARRAY[
    'audio/ogg',
    'audio/opus',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/aac',
    'audio/amr',
    'audio/3gpp',
    'audio/webm',
    'audio/x-m4a',
    'audio/m4a'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Reads: account members only. Deliberately NO public SELECT —
-- this is the difference from the `chat-media` policies.
DROP POLICY IF EXISTS "Members can read call recordings" ON storage.objects;
CREATE POLICY "Members can read call recordings"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'call-recordings'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can upload call recordings" ON storage.objects;
CREATE POLICY "Members can upload call recordings"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'call-recordings'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update call recordings" ON storage.objects;
CREATE POLICY "Members can update call recordings"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'call-recordings'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete call recordings" ON storage.objects;
CREATE POLICY "Members can delete call recordings"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'call-recordings'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
