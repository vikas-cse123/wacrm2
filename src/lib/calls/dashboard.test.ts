// Dashboard aggregation — pure reductions over bounded row sets.
// Same RECORDINGS model as aggregateRecordingMetrics: NULLs are
// excluded per-metric, never inferred.

import { describe, expect, it } from 'vitest';

import {
  averageDurationSecs,
  bucketDaily,
  bucketDurations,
  directionDurationSecs,
  latestRecordings,
  percentChange,
  topClientsByRecordings,
  type CallsRecordingRow,
} from './aggregate';

function row(over: Partial<CallsRecordingRow> = {}): CallsRecordingRow {
  return {
    id: 'r-1',
    contact_id: null,
    direction: null,
    call_type: null,
    duration_seconds: null,
    recorded_at: null,
    created_at: '2026-10-04T12:00:00.000Z',
    ...over,
  };
}

describe('averageDurationSecs', () => {
  it('averages only measured durations', () => {
    expect(
      averageDurationSecs([row({ duration_seconds: 60 }), row({ duration_seconds: 120 }), row()])
    ).toBe(90);
  });
  it('nulls when nothing was measured', () => {
    expect(averageDurationSecs([])).toBeNull();
    expect(averageDurationSecs([row()])).toBeNull();
  });
  it('ignores non-finite durations', () => {
    expect(averageDurationSecs([row({ duration_seconds: NaN }), row({ duration_seconds: 40 })])).toBe(
      40
    );
  });
});

describe('directionDurationSecs', () => {
  it('sums durations per direction, excluding NULL directions', () => {
    expect(
      directionDurationSecs([
        row({ direction: 'in', duration_seconds: 60 }),
        row({ direction: 'in', duration_seconds: 30 }),
        row({ direction: 'out', duration_seconds: 120 }),
        row({ direction: null, duration_seconds: 999 }),
        row({ direction: 'in', duration_seconds: null }),
      ])
    ).toEqual({ incomingDurationSecs: 90, outgoingDurationSecs: 120 });
  });

  it('nulls each side independently when it measured nothing', () => {
    expect(directionDurationSecs([])).toEqual({
      incomingDurationSecs: null,
      outgoingDurationSecs: null,
    });
    expect(directionDurationSecs([row({ direction: 'out', duration_seconds: 50 })])).toEqual({
      incomingDurationSecs: null,
      outgoingDurationSecs: 50,
    });
    // NULL direction counts toward Total Calls but neither side.
    expect(directionDurationSecs([row({ direction: null, duration_seconds: 50 })])).toEqual({
      incomingDurationSecs: null,
      outgoingDurationSecs: null,
    });
  });

  it('ignores non-finite durations', () => {
    expect(
      directionDurationSecs([
        row({ direction: 'in', duration_seconds: NaN }),
        row({ direction: 'out', duration_seconds: Infinity }),
      ])
    ).toEqual({ incomingDurationSecs: null, outgoingDurationSecs: null });
  });
});

describe('percentChange', () => {
  it('computes signed percent change', () => {
    expect(percentChange(118, 100)).toBeCloseTo(18);
    expect(percentChange(88, 100)).toBeCloseTo(-12);
  });
  it('nulls on zero or missing previous values instead of inventing a trend', () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
    expect(percentChange(null, 5)).toBeNull();
  });
});

describe('bucketDaily', () => {
  const from = Date.parse('2026-10-01T00:00:00.000Z');
  const to = Date.parse('2026-10-04T00:00:00.000Z');
  it('zero-fills every day and splits directions', () => {
    const buckets = bucketDaily(
      [
        row({ id: 'a', direction: 'in', duration_seconds: 30, recorded_at: '2026-10-02T10:00:00.000Z' }),
        row({ id: 'b', direction: 'out', duration_seconds: 90, recorded_at: '2026-10-02T11:00:00.000Z' }),
        row({ id: 'c', direction: null, recorded_at: '2026-10-03T10:00:00.000Z' }),
      ],
      { fromMs: from, toMs: to, timeZone: 'UTC' }
    );
    expect(buckets.map((b) => b.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(buckets[0]).toMatchObject({ inbound: 0, outbound: 0, unknown: 0, durationSecs: 0 });
    expect(buckets[1]).toMatchObject({ inbound: 1, outbound: 1, durationSecs: 120 });
    expect(buckets[2]).toMatchObject({ unknown: 1 });
  });
  it('files recordings on the viewer calendar day, not the UTC day', () => {
    // 01:30 IST Oct 3 == 20:00 UTC Oct 2: UTC bucketing would misfile it.
    const buckets = bucketDaily(
      [row({ id: 'a', direction: 'in', recorded_at: '2026-10-02T20:00:00.000Z' })],
      { fromMs: from, toMs: to, timeZone: 'Asia/Kolkata' }
    );
    const oct3 = buckets.find((b) => b.date === '2026-10-03');
    expect(oct3?.inbound).toBe(1);
  });
  it('uses created_at when recorded_at is null', () => {
    const buckets = bucketDaily(
      [row({ id: 'a', direction: 'out', created_at: '2026-10-01T05:00:00.000Z' })],
      { fromMs: from, toMs: to, timeZone: 'UTC' }
    );
    expect(buckets[0].outbound).toBe(1);
  });
});

describe('bucketDurations', () => {  it('histograms only measured durations', () => {
    expect(
      bucketDurations([
        row({ duration_seconds: 10 }),
        row({ duration_seconds: 30 }),
        row({ duration_seconds: 200 }),
        row({ duration_seconds: 400 }),
        row({ duration_seconds: 900 }),
        row(),
      ])
    ).toEqual({ under30: 1, from30To60: 1, min1To5: 1, min5To10: 1, over10: 1 });
  });
});

describe('topClientsByRecordings', () => {
  it('ranks linked contacts, excludes unlinked, ties break by talk time', () => {
    const top = topClientsByRecordings(
      [
        row({ id: 'a', contact_id: 'c1', duration_seconds: 10, recorded_at: '2026-10-01T10:00:00Z' }),
        row({ id: 'b', contact_id: 'c1', duration_seconds: 10, recorded_at: '2026-10-02T10:00:00Z' }),
        row({ id: 'c', duration_seconds: 999 }),
        row({ id: 'd', contact_id: 'c2', duration_seconds: 500, recorded_at: '2026-10-03T10:00:00Z' }),
      ],
      5
    );
    expect(top.map((t) => t.contactId)).toEqual(['c1', 'c2']);
    expect(top[0]).toMatchObject({ recordings: 2, talkTimeSecs: 20 });
    expect(top[1]).toMatchObject({ recordings: 1, talkTimeSecs: 500 });
  });
});

describe('latestRecordings', () => {
  it('orders by effective time and caps the limit', () => {
    const rows = [
      row({ id: 'old', recorded_at: '2026-10-01T10:00:00Z' }),
      row({ id: 'new', recorded_at: '2026-10-03T10:00:00Z' }),
      row({ id: 'fallback', created_at: '2026-10-04T10:00:00Z' }),
    ];
    expect(latestRecordings(rows, 2).map((r) => r.id)).toEqual(['fallback', 'new']);
  });
});
