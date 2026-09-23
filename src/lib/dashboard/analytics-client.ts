// Single-request dashboard loader.
//
// BEFORE: the page called loadDashboardKpis / loadFlowBreakdown /
// loadMonthlyUniques, each of which paginated raw message stubs
// (`messages?select=conversation_id,created_at`, 1000 rows/page)
// plus 200-id conversation chunks into the browser — ~89
// requests / ~8.7 MB per load, with the same rows downloaded 3-4x.
//
// AFTER: one GET /api/dashboard/analytics per (range, year),
// aggregated inside Postgres. No Supabase calls from the browser.

import type {
  DailyContactsDay,
  DailyFlowDay,
  DashboardKpis,
  FlowBreakdownRow,
  MonthlyFlowMonth,
  MonthlyFlowSegment,
} from './types'
import { normalizeContactsByAd } from './contacts-by-ad'
import { dayKeysBetween, fillDailyContacts, fillDailyFlows } from './daily-range'
import type { ContactsByAd } from './types'

export interface DashboardAnalyticsParams {
  startISO: string
  endISO: string
  prevStartISO: string
  prevEndISO: string
  yearStartISO: string
  yearEndISO: string
  year: number
  tz: string
  /**
   * Optional custom window for the daily chart only (YYYY-MM-DD).
   * Both or neither; when absent the RPC serves trailing-30.
   */
  dailyStart?: string
  dailyEnd?: string
}

export interface DashboardAnalyticsResult {
  kpis: DashboardKpis
  flowRows: FlowBreakdownRow[]
  flowTotalContacts: number
  contactsByAd: ContactsByAd
  daily: DailyContactsDay[]
  dailyFlows: DailyFlowDay[]
  monthly: number[]
  /**
   * Per-flow monthly split for the stacked chart. Empty when the
   * backend predates migration 075 — the chart then falls back to
   * solid bars driven by `monthly` (totals unaffected).
   */
  monthlyFlows: MonthlyFlowMonth[]
}

function isDelta(v: unknown): v is { current: number; previous: number } {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.current === 'number' && typeof o.previous === 'number'
}

export async function loadDashboardAnalytics(
  params: DashboardAnalyticsParams,
  signal?: AbortSignal,
): Promise<DashboardAnalyticsResult> {
  const qs = new URLSearchParams({
    start: params.startISO,
    end: params.endISO,
    prevStart: params.prevStartISO,
    prevEnd: params.prevEndISO,
    yearStart: params.yearStartISO,
    yearEnd: params.yearEndISO,
    year: String(params.year),
    tz: params.tz,
    ...(params.dailyStart && params.dailyEnd
      ? { dailyStart: params.dailyStart, dailyEnd: params.dailyEnd }
      : {}),
  })
  const res = await fetch(`/api/dashboard/analytics?${qs.toString()}`, {
    signal,
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`Dashboard analytics failed: ${res.status}`)
  }
  const json = (await res.json()) as {
    kpis?: Record<string, unknown>
    flowBreakdown?: { rows?: unknown; totalContacts?: unknown }
    contactsByAd?: unknown
    dailyContacts?: unknown
    dailyFlows?: unknown
    monthlyUniqueContacts?: unknown
    monthlyFlows?: unknown
  }

  const kpisRaw = json.kpis ?? {}
  if (!isDelta(kpisRaw.uniqueContacts)) {
    throw new Error('Dashboard analytics returned an unexpected shape')
  }
  // Legacy message/new-contact/new-conversation deltas are ignored
  // when present — the dashboard renders the unique-contacts KPI only.
  const kpis: DashboardKpis = {
    uniqueContacts: kpisRaw.uniqueContacts,
  }

  const rowsRaw = json.flowBreakdown?.rows
  const flowRows: FlowBreakdownRow[] = Array.isArray(rowsRaw)
    ? (rowsRaw as Array<Record<string, unknown>>)
        .filter(
          (r): r is Record<string, unknown> =>
            !!r &&
            typeof r === 'object' &&
            (r.flowId === null || typeof r.flowId === 'string') &&
            typeof r.flowName === 'string' &&
            typeof r.contacts === 'number' &&
            typeof r.pct === 'number',
        )
        .map((r) => ({
          flowId: r.flowId as string | null,
          flowName: r.flowName as string,
          contacts: r.contacts as number,
          pct: r.pct as number,
        }))
    : []
  const flowTotalContacts =
    typeof json.flowBreakdown?.totalContacts === 'number'
      ? json.flowBreakdown.totalContacts
      : 0

  const monthly: number[] = Array.isArray(json.monthlyUniqueContacts)
    ? (json.monthlyUniqueContacts as unknown[]).map((v) =>
        typeof v === 'number' && Number.isFinite(v) ? v : 0,
      )
    : []
  while (monthly.length < 12) monthly.push(0)

  const daily = normalizeDailyContacts(json.dailyContacts)

  const dailyFlows = normalizeDailyFlows(json.dailyFlows)

  const contactsByAd = normalizeContactsByAd(json.contactsByAd)

  // monthlyFlows is additive: totals keep coming from
  // monthlyUniqueContacts above. Malformed entries are dropped;
  // a missing key (pre-075 backend) yields [] → solid-bar fallback.
  const monthlyFlows: MonthlyFlowMonth[] = Array.isArray(json.monthlyFlows)
    ? (json.monthlyFlows as unknown[])
        .filter(
          (m): m is Record<string, unknown> =>
            !!m &&
            typeof m === 'object' &&
            typeof (m as Record<string, unknown>).month === 'number' &&
            Array.isArray((m as Record<string, unknown>).flows),
        )
        .map((m) => {
          const monthNum = m.month as number
          const flows = (m.flows as unknown[]).filter(
            (f): f is { flowId: string | null; flowName: string; uniqueContacts: number } => {
              if (!f || typeof f !== 'object') return false
              const r = f as Record<string, unknown>
              return (
                (r.flowId === null || typeof r.flowId === 'string') &&
                typeof r.flowName === 'string' &&
                typeof r.uniqueContacts === 'number'
              )
            },
          )
          return {
            month: monthNum,
            total: typeof m.total === 'number' ? m.total : 0,
            flows,
          }
        })
        .filter((m) => m.month >= 1 && m.month <= 12)
    : []

  return {
    kpis,
    flowRows,
    flowTotalContacts,
    contactsByAd,
    daily,
    dailyFlows,
    monthly: monthly.slice(0, 12),
    monthlyFlows,
  }
}

/**
 * Validate one flow segment shared by the monthly and daily splits.
 */
function isFlowSegment(f: unknown): f is MonthlyFlowSegment {
  if (!f || typeof f !== 'object') return false
  const r = f as Record<string, unknown>
  return (
    (r.flowId === null || typeof r.flowId === 'string') &&
    typeof r.flowName === 'string' &&
    typeof r.uniqueContacts === 'number'
  )
}

/**
 * Normalize the RPC `dailyFlows` payload to exactly `dayCount` days
 * (default 30, preserving the trailing-30 behavior). Malformed days
 * are dropped (never fabricated); short payloads are front-padded
 * with empty days so the trailing edge stays aligned; long payloads
 * keep the most recent `dayCount`.
 */
export function normalizeDailyFlows(input: unknown, dayCount: number = 30): DailyFlowDay[] {
  const days: DailyFlowDay[] = Array.isArray(input)
    ? (input as unknown[]).flatMap((d) => {
        if (!d || typeof d !== 'object') return []
        const r = d as Record<string, unknown>
        if (
          typeof r.date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
          typeof r.total !== 'number' ||
          !Number.isFinite(r.total) ||
          r.total < 0 ||
          !Array.isArray(r.flows)
        ) {
          return []
        }
        // Malformed segments are dropped individually (same rule as
        // the monthly split); the day itself survives.
        const flows = (r.flows as unknown[]).filter(isFlowSegment)
        return [
          {
            date: r.date,
            total: Math.floor(r.total),
            flows: flows.map((f) => ({
              flowId: f.flowId,
              flowName: f.flowName,
              uniqueContacts: Math.floor(f.uniqueContacts),
            })),
          },
        ]
      })
    : []
  const trimmed = days.slice(-dayCount)
  while (trimmed.length < dayCount) {
    trimmed.unshift({ date: '', total: 0, flows: [] })
  }
  return trimmed
}

/**
 * Normalize the RPC `dailyContacts` payload to exactly `dayCount`
 * days (default 30, preserving the trailing-30 behavior). Malformed
 * entries are dropped (never fabricated); short payloads are
 * front-padded with zero days so the chart window stays aligned
 * to the trailing edge; long payloads keep the most recent
 * `dayCount`.
 */
export function normalizeDailyContacts(input: unknown, dayCount: number = 30): DailyContactsDay[] {
  const days: DailyContactsDay[] = Array.isArray(input)
    ? (input as unknown[]).flatMap((d) => {
        if (!d || typeof d !== 'object') return []
        const r = d as Record<string, unknown>
        if (
          typeof r.date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
          typeof r.contacts !== 'number' ||
          !Number.isFinite(r.contacts) ||
          r.contacts < 0
        ) {
          return []
        }
        return [{ date: r.date, contacts: Math.floor(r.contacts) }]
      })
    : []
  const trimmed = days.slice(-dayCount)
  while (trimmed.length < dayCount) {
    trimmed.unshift({ date: '', contacts: 0 })
  }
  return trimmed
}

export interface DailyRangeData {
  /** One entry per calendar day in the range, zeros included. */
  contacts: DailyContactsDay[]
  /** Same days with their per-flow unique-contact split. */
  flows: DailyFlowDay[]
}

/**
 * Fetch one arbitrary daily window for the daily chart's custom
 * range. Same endpoint, same RPC, same unique-contact semantics —
 * only the daily window differs (via dailyStart/dailyEnd). The
 * required KPI/year params do not affect the daily output; the
 * caller's current day/year are sent so the request stays valid.
 * Returns ONLY daily data — KPI/monthly payload keys are ignored,
 * so other dashboard sections can never be affected.
 */
export async function loadDailyRange(
  fromKey: string,
  toKey: string,
  tz: string,
  signal?: AbortSignal,
): Promise<DailyRangeData> {
  const keys = dayKeysBetween(fromKey, toKey)
  if (!keys) {
    throw new Error('loadDailyRange requires a valid from/to day range')
  }
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const nextStart = new Date(dayStart)
  nextStart.setDate(nextStart.getDate() + 1)
  const prevStart = new Date(dayStart)
  prevStart.setDate(prevStart.getDate() - 1)
  const year = now.getFullYear()
  const qs = new URLSearchParams({
    start: dayStart.toISOString(),
    end: nextStart.toISOString(),
    prevStart: prevStart.toISOString(),
    prevEnd: dayStart.toISOString(),
    yearStart: new Date(year, 0, 1).toISOString(),
    yearEnd: new Date(year + 1, 0, 1).toISOString(),
    year: String(year),
    tz,
    dailyStart: fromKey,
    dailyEnd: toKey,
  })
  const res = await fetch(`/api/dashboard/analytics?${qs.toString()}`, {
    signal,
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`Daily range request failed: ${res.status}`)
  }
  const json = (await res.json()) as {
    dailyContacts?: unknown
    dailyFlows?: unknown
  }
  // Normalize to the window length, then pin to the exact keys so
  // every calendar day renders one bar (missing days → zeros).
  const contacts = fillDailyContacts(normalizeDailyContacts(json.dailyContacts, keys.length), keys)
  const flows = fillDailyFlows(normalizeDailyFlows(json.dailyFlows, keys.length), keys)
  return { contacts, flows }
}
