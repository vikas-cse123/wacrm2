// ============================================================
// Phase 1 call recordings — shared server-side model.
//
// One row of `call_recordings` (migration 105) = one uploaded
// audio file. Bytes live in the dedicated PRIVATE
// `call-recordings` Storage bucket (created in migration 105) —
// never in the public `chat-media` bucket. This module is the
// validation + serialization contract both the upload endpoint
// (`POST /api/v1/recordings`) and the dashboard list
// (`GET /api/recordings`) speak.
//
// The MIME allowlist below MUST stay a subset of the bucket's
// `allowed_mime_types` — anything else is rejected by Storage
// at upload time and would land as a confusing 500 instead of
// a clean 400 here.
// ============================================================

/** Storage bucket recordings live in. PRIVATE — no public reads. */
export const RECORDING_BUCKET = 'call-recordings';

/**
 * 100 MB — mirrors the `call-recordings` `file_size_limit` in
 * migration 105. One limit to reason about (same philosophy as
 * migration 023): the bucket is the hard ceiling, this check
 * just turns its rejection into a clean 400 before any bytes
 * move. (CallVault's default Opus-at-24kbps encodes ~180 KB/min,
 * so this is ~9 hours; AAC/128kbps is ~87 min.)
 */
export const RECORDING_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Audio MIME types the upload endpoint accepts. Exactly the
 * `call-recordings` bucket allowlist (migration 105):
 * CallVault ships Opus-in-`.ogg` by default and AAC-in-`.m4a`
 * as the alternative — the rest covers real-world encoder
 * variance without opening the door to non-audio uploads.
 */
export const RECORDING_ALLOWED_MIME_TYPES = [
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
  'audio/m4a',
] as const;

export type RecordingMimeType = (typeof RECORDING_ALLOWED_MIME_TYPES)[number];

/** A `call_recordings` row as the API serves it. */
export interface CallRecording {
  id: string;
  account_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  uploaded_by: string | null;
  storage_bucket: string;
  storage_path: string;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  duration_seconds: number | null;
  recorded_at: string | null;
  created_at: string;
}

export function toCallRecording(row: Record<string, unknown>): CallRecording {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    uploaded_by: (row.uploaded_by as string | null) ?? null,
    storage_bucket: row.storage_bucket as string,
    storage_path: row.storage_path as string,
    file_name: (row.file_name as string | null) ?? null,
    mime_type: (row.mime_type as string | null) ?? null,
    file_size: (row.file_size as number | null) ?? null,
    duration_seconds: (row.duration_seconds as number | null) ?? null,
    recorded_at: (row.recorded_at as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

export function isRecordingMimeType(value: unknown): value is RecordingMimeType {
  return (
    typeof value === 'string' &&
    (RECORDING_ALLOWED_MIME_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Validate an uploaded audio file BEFORE it touches Storage, so a
 * bad payload 400s without leaving an orphan object behind (same
 * discipline as `validateSendMessageParams` validating before
 * `resolveConversationByPhone` creates anything). Returns the
 * human-facing problem, or null when the file is acceptable.
 */
export function validateRecordingFile(file: {
  size: number;
  type: string;
}): string | null {
  if (!file.type || !isRecordingMimeType(file.type)) {
    return `Unsupported audio type '${file.type || 'unknown'}'. Supported: ${RECORDING_ALLOWED_MIME_TYPES.join(', ')}.`;
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return 'Empty audio file.';
  }
  if (file.size > RECORDING_MAX_BYTES) {
    return `Audio file is too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum is ${RECORDING_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/**
 * Validate the optional metadata fields. `recorded_at` must be a
 * parseable timestamp; `duration_seconds` a non-negative integer.
 * Returns the human-facing problem, or null when acceptable.
 */
export function validateRecordingMetadata(input: {
  recordedAt: string | null;
  durationSeconds: unknown;
}): string | null {
  if (input.recordedAt !== null && Number.isNaN(Date.parse(input.recordedAt))) {
    return "'recorded_at' must be an ISO 8601 timestamp.";
  }
  if (input.durationSeconds !== null && input.durationSeconds !== undefined) {
    if (
      typeof input.durationSeconds !== 'number' ||
      !Number.isInteger(input.durationSeconds) ||
      input.durationSeconds < 0
    ) {
      return "'duration_seconds' must be a non-negative integer.";
    }
  }
  return null;
}
