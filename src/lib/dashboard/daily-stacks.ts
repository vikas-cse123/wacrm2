// Pure transform: RPC daily flow data → stacked-chart model.
//
// Mirrors monthly-stacks.ts at day grain so both charts share one
// visual language (same palette, same Others/No-flow treatment,
// same tooltip contract):
// - Totals are NEVER recomputed here: `total` passes through from
//   the RPC (which mirrors dailyContacts), so the numbers above
//   the bars cannot drift.
// - Segments only regroup the per-flow split: the top
//   MAX_NAMED_FLOWS flows (ranked by window-wide contacts) keep
//   their own segment; smaller flows merge into "Others".
//   Regrouping preserves the day sum by construction.
// - "No flow" (unattributed contacts) is never merged into
//   "Others" — it stays its own gray segment.
// - Key/stack order is stable (window-rank desc, then Others,
//   then No flow) so colors and legend don't jump between days.
// - Colors come from the same assignFlowColors pool as the monthly
//   chart: identical id sets hash to identical colors, so a flow
//   never wears two colors across the two charts.

import {
  NO_FLOW_COLOR,
  NO_FLOW_KEY,
  NO_FLOW_LABEL,
  OTHERS_COLOR,
  OTHERS_KEY,
  OTHERS_LABEL,
  assignFlowColors,
} from './flow-colors'
import type { DailyFlowDay } from './types'
import type { StackKey, StackSegment } from './monthly-stacks'

export const MAX_NAMED_DAILY_FLOWS = 7

export interface DailyStackDay {
  /** YYYY-MM-DD in the caller's timezone ('' for padded days). */
  date: string
  total: number
  /** In stack order (bottom → top). Zero values included. */
  segments: StackSegment[]
}

export interface DailyStacks {
  keys: StackKey[]
  days: DailyStackDay[]
}

export function buildDailyStacks(input: DailyFlowDay[]): DailyStacks {
  const days = (input ?? []).slice(-30)

  // Window-wide contacts per named flow (for stable ranking).
  const windowTotals = new Map<string, number>()
  const latestName = new Map<string, string>()
  let windowNoFlow = 0
  for (const d of days) {
    for (const f of d?.flows ?? []) {
      if (!f || typeof f.uniqueContacts !== 'number') continue
      if (f.flowId === null) {
        windowNoFlow += f.uniqueContacts
      } else {
        windowTotals.set(f.flowId, (windowTotals.get(f.flowId) ?? 0) + f.uniqueContacts)
        if (typeof f.flowName === 'string' && f.flowName) {
          latestName.set(f.flowId, f.flowName)
        }
      }
    }
  }

  const ranked = [...windowTotals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const namedIds = ranked.slice(0, MAX_NAMED_DAILY_FLOWS).map(([id]) => id)
  const overflowIds = ranked.slice(MAX_NAMED_DAILY_FLOWS).map(([id]) => id)

  // Unique color per flow across the whole window (never two flows
  // sharing a slot; reserved buckets sit outside the palette).
  const colors = assignFlowColors(namedIds)
  const colorOf = (id: string): string => colors.get(id) ?? OTHERS_COLOR

  const keys: StackKey[] = namedIds.map((id) => ({
    key: id,
    flowId: id,
    name: latestName.get(id) ?? id,
    color: colorOf(id),
  }))

  const windowOthers = overflowIds.reduce((s, id) => s + (windowTotals.get(id) ?? 0), 0)
  const hasOthers = windowOthers > 0
  if (hasOthers) {
    keys.push({ key: OTHERS_KEY, flowId: OTHERS_KEY, name: OTHERS_LABEL, color: OTHERS_COLOR })
  }
  const hasNoFlow = windowNoFlow > 0
  if (hasNoFlow) {
    keys.push({ key: NO_FLOW_KEY, flowId: null, name: NO_FLOW_LABEL, color: NO_FLOW_COLOR })
  }

  const out: DailyStackDay[] = days.map((d) => {
    const perFlow = new Map<string, number>()
    let noFlow = 0
    for (const f of d?.flows ?? []) {
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
    return { date: typeof d?.date === 'string' ? d.date : '', total: d?.total ?? 0, segments }
  })

  return { keys, days: out }
}

export interface DailyTooltipRow extends StackKey {
  value: number
}

export interface DailyTooltip {
  /** Non-zero flows, largest first (matches the RPC row order). */
  rows: DailyTooltipRow[]
  total: number
}

/**
 * The exact rows the daily tooltip renders: every non-zero segment
 * of the day, largest first, each carrying the same color object
 * the bars and legend use.
 */
export function buildDailyTooltip(stacks: DailyStacks, dayIndex: number): DailyTooltip {
  const day = stacks.days[dayIndex]
  if (!day) return { rows: [], total: 0 }
  const rows = stacks.keys
    .map((k) => ({
      ...k,
      value: day.segments.find((g) => g.key === k.key)?.value ?? 0,
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
  return { rows, total: day.total }
}
