import { describe, expect, it } from 'vitest';

import {
  RECORDING_ALLOWED_MIME_TYPES,
  RECORDING_BUCKET,
  RECORDING_MAX_BYTES,
  toCallRecording,
  validateRecordingFile,
  validateRecordingMetadata,
} from './recordings';

describe('validateRecordingFile', () => {
  it('accepts CallVault defaults (Opus .ogg, AAC .m4a)', () => {
    expect(
      validateRecordingFile({ size: 1024, type: 'audio/ogg' })
    ).toBeNull();
    expect(
      validateRecordingFile({ size: 1024, type: 'audio/aac' })
    ).toBeNull();
    expect(
      validateRecordingFile({ size: 1024, type: 'audio/x-m4a' })
    ).toBeNull();
  });

  it('rejects non-audio and empty files', () => {
    expect(validateRecordingFile({ size: 1024, type: 'video/mp4' })).toContain(
      'Unsupported audio type'
    );
    expect(validateRecordingFile({ size: 1024, type: '' })).toContain(
      'Unsupported audio type'
    );
    expect(validateRecordingFile({ size: 0, type: 'audio/ogg' })).toBe(
      'Empty audio file.'
    );
  });

  it('rejects files over the bucket-matching cap', () => {
    expect(
      validateRecordingFile({
        size: RECORDING_MAX_BYTES + 1,
        type: 'audio/ogg',
      })
    ).toContain('too large');
    expect(
      validateRecordingFile({ size: RECORDING_MAX_BYTES, type: 'audio/ogg' })
    ).toBeNull();
  });

  it('uses the private call-recordings bucket, never chat-media', () => {
    expect(RECORDING_BUCKET).toBe('call-recordings');
    expect(RECORDING_BUCKET).not.toBe('chat-media');
  });

  it('stays within the call-recordings bucket allowlist', () => {
    // Every accepted MIME must exist in the bucket config or Storage
    // itself rejects the upload with a 500-class error. The bucket
    // list lives in 105_call_recordings.sql and must match exactly.
    const bucketAudio = new Set([
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
    ]);
    expect([...RECORDING_ALLOWED_MIME_TYPES].sort()).toEqual(
      [...bucketAudio].sort()
    );
    for (const mime of RECORDING_ALLOWED_MIME_TYPES) {
      expect(bucketAudio.has(mime)).toBe(true);
    }
    expect(RECORDING_BUCKET).toBe('call-recordings');
  });
});

describe('validateRecordingMetadata', () => {
  it('accepts empty metadata and valid values', () => {
    expect(
      validateRecordingMetadata({ recordedAt: null, durationSeconds: null })
    ).toBeNull();
    expect(
      validateRecordingMetadata({
        recordedAt: '2026-10-04T12:00:00.000Z',
        durationSeconds: 187,
      })
    ).toBeNull();
  });

  it('rejects unparseable timestamps and bad durations', () => {
    expect(
      validateRecordingMetadata({
        recordedAt: 'not-a-date',
        durationSeconds: null,
      })
    ).toContain('recorded_at');
    expect(
      validateRecordingMetadata({ recordedAt: null, durationSeconds: -1 })
    ).toContain('duration_seconds');
    expect(
      validateRecordingMetadata({ recordedAt: null, durationSeconds: 1.5 })
    ).toContain('duration_seconds');
    expect(
      validateRecordingMetadata({ recordedAt: null, durationSeconds: '187' })
    ).toContain('duration_seconds');
  });
});

describe('toCallRecording', () => {
  it('maps a row, defaulting missing nullable columns to null', () => {
    expect(
      toCallRecording({
        id: 'r1',
        account_id: 'a1',
        storage_bucket: 'call-recordings',
        storage_path: 'account-a1/1-call.ogg',
        created_at: '2026-10-04T12:00:00.000Z',
      })
    ).toEqual({
      id: 'r1',
      account_id: 'a1',
      contact_id: null,
      conversation_id: null,
      uploaded_by: null,
      storage_bucket: 'call-recordings',
      storage_path: 'account-a1/1-call.ogg',
      file_name: null,
      mime_type: null,
      file_size: null,
      duration_seconds: null,
      recorded_at: null,
      created_at: '2026-10-04T12:00:00.000Z',
    });
  });
});
