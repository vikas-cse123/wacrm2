// Pure helpers for the "Contacts Messaged" chart's own date-range
// control (Last 30 Days / Custom). Everything here is calendar-day
// key based (YYYY-MM-DD, caller timezone) with no Date parsing, so
// there is no timezone shift — the same convention the RPC uses
// when it buckets (day, contact) pairs.
//
// Scope: this control belongs ONLY to the daily chart. It never
// touches KPI, monthly, or analytics semantics — it only resolves
// which day keys the chart renders and fills gaps with explicit
// zeros so every calendar day in the range gets exactly one bar.

import { MONTH_SHORT, parseDateInput } from './date-utils'
import type { DailyContactsDay, DailyFlowDay } from './types'

/** Hard cap on a custom window (matches the API/RPC guard). */
export const MAX_DAILY_RANGE_DAYS = 366

/** Strict YYYY-MM-DD calendar-day check (real date, no overflow). */
export function isValidDayKey(value: string): boolean {
  return parseDateInput(value) !== null
}

/**
 * Inclusive chronological day keys from `fromKey` to `toKey`.
 * Returns null when either key is invalid, the end precedes the
 * start, or the span exceeds MAX_DAILY_RANGE_DAYS.
 */
export function dayKeysBetween(
  fromKey: string,
  toKey: string,
  maxDays: number = MAX_DAILY_RANGE_DAYS,
): string[] | null {
  const from = parseDateInput(fromKey)
  const to = parseDateInput(toKey)
  if (!from || !to) return null
  // Compare at day granularity (parseDateInput already yields
  // local midnights, but diff in days to avoid DST edge cases).
  const spanMs = to.getTime() - from.getTime()
  const spanDays = Math.round(spanMs / 86_400_000)
  if (spanDays < 0 || spanDays + 1 > maxDays) return null
  const keys: string[] = []
  const cursor = new Date(from)
  for (let i = 0; i <= spanDays; i++) {
    const y = cursor.getFullYear()
    const m = String(cursor.getMonth() + 1).padStart(2, '0')
    const d = String(cursor.getDate()).padStart(2, '0')
    keys.push(`${y}-${m}-${d}`)
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

/** "01 Sep 2026" without Date parsing (no timezone shift). */
export function formatDayKeyLong(key: string): string {
  const parts = key.split('-')
  if (parts.length !== 3) return key
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return key
  return `${d} ${MONTH_SHORT[m - 1] ?? ''} ${y}`
}

/** "01 Sep 2026 – 19 Sep 2026" for the control + subtitle. */
export function formatDayRangeLabel(fromKey: string, toKey: string): string {
  return `${formatDayKeyLong(fromKey)} – ${formatDayKeyLong(toKey)}`
}

/**
 * Validate a custom (from, to) pair from the picker. Returns the
 * human error to display, or null when the pair is usable.
 * Invalid ranges are rejected — the chart keeps its previous
 * range instead of rendering a broken window.
 */
export function validateCustomDailyRange(fromKey: string, toKey: string): string | null {
  if (!fromKey || !toKey) return 'Pick a start and an end date.'
  if (!isValidDayKey(fromKey) || !isValidDayKey(toKey)) {
    return 'Pick valid start and end dates.'
  }
  if (toKey < fromKey) return 'End date must be on or after the start date.'
  const keys = dayKeysBetween(fromKey, toKey)
  if (!keys) return `Keep the range within ${MAX_DAILY_RANGE_DAYS} days.`
  return null
}

/**
 * Project daily contact totals onto exactly `keys` (chronological):
 * known days keep their unique-contact counts, missing days become
 * explicit zeros. Totals pass through untouched — never recomputed
 * or rescaled — so unique-contact semantics cannot drift.
 */
export function fillDailyContacts(
  days: DailyContactsDay[],
  keys: string[],
): DailyContactsDay[] {
  const byDate = new Map<string, number>()
  for (const d of days ?? []) {
    if (!d || typeof d.date !== 'string' || typeof d.contacts !== 'number') continue
    if (!byDate.has(d.date)) byDate.set(d.date, d.contacts)
  }
  return keys.map((date) => ({ date, contacts: byDate.get(date) ?? 0 }))
}

/**
 * Project the per-day flow split onto exactly `keys`: known days
 * keep their totals + segments, missing days become explicit
 * zero days with no segments. Zero-contact days are preserved so
 * the bar count always equals the selected range length.
 */
export function fillDailyFlows(days: DailyFlowDay[], keys: string[]): DailyFlowDay[] {
  const byDate = new Map<string, DailyFlowDay>()
  for (const d of days ?? []) {
    if (!d || typeof d.date !== 'string') continue
    if (!byDate.has(d.date)) byDate.set(d.date, d)
  }
  return keys.map((date) => byDate.get(date) ?? { date, total: 0, flows: [] })
}
