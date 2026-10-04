// ============================================================
// POST /api/v1/recordings — upload a phone call recording.
//
// Phase 1 of CallVault → WACRM: a device (CallVault) POSTs one
// recording as multipart/form-data; the API stores the bytes in
// Supabase Storage and catalogs the metadata in
// `call_recordings` (migration 105).
//
// Auth: API key with the `recordings:write` scope. The phone
// never sees cookies, RLS, or service secrets — the key lookup
// fixes the account and every write is scoped by it.
//
// Form fields:
//   audio              File, required — the recording (Opus .ogg
//                      by default, AAC .m4a alternatively).
//   recorded_at        optional ISO 8601 — when the call happened
//                      (defaults to upload time).
//   duration_seconds   optional non-negative int.
//   contact_id         optional UUID — must belong to the account.
//   conversation_id    optional UUID — must belong to the account.
//
// Validation runs BEFORE any Storage write so a bad payload 400s
// without leaving an orphan object (same discipline as
// POST /api/v1/messages validating before resolve-or-create).
// The File is passed straight to the Storage upload as a Blob —
// never buffered into a second copy in Node memory.
//
// Response (201): { "data": <CallRecording> }
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { buildMediaPath } from '@/lib/storage/upload-media';
import {
  RECORDING_BUCKET,
  toCallRecording,
  validateRecordingFile,
  validateRecordingMetadata,
} from '@/lib/recordings/recordings';

async function accountOwns(
  supabase: SupabaseClient,
  table: 'contacts' | 'conversations',
  id: string,
  accountId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  return !error && !!data;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'recordings:write');

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail('bad_request', 'Request body must be multipart/form-data', 400);
    }
    const entry = form.get('audio');
    const file = entry instanceof File ? entry : null;
    if (!file) {
      return fail('bad_request', "Attach the recording as the 'audio' file field", 400);
    }

    const fileProblem = validateRecordingFile({ size: file.size, type: file.type });
    if (fileProblem) {
      return fail('bad_request', fileProblem, 400);
    }

    const rawRecordedAt =
      typeof form.get('recorded_at') === 'string'
        ? (form.get('recorded_at') as string).trim() || null
        : null;
    const rawDuration = form.get('duration_seconds');
    const durationSeconds =
      typeof rawDuration === 'string' && rawDuration.trim() !== ''
        ? Number(rawDuration)
        : null;
    const metaProblem = validateRecordingMetadata({
      recordedAt: rawRecordedAt,
      durationSeconds,
    });
    if (metaProblem) {
      return fail('bad_request', metaProblem, 400);
    }

    const rawContactId =
      typeof form.get('contact_id') === 'string' &&
      (form.get('contact_id') as string).trim() !== ''
        ? (form.get('contact_id') as string).trim()
        : null;
    const rawConversationId =
      typeof form.get('conversation_id') === 'string' &&
      (form.get('conversation_id') as string).trim() !== ''
        ? (form.get('conversation_id') as string).trim()
        : null;
    // Optional links must belong to the key's account — a device
    // must not be able to attach a recording to another account's
    // contact by guessing UUIDs.
    if (
      rawContactId &&
      !(await accountOwns(ctx.supabase, 'contacts', rawContactId, ctx.accountId))
    ) {
      return fail('bad_request', "'contact_id' does not belong to this account", 400);
    }
    if (
      rawConversationId &&
      !(await accountOwns(ctx.supabase, 'conversations', rawConversationId, ctx.accountId))
    ) {
      return fail(
        'bad_request',
        "'conversation_id' does not belong to this account",
        400
      );
    }

    // Account-scoped path — the same convention (and the same RLS
    // segment) every other media upload uses. `buildMediaPath`
    // sanitizes the CallVault filename (`20260501_120000_+1555….ogg`).
    const storagePath = buildMediaPath(
      ctx.accountId,
      file.name || 'recording.ogg'
    );
    const { error: uploadError } = await ctx.supabase.storage
      .from(RECORDING_BUCKET)
      .upload(storagePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      });
    if (uploadError) {
      console.error('[api/v1/recordings] storage upload failed:', uploadError.message);
      return fail('internal', 'Failed to store the recording', 500);
    }

    const { data: created, error: insertError } = await ctx.supabase
      .from('call_recordings')
      .insert({
        account_id: ctx.accountId,
        contact_id: rawContactId,
        conversation_id: rawConversationId,
        // Audit attribution to whoever minted the key (nullable —
        // mirrors the `api_keys.created_by` contract). Never used
        // for authorization; that is account_id + scopes.
        uploaded_by: ctx.createdBy,
        storage_bucket: RECORDING_BUCKET,
        storage_path: storagePath,
        file_name: file.name || null,
        mime_type: file.type,
        file_size: file.size,
        duration_seconds: durationSeconds,
        recorded_at: rawRecordedAt,
      })
      .select('*')
      .single();
    if (insertError || !created) {
      // The bytes landed but the catalog write failed — remove the
      // orphan so Storage can't accumulate unreachable objects
      // (same GC instinct as `deleteAccountMedia` on failed sends).
      console.error('[api/v1/recordings] catalog insert failed:', insertError?.message);
      await ctx.supabase.storage.from(RECORDING_BUCKET).remove([storagePath]);
      return fail('internal', 'Failed to save the recording', 500);
    }

    return ok(toCallRecording(created as Record<string, unknown>), 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
