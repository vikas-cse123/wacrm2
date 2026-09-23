// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}

// ------------------------------------------------------------
// Redesigned dashboard (travel-agency WhatsApp analytics).
// Only real message/contact/conversation/flow data — no pipelines,
// automations, AI, or insights.
// ------------------------------------------------------------

export interface KpiDelta {
  current: number
  previous: number
}

export interface DashboardKpis {
  /** True COUNT(DISTINCT contact_id) over messages in range. */
  uniqueContacts: KpiDelta
}

export interface FlowBreakdownRow {
  /** Flow id, or null for contacts with no attributable run. */
  flowId: string | null
  flowName: string
  /** Distinct contacts messaged in range attributed to this flow. */
  contacts: number
  /** Share of distinct contacts messaged in range, 0-100. */
  pct: number
}

export interface FlowBreakdown {
  rows: FlowBreakdownRow[]
  /** Distinct contacts messaged in range (denominator for pct). */
  totalContacts: number
}

// ------------------------------------------------------------
// Contacts by Ad: unique contacts per CTWA source in range.
// One row per bucket; bucket counts sum to the total and pct
// values sum to 100 (same invariant as the monthly stacks).
// ------------------------------------------------------------

export interface AdBucketRow {
  /** Ad source URL, or '__no_ad__' / '__others__'. */
  adKey: string
  /** Human label ('No Ad' / 'Other' for the reserved buckets). */
  adLabel: string
  /** Distinct contacts attributed to this bucket. */
  contacts: number
  /** Share of total chart contacts, 0-100. */
  pct: number
}

export interface ContactsByAd {
  rows: AdBucketRow[]
  /** Distinct contacts messaged in range (denominator for pct). */
  totalContacts: number
}

// ------------------------------------------------------------
// Daily chart: unique contacts per calendar day for the trailing
// 30 days (caller timezone). Always 30 entries, zero days included.
// ------------------------------------------------------------

export interface DailyContactsDay {
  /** Calendar day in the caller's timezone (YYYY-MM-DD). */
  date: string
  /** Distinct contacts with >=1 message that day. */
  contacts: number
}

// ------------------------------------------------------------
// Daily stacked chart: per-flow unique contacts per day.
// Same segment shape as the monthly split so both charts share
// one model: for every day, SUM(flows.uniqueContacts) === total,
// because each distinct (day, contact) is attributed to exactly
// one flow. `total` duplicates the dailyContacts count for that
// day.
// ------------------------------------------------------------

export interface DailyFlowDay {
  /** Calendar day in the caller's timezone (YYYY-MM-DD). */
  date: string
  /** Duplicates the dailyContacts total for this day. */
  total: number
  flows: MonthlyFlowSegment[]
}

// ------------------------------------------------------------
// Monthly stacked chart: per-flow unique contacts per month.
// `monthlyUniqueContacts` (number[]) remains the source of truth
// for month totals; these shapes only add the flow split.
// Invariant (enforced server-side): for every month,
// SUM(flows.uniqueContacts) === monthly total, because each
// distinct (month, contact) is attributed to exactly one flow.
// ------------------------------------------------------------

export interface MonthlyFlowSegment {
  /** Flow id, or null for contacts with no attributable run. */
  flowId: string | null
  flowName: string
  uniqueContacts: number
}

export interface MonthlyFlowMonth {
  /** 1 = Jan … 12 = Dec. Always 12 entries, zero months included. */
  month: number
  /** Duplicates the monthlyUniqueContacts total for this month. */
  total: number
  flows: MonthlyFlowSegment[]
}
