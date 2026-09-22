// Centralised date helpers for the dashboard so every chart / card
// agrees on what "today", "day boundary", and "day of week" mean.
// All boundaries are computed in the user's LOCAL timezone — which is
// what a business user intuitively expects when they say "today".

export function startOfLocalDay(d: Date = new Date()): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

export function daysAgoStart(days: number): Date {
  const out = startOfLocalDay()
  out.setDate(out.getDate() - days)
  return out
}

/** Date-only key (YYYY-MM-DD) for bucketing rows by local calendar day. */
export function localDayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Inclusive list of local-day keys spanning the last `n` days, in
 * chronological order. Useful for seeding chart buckets so days with
 * zero activity still render a 0-point in the line.
 */
export function lastNDayKeys(n: number): string[] {
  const keys: string[] = []
  const start = daysAgoStart(n - 1)
  for (let i = 0; i < n; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    keys.push(localDayKey(d))
  }
  return keys
}

/**
 * ISO day-of-week where 0 = Monday … 6 = Sunday. JavaScript's native
 * getDay() uses 0 = Sunday which is awkward for most business charts.
 */
export function mondayIndex(d: Date): number {
  const jsDow = d.getDay() // 0..6 with Sunday=0
  return (jsDow + 6) % 7
}

export const DOW_SHORT_MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

// ------------------------------------------------------------
// Redesigned dashboard date filter (Today / Yesterday / This Week /
// This Month / Custom). All boundaries are local-time; callers send
// them to Supabase as ISO strings (TIMESTAMPTZ). `end` is EXCLUSIVE
// so queries use gte(start).lt(end) with no overlap.
// ------------------------------------------------------------

export type DashboardDateFilter = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export interface DashboardRange {
  /** Inclusive local start. */
  start: Date
  /** Exclusive local end. */
  end: Date
  /** Previous equivalent-length period, for comparison. */
  prevStart: Date
  prevEnd: Date
  /** Human label for the current period ("Today", "12 – 18 May", …). */
  label: string
  /** Human label for the comparison ("yesterday", "previous period", …). */
  prevLabel: string
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

export function startOfLocalWeekMonday(now: Date = new Date()): Date {
  const idx = mondayIndex(now)
  const out = startOfLocalDay(now)
  out.setDate(out.getDate() - idx)
  return out
}

export function startOfLocalMonth(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
}

/** Parse YYYY-MM-DD from <input type="date"> into a local Date. Null on invalid. */
export function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return null
  }
  return parsed
}

/** YYYY-MM-DD for <input type="date"> value. */
export function toDateInputValue(d: Date): string {
  return localDayKey(d)
}

function withPrevious(start: Date, end: Date): { prevStart: Date; prevEnd: Date } {
  const durationMs = end.getTime() - start.getTime()
  const prevEnd = new Date(start)
  const prevStart = new Date(start.getTime() - durationMs)
  return { prevStart, prevEnd }
}

export function getDashboardRange(
  filter: DashboardDateFilter,
  now: Date = new Date(),
  customFrom?: string,
  customTo?: string,
): DashboardRange {
  const todayStart = startOfLocalDay(now)
  const tomorrowStart = addDays(todayStart, 1)

  if (filter === 'yesterday') {
    const start = addDays(todayStart, -1)
    const end = new Date(todayStart)
    return {
      start,
      end,
      prevStart: addDays(start, -1),
      prevEnd: new Date(start),
      label: 'Yesterday',
      prevLabel: 'previous day',
    }
  }

  if (filter === 'week') {
    const start = startOfLocalWeekMonday(now)
    const end = new Date(tomorrowStart)
    const { prevStart, prevEnd } = withPrevious(start, end)
    return { start, end, prevStart, prevEnd, label: 'This week', prevLabel: 'previous period' }
  }

  if (filter === 'month') {
    const start = startOfLocalMonth(now)
    const end = new Date(tomorrowStart)
    const { prevStart, prevEnd } = withPrevious(start, end)
    return { start, end, prevStart, prevEnd, label: 'This month', prevLabel: 'previous period' }
  }

  if (filter === 'custom') {
    const fromDate = customFrom ? parseDateInput(customFrom) : null
    const toDate = customTo ? parseDateInput(customTo) : null
    if (fromDate && toDate) {
      let start = startOfLocalDay(fromDate)
      let end = addDays(startOfLocalDay(toDate), 1)
      if (end < start) {
        const tmp = start
        start = addDays(end, -1)
        end = addDays(tmp, 1)
      }
      const { prevStart, prevEnd } = withPrevious(start, end)
      return {
        start,
        end,
        prevStart,
        prevEnd,
        label: `${localDayKey(start)} – ${localDayKey(addDays(end, -1))}`,
        prevLabel: 'previous period',
      }
    }
    // Fall back to today when the custom inputs are incomplete.
    const { prevStart, prevEnd } = withPrevious(todayStart, tomorrowStart)
    return { start: todayStart, end: tomorrowStart, prevStart, prevEnd, label: 'Today', prevLabel: 'yesterday' }
  }

  // 'today' (default)
  const { prevStart, prevEnd } = withPrevious(todayStart, tomorrowStart)
  return { start: todayStart, end: tomorrowStart, prevStart, prevEnd, label: 'Today', prevLabel: 'yesterday' }
}

/** Local [start, end) for a calendar month. monthIdx 0 = Jan. */
export function getMonthRange(year: number, monthIdx: number): { start: Date; end: Date } {
  const start = new Date(year, monthIdx, 1, 0, 0, 0, 0)
  const end = new Date(year, monthIdx + 1, 1, 0, 0, 0, 0)
  return { start, end }
}

/** Local [start, end) for a calendar year. */
export function getYearRange(year: number): { start: Date; end: Date } {
  return { start: new Date(year, 0, 1, 0, 0, 0, 0), end: new Date(year + 1, 0, 1, 0, 0, 0, 0) }
}
