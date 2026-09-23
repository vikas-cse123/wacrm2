import { describe, expect, it } from 'vitest'
import { MAX_NAMED_FLOWS, buildMonthlyStacks, buildMonthTooltip } from './monthly-stacks'
import type { MonthlyFlowMonth } from './types'

function month(
  monthNum: number,
  total: number,
  flows: Array<[string | null, string, number]>,
): MonthlyFlowMonth {
  return {
    month: monthNum,
    total,
    flows: flows.map(([flowId, flowName, uniqueContacts]) => ({
      flowId,
      flowName,
      uniqueContacts,
    })),
  }
}

describe('buildMonthlyStacks', () => {
  it('preserves monthly totals and never double-counts a contact', () => {
    const { keys, months } = buildMonthlyStacks([
      month(7, 1174, [
        ['f-sg', 'Singapore', 432],
        ['f-bali', 'Bali Chat Flow', 298],
        ['f-kerala', 'Kerala Packages', 186],
        ['f-th', 'Thailand', 148],
        [null, 'No flow', 110],
      ]),
      month(8, 1266, [
        ['f-sg', 'Singapore', 900],
        ['f-bali', 'Bali Chat Flow', 300],
        [null, 'No flow', 66],
      ]),
    ])

    expect(months).toHaveLength(12)
    const jul = months[6]!
    const aug = months[7]!
    // Sum of segments equals the (untouched) total.
    expect(jul.segments.reduce((s, g) => s + g.value, 0)).toBe(1174)
    expect(aug.segments.reduce((s, g) => s + g.value, 0)).toBe(1266)
    expect(jul.total).toBe(1174)
    // Zero months stay segment-free (all values 0, no fake data).
    expect(months[0]!.total).toBe(0)
    expect(months[0]!.segments.every((g) => g.value === 0)).toBe(true)
    // Key order is stable across months.
    expect(jul.segments.map((g) => g.key)).toEqual(aug.segments.map((g) => g.key))
    expect(keys.map((k) => k.key)).toEqual(jul.segments.map((g) => g.key))
    // No-flow stays its own segment.
    expect(jul.segments.at(-1)).toMatchObject({ key: '__no_flow__', value: 110 })
  })

  it('groups flows beyond the cap into Others without changing totals', () => {
    const flows = Array.from(
      { length: MAX_NAMED_FLOWS + 3 },
      (_, i): [string, string, number] => [`f-${i}`, `Flow ${i}`, 100 - i],
    )
    const { keys, months } = buildMonthlyStacks([month(1, 1005, [...flows, [null, 'No flow', 50]])])
    const jan = months[0]!
    // 7 named + Others + No flow.
    expect(keys).toHaveLength(MAX_NAMED_FLOWS + 2)
    const others = jan.segments.find((g) => g.key === '__others__')!
    // Overflow: f-7 (93) + f-8 (92) + f-9 (91) = 276.
    expect(others.value).toBe(93 + 92 + 91)
    expect(jan.segments.reduce((s, g) => s + g.value, 0)).toBe(1005)
  })

  it('omits Others/No-flow keys when there is nothing to show', () => {
    const { keys } = buildMonthlyStacks([month(3, 10, [['f-a', 'A', 10]])])
    expect(keys.map((k) => k.key)).toEqual(['f-a'])
  })

  it('assigns a unique color to every key including No-flow and Others', () => {
    const flows = Array.from(
      { length: MAX_NAMED_FLOWS + 2 },
      (_, i): [string, string, number] => [`f-${i}`, `Flow ${i}`, 50 - i],
    )
    const { keys } = buildMonthlyStacks([
      month(7, 500, [...flows, [null, 'No flow', 20]]),
    ])
    const colors = keys.map((k) => k.color)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('exposes the complete per-flow breakdown the tooltip needs', () => {
    const { keys, months } = buildMonthlyStacks([
      month(7, 1174, [
        ['f-goa', 'GOA', 538],
        ['f-sg', 'Singapore Chat Automation', 437],
        ['f-hiring', 'Hiring', 152],
        [null, 'No flow', 45],
        ['f-couple', 'Goa Couple', 1],
        ['f-kerala', 'Kerala Chat Automation', 1],
      ]),
    ])
    const jul = months[6]!
    // Every non-zero flow is present — nothing dropped before the tooltip.
    const nonZero = jul.segments.filter((g) => g.value > 0)
    expect(nonZero).toHaveLength(6)
    // Percentages are derivable from value/total and sum to 100.
    const pctSum = nonZero.reduce((s, g) => s + (g.value / jul.total) * 100, 0)
    expect(pctSum).toBeCloseTo(100, 5)
    // Largest first for the tooltip list (the tooltip sorts desc,
    // mirroring monthly-chart.tsx).
    const values = nonZero.map((g) => g.value)
    expect([...values].sort((a, b) => b - a)).toEqual([
      538, 437, 152, 45, 1, 1,
    ])
    // Each segment carries the same color object the bars and legend use.
    const byKey = new Map(keys.map((k) => [k.key, k.color]))
    for (const g of nonZero) {
      expect(g.color).toBe(byKey.get(g.key))
    }
  })

  it('keeps a flow color stable when it is absent in some months', () => {    const full = buildMonthlyStacks([
      month(7, 100, [['f-a', 'A', 60], ['f-b', 'B', 40]]),
      month(8, 60, [['f-a', 'A', 60]]),
    ])
    const partial = buildMonthlyStacks([month(8, 60, [['f-a', 'A', 60]])])
    const colorFull = full.keys.find((k) => k.key === 'f-a')!.color
    const colorPartial = partial.keys.find((k) => k.key === 'f-a')!.color
    // Same id set shape → same deterministic color (no month flicker).
    expect(colorFull).toBe(colorPartial)
  })
})

describe('buildMonthTooltip', () => {
  const stacks = buildMonthlyStacks([
    month(7, 1174, [
      ['f-goa', 'GOA', 538],
      ['f-sg', 'Singapore Chat Automation', 437],
      ['f-hiring', 'Hiring', 152],
      [null, 'No flow', 45],
      ['f-couple', 'Goa Couple', 1],
      ['f-kerala', 'Kerala Chat Automation', 1],
    ]),
    month(8, 0, []),
  ])

  it('contains every non-zero flow with segment-matching colors', () => {
    const { rows, total } = buildMonthTooltip(stacks, 6)
    expect(total).toBe(1174)
    expect(rows).toHaveLength(6)
    // Same color objects the bars and legend use.
    const byKey = new Map(stacks.keys.map((k) => [k.key, k.color]))
    for (const r of rows) {
      expect(r.color).toBe(byKey.get(r.key))
    }
    // Percentages divide by the chart total and sum to 100.
    const pctSum = rows.reduce((s, r) => s + (r.value / total) * 100, 0)
    expect(pctSum).toBeCloseTo(100, 5)
    // Largest-first order matches the RPC row order.
    expect(rows.map((r) => r.value)).toEqual([538, 437, 152, 45, 1, 1])
  })

  it('preserves No flow and handles empty months', () => {
    const { rows } = buildMonthTooltip(stacks, 6)
    expect(rows.some((r) => r.flowId === null && r.name === 'No flow')).toBe(true)
    expect(buildMonthTooltip(stacks, 7)).toEqual({ rows: [], total: 0 })
    expect(buildMonthTooltip(stacks, 99)).toEqual({ rows: [], total: 0 })
  })
})
