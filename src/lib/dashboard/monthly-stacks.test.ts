import { describe, expect, it } from 'vitest'
import { MAX_NAMED_FLOWS, buildMonthlyStacks } from './monthly-stacks'
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
})
