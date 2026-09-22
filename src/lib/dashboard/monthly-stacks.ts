// Pure transform: RPC monthly flow data → stacked-chart model.
//
// - Totals are NEVER recomputed here: `total` passes through from
//   the RPC (which mirrors monthlyUniqueContacts), so the numbers
//   above the bars cannot drift from the existing chart.
// - Segments only regroup the per-flow split: the top
//   MAX_NAMED_FLOWS flows (ranked by year-wide contacts) keep
//   their own segment; smaller flows merge into "Others".
//   Regrouping preserves the month sum by construction.
// - "No flow" (unattributed contacts) is never merged into
//   "Others" — it stays its own gray segment.
// - Key/stack order is stable (year-rank desc, then Others,
//   then No flow) so colors and legend don't jump between months.

import {
  NO_FLOW_COLOR,
  NO_FLOW_KEY,
  NO_FLOW_LABEL,
  OTHERS_COLOR,
  OTHERS_KEY,
  OTHERS_LABEL,
  assignFlowColors,
} from './flow-colors'
import type { MonthlyFlowMonth } from './types'

export const MAX_NAMED_FLOWS = 7

export interface StackKey {
  /** Bar dataKey + legend identity. Flow id, or a reserved bucket. */
  key: string
  flowId: string | null
  name: string
  color: string
}

export interface StackSegment extends StackKey {
  value: number
}

export interface StackMonth {
  month: number
  total: number
  /** In stack order (bottom → top). Zero values included. */
  segments: StackSegment[]
}

export interface MonthlyStacks {
  keys: StackKey[]
  months: StackMonth[]
}

export function buildMonthlyStacks(input: MonthlyFlowMonth[]): MonthlyStacks {
  const byMonth = new Map<number, MonthlyFlowMonth>()
  for (const m of input ?? []) {
    if (m && m.month >= 1 && m.month <= 12 && !byMonth.has(m.month)) {
      byMonth.set(m.month, m)
    }
  }

  // Year-wide contacts per named flow (for stable ranking).
  const yearTotals = new Map<string, number>()
  const latestName = new Map<string, string>()
  let yearNoFlow = 0
  for (let month = 1; month <= 12; month++) {
    const m = byMonth.get(month)
    if (!m) continue
    for (const f of m.flows ?? []) {
      if (!f || typeof f.uniqueContacts !== 'number') continue
      if (f.flowId === null) {
        yearNoFlow += f.uniqueContacts
      } else {
        yearTotals.set(f.flowId, (yearTotals.get(f.flowId) ?? 0) + f.uniqueContacts)
        if (typeof f.flowName === 'string' && f.flowName) {
          latestName.set(f.flowId, f.flowName)
        }
      }
    }
  }

  const ranked = [...yearTotals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const namedIds = ranked.slice(0, MAX_NAMED_FLOWS).map(([id]) => id)
  const overflowIds = ranked.slice(MAX_NAMED_FLOWS).map(([id]) => id)

  // Unique color per flow across the whole year (never two flows
  // sharing a slot; reserved buckets sit outside the palette).
  const colors = assignFlowColors(namedIds)
  const colorOf = (id: string): string => colors.get(id) ?? OTHERS_COLOR

  const keys: StackKey[] = namedIds.map((id) => ({
    key: id,
    flowId: id,
    name: latestName.get(id) ?? id,
    color: colorOf(id),
  }))

  const yearOthers = overflowIds.reduce((s, id) => s + (yearTotals.get(id) ?? 0), 0)
  const hasOthers = yearOthers > 0
  if (hasOthers) {
    keys.push({ key: OTHERS_KEY, flowId: OTHERS_KEY, name: OTHERS_LABEL, color: OTHERS_COLOR })
  }
  const hasNoFlow = yearNoFlow > 0
  if (hasNoFlow) {
    keys.push({ key: NO_FLOW_KEY, flowId: null, name: NO_FLOW_LABEL, color: NO_FLOW_COLOR })
  }

  const months: StackMonth[] = []
  for (let month = 1; month <= 12; month++) {
    const m = byMonth.get(month)
    const perFlow = new Map<string, number>()
    let noFlow = 0
    for (const f of m?.flows ?? []) {
      if (!f || typeof f.uniqueContacts !== 'number' || f.uniqueContacts <= 0) continue
      if (f.flowId === null) noFlow += f.uniqueContacts
      else perFlow.set(f.flowId, (perFlow.get(f.flowId) ?? 0) + f.uniqueContacts)
    }
    const segments: StackSegment[] = namedIds.map((id) => ({
      key: id,
      flowId: id,
      name: latestName.get(id) ?? id,
      color: colorOf(id),
      value: perFlow.get(id) ?? 0,
    }))
    if (hasOthers) {
      let v = 0
      for (const id of overflowIds) v += perFlow.get(id) ?? 0
      // Overflow flows renamed mid-year keep their latest name in
      // the tooltip via the RPC; the grouped value is what matters.
      segments.push({
        key: OTHERS_KEY,
        flowId: OTHERS_KEY,
        name: OTHERS_LABEL,
        color: OTHERS_COLOR,
        value: v,
      })
    }
    if (hasNoFlow) {
      segments.push({
        key: NO_FLOW_KEY,
        flowId: null,
        name: NO_FLOW_LABEL,
        color: NO_FLOW_COLOR,
        value: noFlow,
      })
    }
    months.push({ month, total: m?.total ?? 0, segments })
  }

  return { keys, months }
}
