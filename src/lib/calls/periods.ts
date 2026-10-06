// ============================================================
// Fixed Calls-dashboard periods: Today, Yesterday, Last Week
// (previous Monday–Sunday).
//
// All bounds are computed in the VIEWER's IANA timezone and
// returned as ISO instants for GET /api/calls/stats. Pure and
// unit-tested. DST-safe: each midnight resolves through the
// zone's actual offset (two passes), never via fixed 24h steps
// on local wall times.
// ============================================================

export interface CallsPeriod {
  key: 'today' | 'yesterday' | 'lastWeek';
  title: string;
  /** Inclusive start, ISO. */
  fromISO: string;
  /** Exclusive end (today's end is `nowMs`: 00:00 → now). */
  toISO: string;
  /** Short header label, e.g. "06 Oct 2026" / "28 Sep–04 Oct 2026". */
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function validTimeZone(timeZone: string): string {  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** YYYY-MM-DD parts of an epoch ms in tz. */
function dayParts(epochMs: number, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Zone offset (local − UTC, ms) at an instant. */
export function tzOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second')
  );
  return asUtc - epochMs;
}

/**
 * UTC instant of local midnight `daysAgo` days before the tz day
 * containing `nowMs`. Two offset passes keep a DST switch inside
 * the day exact.
 */
export function tzMidnightMinus(nowMs: number, daysAgo: number, timeZone: string): number {
  const { y, m, d } = dayParts(nowMs, timeZone);
  const approx = Date.UTC(y, m - 1, d) - daysAgo * 86_400_000;
  const first = approx - tzOffsetMs(approx + 43_200_000, timeZone);
  return approx - tzOffsetMs(first + 43_200_000, timeZone);
}

/** ISO weekday of an instant in tz: 0 = Monday … 6 = Sunday. */
function tzWeekdayMondayFirst(epochMs: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(epochMs));
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name);
}

function fmtDay(y: number, m: number, d: number, withYear: boolean): string {
  const base = `${String(d).padStart(2, '0')} ${MONTHS[m - 1] ?? ''}`;
  return withYear ? `${base} ${y}` : base;
}

/**
 * The three dashboard periods for `nowMs` in `timeZone`.
 * Invalid tz falls back to UTC.
 */
export function getCallsPeriods(nowMs: number, timeZone: string): CallsPeriod[] {
  const tz = validTimeZone(timeZone);
  const todayStart = tzMidnightMinus(nowMs, 0, tz);
  const yesterdayStart = tzMidnightMinus(nowMs, 1, tz);
  const daysSinceMonday = ((tzWeekdayMondayFirst(nowMs, tz) % 7) + 7) % 7;
  // Both Mondays resolve through the offset passes (never by
  // subtracting 168h, which a mid-week DST switch would skew).
  const thisMondayStart = tzMidnightMinus(nowMs, daysSinceMonday, tz);
  const lastMondayStart = tzMidnightMinus(nowMs, daysSinceMonday + 7, tz);

  const t = dayParts(todayStart, tz);
  const y = dayParts(yesterdayStart, tz);
  const lm = dayParts(lastMondayStart, tz);
  const ls = dayParts(thisMondayStart - 1, tz);

  return [
    {
      key: 'today',
      title: 'Today',
      fromISO: new Date(todayStart).toISOString(),
      toISO: new Date(nowMs).toISOString(),
      label: fmtDay(t.y, t.m, t.d, true),
    },
    {
      key: 'yesterday',
      title: 'Yesterday',
      fromISO: new Date(yesterdayStart).toISOString(),
      toISO: new Date(todayStart).toISOString(),
      label: fmtDay(y.y, y.m, y.d, true),
    },
    {
      key: 'lastWeek',
      title: 'Last Week',
      fromISO: new Date(lastMondayStart).toISOString(),
      toISO: new Date(thisMondayStart).toISOString(),
      label: `${fmtDay(lm.y, lm.m, lm.d, false)}–${fmtDay(ls.y, ls.m, ls.d, true)}`,
    },
  ];
}
