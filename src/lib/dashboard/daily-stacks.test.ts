import { describe, expect, it } from 'vitest'
import { buildDailyStacks, buildDailyTooltip, MAX_NAMED_DAILY_FLOWS } from './daily-stacks'
import { buildMonthlyStacks } from './monthly-stacks'
import type { DailyFlowDay } from './types'

function day(
  date: string,
  total: number,
  flows: Array<[string | null, string, number]>,
): DailyFlowDay {
  return {
    date,
    total,
    flows: flows.map(([flowId, flowName, uniqueContacts]) => ({
      flowId,
      flowName,
      uniqueContacts,
    })),
  }
}

describe('buildDailyStacks', () => {
  it('preserves daily totals with one segment per flow and no double counting', () => {
    const { keys, days } = buildDailyStacks([
      day('2026-09-12', 47, [
        ['f-goa', 'GOA', 21],
        ['f-sg', 'Singapore Chat Automation', 15],
        ['f-hiring', 'Hiring', 7],
        [null, 'No flow', 4],
      ]),
      day('2026-09-13', 0, []),
    ])

    expect(days).toHaveLength(2)
    const active = days[0]!
    expect(active.total).toBe(47)
    expect(active.segments.reduce((s, g) => s + g.value, 0)).toBe(47)
    // Zero day keeps its total with all-zero segments.
    expect(days[1]!.total).toBe(0)
    expect(days[1]!.segments.every((g) => g.value === 0)).toBe(true)
    // Key order is stable across days.
    expect(days[0]!.segments.map((g) => g.key)).toEqual(
      days[1]!.segments.map((g) => g.key),
    )
    expect(keys.map((k) => k.key)).toEqual(days[0]!.segments.map((g) => g.key))
    // No-flow stays its own segment, last.
    expect(active.segments.at(-1)).toMatchObject({ key: '__no_flow__', value: 4 })
  })

  it('groups flows beyond the cap into a mathematically exact Others', () => {
    const flows = Array.from(
      { length: 10 },
      (_, i): [string, string, number] => [`f-${i}`, `Flow ${i}`, 20 - i],
    )
    const { keys, days } = buildDailyStacks([
      day('2026-09-12', 165, [...flows, [null, 'No flow', 10]]),
    ])
    // 7 named + Others + No flow.
    expect(keys).toHaveLength(MAX_NAMED_DAILY_FLOWS + 2)
    const d = days[0]!
    expect(d.segments.reduce((s, g) => s + g.value, 0)).toBe(165)
    const others = d.segments.find((g) => g.key === '__others__')!
    // Overflow: f-7 (13) + f-8 (12) + f-9 (11) = 36.
    expect(others.value).toBe(13 + 12 + 11)
  })

  it('assigns a unique color to every key including No-flow and Others', () => {
    const { keys } = buildDailyStacks([
      day('2026-09-12', 30, [
        ['f-a', 'A', 12],
        ['f-b', 'B', 10],
        [null, 'No flow', 8],
      ]),
    ])
    const colors = keys.map((k) => k.color)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('uses the same colors as the monthly chart for the same flows', () => {
    const flows: Array<[string, string, number]> = [
      ['f-goa', 'GOA', 21],
      ['f-sg', 'Singapore', 15],
    ]
    const daily = buildDailyStacks([day('2026-09-12', 36, flows)])
    const monthly = buildMonthlyStacks([
      { month: 9, total: 36, flows: flows.map(([flowId, flowName, uniqueContacts]) => ({ flowId, flowName, uniqueContacts })) },
    ])
    const dailyColor = new Map(daily.keys.map((k) => [k.key, k.color]))
    const monthlyColor = new Map(monthly.keys.map((k) => [k.key, k.color]))
    for (const [id] of flows) {
      expect(dailyColor.get(id)).toBe(monthlyColor.get(id))
    }
  })
})

describe('buildDailyTooltip', () => {
  const stacks = buildDailyStacks([
    day('2026-09-12', 47, [
      ['f-goa', 'GOA', 21],
      ['f-sg', 'Singapore Chat Automation', 15],
      ['f-hiring', 'Hiring', 7],
      [null, 'No flow', 4],
    ]),
    day('2026-09-13', 0, []),
  ])

  it('contains every non-zero flow with segment-matching colors', () => {
    const { rows, total } = buildDailyTooltip(stacks, 0)
    expect(total).toBe(47)
    expect(rows.map((r) => r.value)).toEqual([21, 15, 7, 4])
    const byKey = new Map(stacks.keys.map((k) => [k.key, k.color]))
    for (const r of rows) {
      expect(r.color).toBe(byKey.get(r.key))
    }
    const pctSum = rows.reduce((s, r) => s + (r.value / total) * 100, 0)
    expect(pctSum).toBeCloseTo(100, 5)
  })

  it('preserves No flow and handles zero/unknown days', () => {
    const { rows } = buildDailyTooltip(stacks, 0)
    expect(rows.some((r) => r.flowId === null && r.name === 'No flow')).toBe(true)
    expect(buildDailyTooltip(stacks, 1)).toEqual({ rows: [], total: 0 })
    expect(buildDailyTooltip(stacks, 99)).toEqual({ rows: [], total: 0 })
  })
})
