import { describe, expect, it } from 'vitest';

import {
  RECORDING_ALLOWED_MIME_TYPES,
  RECORDING_BUCKET,
  RECORDING_MAX_BYTES,
  formatRecordingDuration,
  latestByContact,
  recordingSortTime,
  resolveUploaderName,
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

  it('accepts in/out direction and rejects anything else', () => {
    expect(
      validateRecordingMetadata({
        recordedAt: null,
        durationSeconds: null,
        direction: 'in',
      })
    ).toBeNull();
    expect(
      validateRecordingMetadata({
        recordedAt: null,
        durationSeconds: null,
        direction: 'out',
      })
    ).toBeNull();
    expect(
      validateRecordingMetadata({
        recordedAt: null,
        durationSeconds: null,
        direction: 'missed',
      })
    ).toContain('direction');
  });

  it('accepts short phone numbers and rejects oversized ones', () => {
    expect(
      validateRecordingMetadata({
        recordedAt: null,
        durationSeconds: null,
        phoneNumber: '+91916394642516',
      })
    ).toBeNull();
    expect(
      validateRecordingMetadata({
        recordedAt: null,
        durationSeconds: null,
        phoneNumber: '1'.repeat(65),
      })
    ).toContain('phone_number');
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
      uploader_name: null,
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

  it('carries the joined uploader name when provided', () => {
    expect(
      toCallRecording({ id: 'r1' }, 'Akash').uploader_name
    ).toBe('Akash');
  });
});

describe('resolveUploaderName', () => {
  it('prefers full_name, falls back to email, then Unknown', () => {
    expect(
      resolveUploaderName({ full_name: 'Akash', email: 'a@x.com' })
    ).toBe('Akash');
    expect(resolveUploaderName({ full_name: '  ', email: 'a@x.com' })).toBe(
      'a@x.com'
    );
    expect(resolveUploaderName(null)).toBe('Unknown');
    expect(resolveUploaderName({})).toBe('Unknown');
  });
});

describe('recordingSortTime', () => {
  it('prefers recorded_at and falls back to created_at', () => {
    expect(
      recordingSortTime({
        recorded_at: '2026-10-04T12:00:00.000Z',
        created_at: '2026-10-05T12:00:00.000Z',
      })
    ).toBe(Date.parse('2026-10-04T12:00:00.000Z'));
    expect(
      recordingSortTime({
        recorded_at: null,
        created_at: '2026-10-05T12:00:00.000Z',
      })
    ).toBe(Date.parse('2026-10-05T12:00:00.000Z'));
    expect(recordingSortTime({})).toBe(0);
  });
});

describe('latestByContact', () => {
  const row = (
    id: string,
    contactId: string | null,
    recorded_at: string | null,
    created_at: string,
  ) => ({ id, contactId, recorded_at, created_at });

  it('picks the latest recording per contact', () => {
    const rows = [
      row('old', 'c1', '2026-10-03T12:00:00.000Z', '2026-10-03T12:00:00.000Z'),
      row('new', 'c1', '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z'),
      row('only', 'c2', null, '2026-10-04T12:00:00.000Z'),
    ];
    const latest = latestByContact(rows, (r) => r.contactId);
    expect(latest.get('c1')?.id).toBe('new');
    expect(latest.get('c2')?.id).toBe('only');
  });

  it('falls back to created_at when recorded_at is null', () => {
    const rows = [
      row('a', 'c1', null, '2026-10-03T12:00:00.000Z'),
      row('b', 'c1', null, '2026-10-04T12:00:00.000Z'),
    ];
    expect(latestByContact(rows, (r) => r.contactId).get('c1')?.id).toBe('b');
  });

  it('breaks ties deterministically by created_at then id', () => {
    const rows = [
      row('a', 'c1', '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z'),
      row('b', 'c1', '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z'),
    ];
    expect(latestByContact(rows, (r) => r.contactId).get('c1')?.id).toBe('b');
  });

  it('skips unlinked rows and returns empty for contacts without recordings', () => {
    const rows = [row('x', null, '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z')];
    const latest = latestByContact(rows, (r) => r.contactId);
    expect(latest.size).toBe(0);
    expect(latest.get('c9')).toBeUndefined();
  });
});

describe('formatRecordingDuration', () => {
  it('formats m:ss and handles unknown', () => {
    expect(formatRecordingDuration(35)).toBe('0:35');
    expect(formatRecordingDuration(72)).toBe('1:12');
    expect(formatRecordingDuration(null)).toBe('—');
    expect(formatRecordingDuration(undefined)).toBe('—');
  });
});
