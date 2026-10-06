// Recordings library data layer — query building and duration text.

import { describe, expect, it } from 'vitest';

import {
  formatDurationLong,
  recordingsQuery,
  summaryQuery,
  type RecordingsFilters,
} from './library';

const FILTERS: RecordingsFilters = {
  q: '',
  rangeKey: 'last30',
  customFrom: '',
  customTo: '',
  callType: null,
  direction: null,
  uploadedBy: null,
  status: null,
};

const RANGE = { fromISO: '2026-10-01T00:00:00.000Z', toISO: '2026-10-06T00:00:00.000Z' };

describe('recordingsQuery', () => {
  it('always scopes by range with pagination', () => {
    const qs = new URLSearchParams(recordingsQuery(FILTERS, RANGE, 10, 20));
    expect(qs.get('limit')).toBe('10');
    expect(qs.get('offset')).toBe('20');
    expect(qs.get('from')).toBe(RANGE.fromISO);
    expect(qs.get('to')).toBe(RANGE.toISO);
    expect(qs.get('q')).toBeNull();
  });

  it('passes every active filter to the server', () => {
    const qs = new URLSearchParams(
      recordingsQuery(
        {
          ...FILTERS,
          q: '  Akash ',
          callType: 'whatsapp',
          direction: 'unknown',
          uploadedBy: '123e4567-e89b-12d3-a456-426614174000',
          status: 'unlinked',
        },
        RANGE,
        10,
        0
      )
    );
    expect(qs.get('q')).toBe('Akash');
    expect(qs.get('call_type')).toBe('whatsapp');
    expect(qs.get('direction')).toBe('unknown');
    expect(qs.get('uploaded_by')).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(qs.get('status')).toBe('unlinked');
  });
});

describe('summaryQuery', () => {
  it('requests the aggregate, never rows', () => {
    const qs = new URLSearchParams(summaryQuery(FILTERS, RANGE));
    expect(qs.get('summary')).toBe('1');
    expect(qs.get('limit')).toBeNull();
    expect(qs.get('from')).toBe(RANGE.fromISO);
  });
});

describe('formatDurationLong', () => {
  it('renders seconds for short recordings', () => {
    expect(formatDurationLong(16)).toBe('16 seconds');
    expect(formatDurationLong(1)).toBe('1 second');
    expect(formatDurationLong(0)).toBe('0 seconds');
  });

  it('renders m:ss for longer recordings', () => {
    expect(formatDurationLong(192)).toBe('3:12');
    expect(formatDurationLong(3661)).toBe('61:01');
  });

  it('renders an em dash for unknown durations', () => {
    expect(formatDurationLong(null)).toBe('—');
    expect(formatDurationLong(undefined)).toBe('—');
    expect(formatDurationLong(Number.NaN)).toBe('—');
  });
});
