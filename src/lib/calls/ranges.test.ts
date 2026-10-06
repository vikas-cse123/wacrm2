// Dashboard ranges — calendar-day windows in the viewer zone.

import { describe, expect, it } from 'vitest';

import { getCallsRange, toDateInputValue } from './ranges';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');

describe('getCallsRange', () => {
  it('last30 covers 30 calendar days ending now, with an equal previous window', () => {
    const r = getCallsRange('last30', NOW, 'UTC');
    expect(r.days).toBe(30);
    expect(Date.parse(r.toISO)).toBe(NOW);
    // NOW is mid-day: the window is 29 whole days plus today's partial day.
    const span = Date.parse(r.toISO) - Date.parse(r.fromISO);
    expect(span).toBe(29 * 86_400_000 + 12 * 3_600_000);
    expect(Date.parse(r.fromISO) - Date.parse(r.prevFromISO)).toBe(span);
    expect(r.prevToISO).toBe(r.fromISO);
    expect(r.prevLabel).toBe('vs previous 30 days');
  });
  it('today starts at local midnight and yesterday is the day before', () => {
    const today = getCallsRange('today', NOW, 'Asia/Kolkata');
    // 06 Oct 17:30 IST == 12:00 UTC; midnight IST == 18:30 UTC previous day.
    expect(today.fromISO).toBe('2026-10-05T18:30:00.000Z');
    const y = getCallsRange('yesterday', NOW, 'Asia/Kolkata');
    expect(y.fromISO).toBe('2026-10-04T18:30:00.000Z');
    expect(y.toISO).toBe('2026-10-05T18:30:00.000Z');
  });
  it('custom resolves calendar days in-zone and falls back on garbage', () => {
    const r = getCallsRange('custom', NOW, 'Asia/Kolkata', {
      fromInput: '2026-10-01',
      toInput: '2026-10-05',
    });
    expect(r.fromISO).toBe('2026-09-30T18:30:00.000Z');
    expect(r.toISO).toBe('2026-10-05T18:30:00.000Z');
    expect(r.days).toBe(5);
    const bad = getCallsRange('custom', NOW, 'UTC', { fromInput: 'xx', toInput: 'yy' });
    expect(bad.key).toBe('custom');
    expect(bad.label).toBe('Last 30 Days');
  });
  it('toDateInputValue renders the zoned calendar day', () => {
    expect(toDateInputValue(NOW, 'Asia/Kolkata')).toBe('2026-10-06');
    expect(toDateInputValue(NOW, 'Pacific/Kiritimati')).toBe('2026-10-07');
  });
});
