// KPI-card duration display: seconds-first, then talk-time scale.

import { describe, expect, it } from 'vitest';

import { formatShortDuration } from './formatters';

describe('formatShortDuration', () => {
  it('renders sub-minute values as seconds', () => {
    expect(formatShortDuration(16)).toBe('16s');
    expect(formatShortDuration(0)).toBe('0s');
    expect(formatShortDuration(59)).toBe('59s');
  });

  it('reuses the talk-time scale above a minute', () => {
    expect(formatShortDuration(138)).toBe('2m 18s');
    expect(formatShortDuration(5040)).toBe('1h 24m');
  });

  it('renders an em dash for missing durations', () => {
    expect(formatShortDuration(null)).toBe('—');
    expect(formatShortDuration(undefined)).toBe('—');
    expect(formatShortDuration(Number.NaN)).toBe('—');
  });
});
