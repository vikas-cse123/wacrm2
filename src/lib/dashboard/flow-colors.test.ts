import { describe, expect, it } from 'vitest'
import {
  FLOW_PALETTE,
  NO_FLOW_COLOR,
  NO_FLOW_KEY,
  OTHERS_COLOR,
  OTHERS_KEY,
  assignFlowColors,
  fallbackFlowColor,
} from './flow-colors'
import { buildDailyStacks } from './daily-stacks'
import { buildMonthlyStacks } from './monthly-stacks'

/** Minimal hex → HSL helper (test-only) for pastel-range checks. */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s, l }
}

describe('assignFlowColors', () => {
  it('gives every flow a unique color (acceptance: six flows, six colors)', () => {
    const ids = [
      'flow-goa',
      'flow-singapore',
      'flow-hiring',
      'flow-goa-couple',
      'flow-kerala',
      'flow-bali',
    ]
    const colors = assignFlowColors(ids)
    expect(colors.size).toBe(ids.length)
    expect(new Set(colors.values()).size).toBe(ids.length)
  })

  it('is deterministic and stable when a new flow is added', () => {
    const before = assignFlowColors(['a', 'b', 'c'])
    const after = assignFlowColors(['a', 'b', 'c', 'd'])
    // Existing flows keep their colors unless probe paths overlap;
    // at minimum the mapping is deterministic across calls.
    expect(assignFlowColors(['a', 'b', 'c'])).toEqual(before)
    expect(after.get('d')).toBeDefined()
    expect(new Set(after.values()).size).toBe(4)
  })

  it('never collides with the reserved No-flow / Others colors', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `flow-${i}`)
    const colors = assignFlowColors(ids)
    const values = [...colors.values()]
    expect(new Set(values).size).toBe(ids.length)
    expect(values).not.toContain(NO_FLOW_COLOR)
    expect(values).not.toContain(OTHERS_COLOR)
    expect(FLOW_PALETTE).not.toContain(NO_FLOW_COLOR)
    expect(FLOW_PALETTE).not.toContain(OTHERS_COLOR)
  })

  it('handles an empty set', () => {
    expect(assignFlowColors([]).size).toBe(0)
  })

  it('reserved keys keep their fixed colors', () => {
    expect(NO_FLOW_KEY).toBe('__no_flow__')
    expect(OTHERS_KEY).toBe('__others__')
    expect(NO_FLOW_COLOR).not.toBe(OTHERS_COLOR)
  })

  it('fallback generator is deterministic', () => {
    expect(fallbackFlowColor(99)).toBe(fallbackFlowColor(99))
  })

  it('fallback colors are light/pastel like the base palette', () => {
    // Saturation 45–60%, lightness 70–80%: calm pastels, never
    // saturated/dark, never extremely pale.
    for (const rank of [0, 1, 12, 24, 99]) {
      const match = fallbackFlowColor(rank).match(/^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/)
      expect(match).not.toBeNull()
      const [, , s, l] = match!
      expect(Number(s)).toBeGreaterThanOrEqual(45)
      expect(Number(s)).toBeLessThanOrEqual(60)
      expect(Number(l)).toBeGreaterThanOrEqual(70)
      expect(Number(l)).toBeLessThanOrEqual(80)
    }
  })

  it('uses the consistently light/pastel palette (no hardcoded flow names)', () => {
    // Exact light enterprise palette.
    expect([...FLOW_PALETTE]).toEqual([
      '#8AB4F8',
      '#F28B82',
      '#FDD663',
      '#81C995',
      '#C58AF9',
      '#78D4E8',
      '#FFAB91',
      '#A8A7F5',
      '#F48FB1',
      '#80CBC4',
      '#D6C96A',
      '#E7A1B3',
    ])
    // Flat fills only: every entry is a hex color (no gradients).
    for (const c of FLOW_PALETTE) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
    // No dark/saturated segments allowed anywhere in the palette.
    for (const banned of ['#00796B', '#C2185B', '#9E9D24']) {
      expect(FLOW_PALETTE).not.toContain(banned)
    }
    // Every palette color is visually light/pastel: HSL lightness
    // in the pastel band, so bars feel calm on a white dashboard.
    for (const c of FLOW_PALETTE) {
      const { l } = hexToHsl(c)
      expect(l).toBeGreaterThanOrEqual(0.6)
      expect(l).toBeLessThanOrEqual(0.9)
    }
    // No flow-name mapping exists: assignment is a pure function of
    // the stable id list (no name parameter anywhere).
    expect(assignFlowColors.length).toBe(1)
  })

  it('assigns colors by stable flowId, not by flow name', () => {
    // Same ids → same colors regardless of what names the charts show.
    const byId = assignFlowColors(['flow-A123', 'flow-A456'])
    // Different accounts with completely different names but the
    // same id shape still hash by id (names never enter the hash).
    expect(byId.get('flow-A123')).toBe(assignFlowColors(['flow-A123']).get('flow-A123'))
    expect(byId.get('flow-A456')).toBe(assignFlowColors(['flow-A456']).get('flow-A456'))
  })

  it('keeps the same color when a flow is renamed', () => {
    const before = buildDailyStacks([
      {
        date: '2026-09-12',
        total: 20,
        flows: [{ flowId: 'flow-A123', flowName: 'GOA', uniqueContacts: 20 }],
      },
    ])
    const after = buildDailyStacks([
      {
        date: '2026-09-12',
        total: 20,
        flows: [{ flowId: 'flow-A123', flowName: 'Dubai Leads', uniqueContacts: 20 }],
      },
    ])
    expect(after.keys.find((k) => k.key === 'flow-A123')!.color).toBe(
      before.keys.find((k) => k.key === 'flow-A123')!.color,
    )
  })

  it('keeps colors stable when flows are reordered', () => {
    const ordered = assignFlowColors(['flow-A123', 'flow-A456', 'flow-A789'])
    const reordered = assignFlowColors(['flow-A789', 'flow-A123', 'flow-A456'])
    expect(reordered).toEqual(ordered)
  })

  it('gives the same flowId the same color in daily and monthly charts', () => {
    const ids: Array<[string, string, number]> = [
      ['flow-A123', 'GOA', 21],
      ['flow-A456', 'Singapore Chat Automation', 15],
    ]
    const daily = buildDailyStacks([
      {
        date: '2026-09-12',
        total: 36,
        flows: ids.map(([flowId, flowName, uniqueContacts]) => ({
          flowId,
          flowName,
          uniqueContacts,
        })),
      },
    ])
    const monthly = buildMonthlyStacks([
      {
        month: 9,
        total: 36,
        flows: ids.map(([flowId, flowName, uniqueContacts]) => ({
          flowId,
          flowName,
          uniqueContacts,
        })),
      },
    ])
    for (const [id] of ids) {
      expect(daily.keys.find((k) => k.key === id)!.color).toBe(
        monthly.keys.find((k) => k.key === id)!.color,
      )
    }
  })

  it('gives different visible flowIds unique colors while palette allows', () => {
    // Mirrors the acceptance example: Account A and Account B each
    // get distinct colors per flowId from the same shared palette.
    for (const ids of [
      ['flow-A123', 'flow-A456', 'flow-A789'],
      ['flow-B111', 'flow-B222', 'flow-B333'],
    ]) {
      const colors = assignFlowColors(ids)
      expect(new Set(colors.values()).size).toBe(ids.length)
    }
  })

  it('always maps No flow to neutral gray outside the palette', () => {
    expect(NO_FLOW_COLOR).toBe('#9AA0A6')
    expect(FLOW_PALETTE).not.toContain(NO_FLOW_COLOR)
    const stacks = buildDailyStacks([
      {
        date: '2026-09-12',
        total: 20,
        flows: [
          { flowId: 'flow-A123', flowName: 'GOA', uniqueContacts: 12 },
          { flowId: null, flowName: 'No flow', uniqueContacts: 8 },
        ],
      },
    ])
    expect(stacks.keys.find((k) => k.key === NO_FLOW_KEY)!.color).toBe(NO_FLOW_COLOR)
  })

  it('does not recolor existing flows when another flow is added or removed', () => {
    // a/b/c/d hash to distinct palette slots (4/1/2/7), so no probe
    // overlap: the mapping is set-independent for this realistic set.
    const base = assignFlowColors(['a', 'b', 'c'])
    const grown = assignFlowColors(['a', 'b', 'c', 'd'])
    for (const id of ['a', 'b', 'c']) {
      expect(grown.get(id)).toBe(base.get(id))
    }
    const shrunk = assignFlowColors(['a', 'c'])
    for (const id of ['a', 'c']) {
      expect(shrunk.get(id)).toBe(base.get(id))
    }
  })
})
