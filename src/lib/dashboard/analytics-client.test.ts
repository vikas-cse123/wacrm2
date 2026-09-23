import { describe, expect, it, vi, afterEach } from 'vitest'
import { loadDashboardAnalytics, normalizeDailyContacts } from './analytics-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockFetch(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status,
      json: async () => payload,
    })),
  )
}

const params = {
  startISO: '2026-09-22T00:00:00.000Z',
  endISO: '2026-09-23T00:00:00.000Z',
  prevStartISO: '2026-09-21T00:00:00.000Z',
  prevEndISO: '2026-09-22T00:00:00.000Z',
  yearStartISO: '2026-01-01T00:00:00.000Z',
  yearEndISO: '2027-01-01T00:00:00.000Z',
  year: 2026,
  tz: 'UTC',
}

describe('loadDashboardAnalytics', () => {
  it('parses the combined RPC payload into kpis, flow rows, daily and monthly', async () => {
    mockFetch({
      kpis: {
        uniqueContacts: { current: 7, previous: 3 },
      },
      flowBreakdown: {
        totalContacts: 7,
        rows: [
          { flowId: 'f1', flowName: 'Bookings', contacts: 4, pct: 57.1 },
          { flowId: null, flowName: 'No flow', contacts: 3, pct: 42.9 },
        ],
      },
      dailyContacts: [
        { date: '2026-09-21', contacts: 0 },
        { date: '2026-09-22', contacts: 7 },
      ],
      monthlyUniqueContacts: [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
      monthlyFlows: [
        {
          month: 7,
          total: 1174,
          flows: [
            { flowId: 'f-sg', flowName: 'Singapore', uniqueContacts: 432 },
            { flowId: null, flowName: 'No flow', uniqueContacts: 110 },
          ],
        },
      ],
    })

    const d = await loadDashboardAnalytics(params)
    // KPI is the true unique-contact count — legacy message/new-contact
    // deltas are absent from both payload and result.
    expect(d.kpis).toEqual({ uniqueContacts: { current: 7, previous: 3 } })
    expect(d.flowRows).toHaveLength(2)
    // Contact counts, not message counts — and no double counting:
    // rows sum exactly to the total.
    expect(d.flowRows[0]).toMatchObject({ flowId: 'f1', contacts: 4 })
    expect(d.flowRows[1]).toMatchObject({ flowId: null, flowName: 'No flow' })
    expect(d.flowRows.reduce((s, r) => s + r.contacts, 0)).toBe(7)
    expect(d.flowTotalContacts).toBe(7)
    expect(d.monthly).toEqual([1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3])
    expect(d.monthlyFlows).toHaveLength(1)
    expect(d.monthlyFlows[0]).toMatchObject({ month: 7, total: 1174 })
    expect(d.monthlyFlows[0]!.flows).toHaveLength(2)

    // Single analytics request, no chunked message fetches.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    const url = String(vi.mocked(fetch).mock.calls[0]?.[0] ?? '')
    expect(url.startsWith('/api/dashboard/analytics?')).toBe(true)
    expect(url).not.toContain('messages?select')
  })

  it('pads short monthly arrays to 12 and drops malformed flow rows', async () => {
    mockFetch({
      kpis: {
        uniqueContacts: { current: 0, previous: 0 },
      },
      flowBreakdown: {
        totalContacts: 0,
        rows: [{ flowId: 'f1' }, null],
      },
      monthlyUniqueContacts: [5],
    })

    const d = await loadDashboardAnalytics(params)
    expect(d.flowRows).toEqual([])
    expect(d.monthly).toHaveLength(12)
    expect(d.monthly[0]).toBe(5)
    // Missing monthlyFlows (pre-075 backend) → solid-bar fallback.
    expect(d.monthlyFlows).toEqual([])
    // Missing dailyContacts → 30 zero days, chart window intact.
    expect(d.daily).toHaveLength(30)
    expect(d.daily.every((day) => day.contacts === 0)).toBe(true)
  })

  it('drops legacy message-count rows so message counts can never render as contacts', async () => {
    mockFetch({
      kpis: {
        uniqueContacts: { current: 7, previous: 3 },
      },
      flowBreakdown: {
        totalContacts: 7,
        rows: [
          { flowId: 'f1', flowName: 'Bookings', messages: 90, pct: 90 },
          { flowId: 'f2', flowName: 'Support', contacts: 7, pct: 100 },
        ],
      },
      monthlyUniqueContacts: Array(12).fill(0),
    })

    const d = await loadDashboardAnalytics(params)
    expect(d.flowRows).toEqual([
      { flowId: 'f2', flowName: 'Support', contacts: 7, pct: 100 },
    ])
    expect(d.flowTotalContacts).toBe(7)
  })

  it('drops malformed monthly flow entries but keeps valid ones', async () => {
    mockFetch({
      kpis: {
        uniqueContacts: { current: 0, previous: 0 },
      },
      flowBreakdown: { totalContacts: 0, rows: [] },
      monthlyUniqueContacts: Array(12).fill(0),
      monthlyFlows: [
        { month: 13, total: 5, flows: [] },
        { month: 'x', total: 5, flows: [] },
        {
          month: 7,
          total: 12,
          flows: [
            { flowId: 'f1', flowName: 'A', uniqueContacts: 7 },
            { flowId: 'f2' },
            null,
          ],
        },
      ],
    })

    const d = await loadDashboardAnalytics(params)
    expect(d.monthlyFlows).toHaveLength(1)
    expect(d.monthlyFlows[0]!.flows).toEqual([
      { flowId: 'f1', flowName: 'A', uniqueContacts: 7 },
    ])
  })

  it('throws on HTTP errors and unexpected shapes', async () => {
    mockFetch({ error: 'x' }, false, 500)
    await expect(loadDashboardAnalytics(params)).rejects.toThrow()

    mockFetch({ kpis: {} })
    await expect(loadDashboardAnalytics(params)).rejects.toThrow()
  })

  it('parses contactsByAd and drops malformed buckets', async () => {
    mockFetch({
      kpis: {
        uniqueContacts: { current: 10, previous: 8 },
      },
      flowBreakdown: { totalContacts: 0, rows: [] },
      contactsByAd: {
        totalContacts: 10,
        rows: [
          { adKey: 'https://fb.me/a', adLabel: 'https://fb.me/a', contacts: 6, pct: 60 },
          { adKey: '__no_ad__', adLabel: 'No Ad', contacts: 4, pct: 40 },
          { adKey: '', adLabel: 'bad', contacts: 9, pct: 90 },
          null,
        ],
      },
      dailyContacts: [],
      monthlyUniqueContacts: Array(12).fill(0),
    })

    const d = await loadDashboardAnalytics(params)
    expect(d.contactsByAd.totalContacts).toBe(10)
    expect(d.contactsByAd.rows.map((r) => r.adKey)).toEqual([
      'https://fb.me/a',
      '__no_ad__',
    ])
  })

  it('defaults contactsByAd when the key is missing', async () => {
    mockFetch({
      kpis: { uniqueContacts: { current: 0, previous: 0 } },
      flowBreakdown: { totalContacts: 0, rows: [] },
      monthlyUniqueContacts: Array(12).fill(0),
    })
    const d = await loadDashboardAnalytics(params)
    expect(d.contactsByAd).toEqual({ totalContacts: 0, rows: [] })
  })

  it('parses dailyFlows and drops malformed days', async () => {
    mockFetch({
      kpis: { uniqueContacts: { current: 10, previous: 8 } },
      flowBreakdown: { totalContacts: 0, rows: [] },
      dailyContacts: [],
      dailyFlows: [
        {
          date: '2026-09-12',
          total: 47,
          flows: [
            { flowId: 'f-goa', flowName: 'GOA', uniqueContacts: 21 },
            { flowId: null, flowName: 'No flow', uniqueContacts: 4 },
            { flowId: 'f-bad' },
          ],
        },
        { date: 'bad-date', total: 3, flows: [] },
        null,
      ],
      monthlyUniqueContacts: Array(12).fill(0),
    })

    const d = await loadDashboardAnalytics(params)
    // Malformed days dropped; short payload padded to a 30-day window
    // with the valid day at the trailing edge.
    expect(d.dailyFlows).toHaveLength(30)
    expect(d.dailyFlows[29]).toMatchObject({ date: '2026-09-12', total: 47 })
    expect(d.dailyFlows[29]!.flows).toEqual([
      { flowId: 'f-goa', flowName: 'GOA', uniqueContacts: 21 },
      { flowId: null, flowName: 'No flow', uniqueContacts: 4 },
    ])
    expect(d.dailyFlows.slice(0, 29).every((day) => day.total === 0)).toBe(true)
  })

  it('defaults dailyFlows when the key is missing', async () => {
    mockFetch({
      kpis: { uniqueContacts: { current: 0, previous: 0 } },
      flowBreakdown: { totalContacts: 0, rows: [] },
      monthlyUniqueContacts: Array(12).fill(0),
    })
    const d = await loadDashboardAnalytics(params)
    expect(d.dailyFlows).toHaveLength(30)
  })

  it('rejects a payload with no usable unique-contacts KPI', async () => {
    // Legacy message-only KPI payloads must fail closed, not render.
    mockFetch({
      kpis: {
        totalMessages: { current: 10, previous: 4 },
      },
      flowBreakdown: { totalContacts: 0, rows: [] },
      monthlyUniqueContacts: Array(12).fill(0),
    })
    await expect(loadDashboardAnalytics(params)).rejects.toThrow()
  })
})

describe('normalizeDailyContacts', () => {
  it('keeps a full 30-day window untouched, zeros included', () => {
    const input = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      contacts: i % 3 === 0 ? 0 : i,
    }))
    const out = normalizeDailyContacts(input)
    expect(out).toHaveLength(30)
    expect(out[0]).toEqual({ date: '2026-08-01', contacts: 0 })
    expect(out[29]).toEqual({ date: '2026-08-30', contacts: 29 })
  })

  it('drops malformed entries and pads short payloads with zero days', () => {
    const out = normalizeDailyContacts([
      { date: '2026-09-22', contacts: 7 },
      { date: 'not-a-date', contacts: 5 },
      { date: '2026-09-23', contacts: -2 },
      { date: '2026-09-24' },
      null,
      'garbage',
    ])
    expect(out).toHaveLength(30)
    // Only the single valid day survives, at the trailing edge.
    expect(out[29]).toEqual({ date: '2026-09-22', contacts: 7 })
    expect(out.slice(0, 29).every((d) => d.contacts === 0)).toBe(true)
  })

  it('keeps the most recent 30 days of an over-long payload', () => {
    const input = Array.from({ length: 35 }, (_, i) => ({
      // September has 30 days — clamp into a valid calendar range.
      date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      contacts: 1,
    }))
    const out = normalizeDailyContacts(input)
    expect(out).toHaveLength(30)
  })

  it('floors fractional counts and returns zeros for non-arrays', () => {
    expect(normalizeDailyContacts(undefined)).toHaveLength(30)
    const out = normalizeDailyContacts([{ date: '2026-09-22', contacts: 4.9 }])
    expect(out[29]).toEqual({ date: '2026-09-22', contacts: 4 })
  })
})
