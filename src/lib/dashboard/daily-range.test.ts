import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  MAX_DAILY_RANGE_DAYS,
  dayKeysBetween,
  fillDailyContacts,
  fillDailyFlows,
  formatDayRangeLabel,
  isValidDayKey,
  validateCustomDailyRange,
} from './daily-range'
import { lastNDayKeys, localDayKey } from './date-utils'
import {
  buildDailyStacks,
  MAX_NAMED_DAILY_FLOWS,
} from './daily-stacks'
import { loadDailyRange, normalizeDailyContacts } from './analytics-client'
import type { DailyFlowDay } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

function flowDay(
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

describe('daily chart default range', () => {
  it('1. defaults to the current trailing 30 days', () => {
    const keys = lastNDayKeys(30)
    expect(keys).toHaveLength(30)
    // Chronological, ending today, one bar per calendar day.
    expect(keys[29]).toBe(localDayKey(new Date()))
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(30)
  })
})

describe('daily chart custom range', () => {
  it('2. resolves an explicit custom start/end date', () => {
    const keys = dayKeysBetween('2026-09-01', '2026-09-19')
    expect(keys).not.toBeNull()
    expect(keys).toHaveLength(19)
    expect(keys![0]).toBe('2026-09-01')
    expect(keys!.at(-1)).toBe('2026-09-19')
    expect(formatDayRangeLabel('2026-09-01', '2026-09-19')).toBe(
      '1 Sep 2026 – 19 Sep 2026',
    )
  })

  it('3. renders the correct number/order of daily bars for a custom range', () => {
    const keys = dayKeysBetween('2026-09-01', '2026-09-05')!
    const contacts = fillDailyContacts(
      [
        { date: '2026-09-05', contacts: 4 },
        { date: '2026-09-01', contacts: 2 },
        { date: '2026-09-03', contacts: 7 },
      ],
      keys,
    )
    // One bar per calendar day, in order, regardless of input order.
    expect(contacts.map((d) => d.date)).toEqual(keys)
    expect(contacts.map((d) => d.contacts)).toEqual([2, 0, 7, 0, 4])

    const flows = fillDailyFlows(
      [flowDay('2026-09-03', 7, [['f-a', 'A', 7]])],
      keys,
    )
    expect(flows.map((d) => d.date)).toEqual(keys)
    const stacks = buildDailyStacks(flows, keys.length)
    expect(stacks.days.map((d) => d.date)).toEqual(keys)
    expect(stacks.days).toHaveLength(5)
  })

  it('4. preserves zero-contact days', () => {
    const keys = dayKeysBetween('2026-09-01', '2026-09-03')!
    const contacts = fillDailyContacts([], keys)
    expect(contacts).toHaveLength(3)
    expect(contacts.every((d) => d.contacts === 0)).toBe(true)
    const flows = fillDailyFlows([], keys)
    const stacks = buildDailyStacks(flows, keys.length)
    expect(stacks.days).toHaveLength(3)
    expect(stacks.days.every((d) => d.total === 0)).toBe(true)
  })

  it('5. custom range data carries only daily keys (other sections unaffected)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => ({
        ok: true,
        status: 200,
        json: async () => ({
          // Even if the payload contains other sections, the loader
          // only surfaces daily data to the chart.
          kpis: { uniqueContacts: { current: 999, previous: 1 } },
          monthlyUniqueContacts: [999],
          dailyContacts: [{ date: '2026-09-01', contacts: 3 }],
          dailyFlows: [flowDay('2026-09-01', 3, [['f-a', 'A', 3]])],
          _url: String(url),
        }),
      })),
    )
    const d = await loadDailyRange('2026-09-01', '2026-09-03', 'UTC')
    expect(d.contacts.map((c) => c.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ])
    expect(d.flows.map((f) => f.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ])
    // No KPI/monthly surface: the result shape has daily keys only.
    expect(d).not.toHaveProperty('kpis')
    expect(d).not.toHaveProperty('monthly')
    // The request scopes the RPC daily window without touching the
    // other (required) analytics params.
    const url = String(vi.mocked(fetch).mock.calls[0]?.[0] ?? '')
    expect(url).toContain('dailyStart=2026-09-01')
    expect(url).toContain('dailyEnd=2026-09-03')
  })

  it('6. switching back to Last 30 Days restores the trailing-30 window', () => {
    // The default resolution ignores any previously applied custom
    // pair: it is always the current trailing 30 days.
    const restored = lastNDayKeys(30)
    expect(restored).toHaveLength(30)
    expect(restored[29]).toBe(localDayKey(new Date()))
    // And the default stacks window stays capped at 30.
    const many = Array.from({ length: 60 }, (_, i) =>
      flowDay(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 1, [
        ['f-a', 'A', 1],
      ]),
    )
    expect(buildDailyStacks(many).days).toHaveLength(30)
    expect(buildDailyStacks(many, 60).days).toHaveLength(60)
  })

  it('7. invalid ranges are rejected safely', async () => {
    // End before start.
    expect(dayKeysBetween('2026-09-19', '2026-09-01')).toBeNull()
    expect(validateCustomDailyRange('2026-09-19', '2026-09-01')).toMatch(
      /on or after/i,
    )
    // Missing / malformed inputs.
    expect(validateCustomDailyRange('', '2026-09-01')).not.toBeNull()
    expect(validateCustomDailyRange('2026-13-01', '2026-09-01')).not.toBeNull()
    expect(validateCustomDailyRange('2026-02-30', '2026-09-01')).not.toBeNull()
    expect(isValidDayKey('not-a-date')).toBe(false)
    // Over-long windows are refused (API/RPC cap).
    expect(dayKeysBetween('2024-01-01', '2026-09-01')).toBeNull()
    expect(validateCustomDailyRange('2024-01-01', '2026-09-01')).toMatch(
      new RegExp(String(MAX_DAILY_RANGE_DAYS)),
    )
    // The loader never fires for an invalid pair.
    await expect(loadDailyRange('2026-09-19', '2026-09-01', 'UTC')).rejects.toThrow()
  })

  it('8. unique-contact counting semantics are unchanged', () => {
    // Totals pass through untouched (floored, never recomputed);
    // one contact with many messages still counts once per day —
    // the loader carries the RPC total verbatim into the chart.
    const days = normalizeDailyContacts(
      [
        { date: '2026-09-01', contacts: 7.9 },
        { date: '2026-09-02', contacts: 0 },
      ],
      2,
    )
    expect(days).toEqual([
      { date: '2026-09-01', contacts: 7 },
      { date: '2026-09-02', contacts: 0 },
    ])
    const flows = buildDailyStacks(
      [flowDay('2026-09-01', 7, [['f-a', 'A', 5], ['f-b', 'B', 2]])],
      1,
    )
    // Segments regroup the same total: 5 + 2 = 7, no double counting.
    expect(flows.days[0]!.segments.reduce((s, g) => s + g.value, 0)).toBe(7)
    expect(MAX_NAMED_DAILY_FLOWS).toBe(7)
  })
})
