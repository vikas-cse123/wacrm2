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

import type { DashboardKpis, FlowBreakdownRow, MonthlyFlowMonth } from './types'

export interface DashboardAnalyticsParams {
  startISO: string
  endISO: string
  prevStartISO: string
  prevEndISO: string
  yearStartISO: string
  yearEndISO: string
  year: number
  tz: string
}

export interface DashboardAnalyticsResult {
  kpis: DashboardKpis
  flowRows: FlowBreakdownRow[]
  flowTotalMessages: number
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
    flowBreakdown?: { rows?: unknown; totalMessages?: unknown }
    monthlyUniqueContacts?: unknown
    monthlyFlows?: unknown
  }

  const kpisRaw = json.kpis ?? {}
  if (
    !isDelta(kpisRaw.totalMessages) ||
    !isDelta(kpisRaw.uniqueContacts) ||
    !isDelta(kpisRaw.newContacts) ||
    !isDelta(kpisRaw.newConversations)
  ) {
    throw new Error('Dashboard analytics returned an unexpected shape')
  }
  const kpis: DashboardKpis = {
    totalMessages: kpisRaw.totalMessages,
    uniqueContacts: kpisRaw.uniqueContacts,
    newContacts: kpisRaw.newContacts,
    newConversations: kpisRaw.newConversations,
  }

  const rowsRaw = json.flowBreakdown?.rows
  const flowRows: FlowBreakdownRow[] = Array.isArray(rowsRaw)
    ? (rowsRaw as Array<Record<string, unknown>>)
        .filter(
          (r): r is Record<string, unknown> =>
            !!r &&
            typeof r === 'object' &&
            typeof (r as Record<string, unknown>).flowId === 'string' &&
            typeof r.flowName === 'string' &&
            typeof r.messages === 'number' &&
            typeof r.uniqueContacts === 'number' &&
            typeof r.pct === 'number',
        )
        .map((r) => ({
          flowId: r.flowId as string,
          flowName: r.flowName as string,
          messages: r.messages as number,
          uniqueContacts: r.uniqueContacts as number,
          pct: r.pct as number,
        }))
    : []
  const flowTotalMessages =
    typeof json.flowBreakdown?.totalMessages === 'number'
      ? json.flowBreakdown.totalMessages
      : 0

  const monthly: number[] = Array.isArray(json.monthlyUniqueContacts)
    ? (json.monthlyUniqueContacts as unknown[]).map((v) =>
        typeof v === 'number' && Number.isFinite(v) ? v : 0,
      )
    : []
  while (monthly.length < 12) monthly.push(0)

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
    flowTotalMessages,
    monthly: monthly.slice(0, 12),
    monthlyFlows,
  }
}
