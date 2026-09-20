-- 073_quick_reply_media.sql
-- Extends quick_replies with WhatsApp media support.
-- Backward compatible: existing rows default to message_type='text' and media_* columns NULL.

-- Add media columns
alter table quick_replies add column if not exists message_type text not null default 'text'
  check (message_type in ('text','image','video','audio','document','sticker'));
alter table quick_replies add column if not exists media_url text;
alter table quick_replies add column if not exists media_path text;
alter table quick_replies add column if not exists media_mime_type text;
alter table quick_replies add column if not exists media_file_name text;
alter table quick_replies add column if not exists media_file_size integer;
alter table quick_replies add column if not exists media_caption text;
-- Optional: WhatsApp media ID if upload-to-Meta strategy is used later
alter table quick_replies add column if not exists whatsapp_media_id text;

-- Message column now nullable for non-text types? Keep NOT NULL but allow empty for media
-- We keep original constraint but relax to allow empty string for media types
-- Existing check: message text not null — we keep it, media replies store caption in media_caption
-- and message may hold fallback/caption duplicate.

-- Relax message not null to allow empty when media present (keep default '')
do $$ begin
  -- If message column was NOT NULL, we keep it but allow empty. No action needed if already nullable.
  begin
    alter table quick_replies alter column message drop not null;
  exception when others then null;
  end;
end $$;

-- Storage: expand chat-media bucket for Quick Reply media
-- Need: webp for stickers, broader document MIME types, and 100MB limit for documents.
-- We reuse chat-media (no second bucket) and bump limit to 100 MB so documents up to
-- WhatsApp spec can pass. Per-kind caps are enforced in application validation.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media',
  'chat-media',
  true,
  104857600, -- 100 MB (WhatsApp document max; app validates per-kind tighter caps)
  array[
    -- Images
    'image/png', 'image/jpeg', 'image/webp', 'image/jpg',
    -- Videos
    'video/mp4', 'video/3gpp', 'video/3gp',
    -- Documents (common WhatsApp doc types + ODF)
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.presentation',
    'text/plain',
    'text/csv',
    -- Audio
    'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/mp4', 'audio/amr', 'audio/3gpp', 'audio/opus', 'audio/webm', 'audio/x-m4a', 'audio/m4a',
    -- Sticker (webp)
    'image/webp'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Index for filtering by message_type
create index if not exists quick_replies_message_type_idx on quick_replies (message_type);
