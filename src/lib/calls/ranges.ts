// ============================================================
// Dashboard date ranges for /calls — presets plus custom, all
// anchored to calendar days in the viewer's time zone (DST-safe
// via the shared periods helpers). Each range carries its
// previous equal-length window for period-over-period deltas.
// ============================================================

import { tzMidnightMinus, tzOffsetMs, validTimeZone } from './periods';

export type CallsRangeKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'last90' | 'custom';

export interface CallsRange {
  key: CallsRangeKey;
  fromISO: string;
  toISO: string;
  /** Previous equal-length window [prevFrom, from). */
  prevFromISO: string;
  prevToISO: string;
  label: string;
  prevLabel: string;
  /** Whole calendar days in the range (for the "vs previous N days" line). */
  days: number;
}

export const RANGE_OPTIONS: Array<{ key: CallsRangeKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 Days' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'last90', label: 'Last 90 Days' },
  { key: 'custom', label: 'Custom' },
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Midnight-to-midnight (or now) window with its previous twin. */
function windowRange(
  key: CallsRangeKey,
  label: string,
  fromDaysAgo: number,
  /** Days-ago for the exclusive end, or null for now (open partial day). */
  toDaysAgo: number | null,
  nowMs: number,
  tz: string
): CallsRange {
  const from = tzMidnightMinus(nowMs, fromDaysAgo, tz);
  const to = toDaysAgo === null ? nowMs : tzMidnightMinus(nowMs, toDaysAgo, tz);
  const span = to - from;
  const days = Math.max(1, Math.round(span / 86_400_000));
  return {
    key,
    fromISO: iso(from),
    toISO: iso(to),
    prevFromISO: iso(from - span),
    prevToISO: iso(from),
    label,
    prevLabel: `vs previous ${days} day${days === 1 ? '' : 's'}`,
    days,
  };
}

export function getCallsRange(
  key: CallsRangeKey,
  nowMs: number,
  timeZone: string,
  custom?: { fromInput: string; toInput: string }
): CallsRange {
  const tz = validTimeZone(timeZone);
  switch (key) {
    case 'today':
      return windowRange(key, 'Today', 0, null, nowMs, tz);
    case 'yesterday':
      return windowRange(key, 'Yesterday', 1, 0, nowMs, tz);
    case 'last7':
      return windowRange(key, 'Last 7 Days', 6, null, nowMs, tz);
    case 'last30':
      return windowRange(key, 'Last 30 Days', 29, null, nowMs, tz);
    case 'last90':
      return windowRange(key, 'Last 90 Days', 89, null, nowMs, tz);
    case 'custom': {
      // Inputs are calendar days in the viewer's zone: resolve each to
      // that zone's midnight (two offset passes, same as tzMidnightMinus)
      // so the window matches the days the user picked.
      const parseDay = (input: string): number => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
        if (!m) return Number.NaN;
        const approx = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const first = approx - tzOffsetMs(approx + 43_200_000, tz);
        return approx - tzOffsetMs(first + 43_200_000, tz);
      };
      const fromMs = custom ? parseDay(custom.fromInput) : Number.NaN;
      // toInput is inclusive: the window ends at the next calendar day's
      // midnight in-zone (exact even across DST, since it is a real midnight).
      const shiftDay = (input: string, by: number): string => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
        if (!m) return '';
        const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + by * 86_400_000);
        return t.toISOString().slice(0, 10);
      };
      const toMs = custom ? parseDay(shiftDay(custom.toInput, 1)) : Number.NaN;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !(fromMs < toMs)) {
        // Stay on Custom but show sane data rather than nothing.
        return windowRange('custom', 'Last 30 Days', 29, null, nowMs, tz);
      }
      const span = toMs - fromMs;
      const days = Math.max(1, Math.round(span / 86_400_000));
      return {
        key,
        fromISO: iso(fromMs),
        toISO: iso(toMs),
        prevFromISO: iso(fromMs - span),
        prevToISO: iso(fromMs),
        label: `${custom!.fromInput} → ${custom!.toInput}`,
        prevLabel: `vs previous ${days} day${days === 1 ? '' : 's'}`,
        days,
      };
    }
  }
}

/** YYYY-MM-DD for <input type="date"> in tz. */
export function toDateInputValue(ms: number, timeZone: string): string {
  const tz = validTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
