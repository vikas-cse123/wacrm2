import { describe, expect, it } from 'vitest';

import { getCallsPeriods } from './periods';

describe('getCallsPeriods', () => {
  // Tue 2026-10-06 10:00 IST (UTC+5:30, no DST).
  const NOW = Date.parse('2026-10-06T04:30:00.000Z');
  const TZ = 'Asia/Kolkata';

  it('builds today covering local midnight to now', () => {
    const [today] = getCallsPeriods(NOW, TZ);
    expect(today.key).toBe('today');
    expect(today.title).toBe('Today');
    expect(today.fromISO).toBe('2026-10-05T18:30:00.000Z');
    expect(today.toISO).toBe(new Date(NOW).toISOString());
    expect(today.label).toBe('06 Oct 2026');
  });

  it('builds yesterday as the full local day before', () => {
    const [, yesterday] = getCallsPeriods(NOW, TZ);
    expect(yesterday.fromISO).toBe('2026-10-04T18:30:00.000Z');
    expect(yesterday.toISO).toBe('2026-10-05T18:30:00.000Z');
    expect(yesterday.label).toBe('05 Oct 2026');
  });

  it('builds last week as previous Monday to Sunday', () => {
    const [, , lastWeek] = getCallsPeriods(NOW, TZ);
    // Previous Monday 28 Sep 00:00 IST → this Monday 05 Oct 00:00 IST.
    expect(lastWeek.fromISO).toBe('2026-09-27T18:30:00.000Z');
    expect(lastWeek.toISO).toBe('2026-10-04T18:30:00.000Z');
    expect(lastWeek.label).toBe('28 Sep–04 Oct 2026');
  });

  it('on a Sunday, last week is the completed Mon–Sun before this week', () => {
    // Sun 2026-10-11: current partial week starts Mon 05 Oct, so
    // the last COMPLETE week is Mon 28 Sep – Sun 04 Oct.
    const periods = getCallsPeriods(Date.parse('2026-10-11T04:30:00.000Z'), TZ);
    expect(periods[2].label).toBe('28 Sep–04 Oct 2026');
  });

  it('falls back to UTC on an invalid timezone', () => {
    const [today] = getCallsPeriods(NOW, 'Not/AZone');
    expect(today.fromISO).toBe('2026-10-06T00:00:00.000Z');
  });

  it('spans a US DST switch exactly (spring forward 2026)', () => {
    // DST starts Sun 2026-03-08 02:00 America/New_York. Take Mon 09 Mar.
    const monday = Date.parse('2026-03-09T14:00:00.000Z');
    const [, , lastWeek] = getCallsPeriods(monday, 'America/New_York');
    // Last Monday 02 Mar 00:00 EST (UTC-5) → this Monday 09 Mar 00:00 EDT (UTC-4).
    expect(lastWeek.fromISO).toBe('2026-03-02T05:00:00.000Z');
    expect(lastWeek.toISO).toBe('2026-03-09T04:00:00.000Z');
  });
});
