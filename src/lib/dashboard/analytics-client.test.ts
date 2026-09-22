import { describe, expect, it, vi, afterEach } from 'vitest'
import { loadDashboardAnalytics } from './analytics-client'

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
  it('parses the combined RPC payload into kpis, flow rows and monthly', async () => {
    mockFetch({
      kpis: {
        totalMessages: { current: 10, previous: 4 },
        uniqueContacts: { current: 7, previous: 3 },
        newContacts: { current: 2, previous: 1 },
        newConversations: { current: 5, previous: 2 },
      },
      flowBreakdown: {
        totalMessages: 10,
        rows: [
          { flowId: 'f1', flowName: 'Bookings', messages: 6, uniqueContacts: 4, pct: 60 },
          { flowId: 'f2', flowName: 'Support', messages: 2, uniqueContacts: 2, pct: 20 },
        ],
      },
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
    expect(d.kpis.totalMessages).toEqual({ current: 10, previous: 4 })
    expect(d.flowRows).toHaveLength(2)
    expect(d.flowRows[0]).toMatchObject({ flowId: 'f1', messages: 6 })
    expect(d.flowTotalMessages).toBe(10)
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
        totalMessages: { current: 0, previous: 0 },
        uniqueContacts: { current: 0, previous: 0 },
        newContacts: { current: 0, previous: 0 },
        newConversations: { current: 0, previous: 0 },
      },
      flowBreakdown: {
        totalMessages: 0,
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
  })

  it('drops malformed monthly flow entries but keeps valid ones', async () => {
    mockFetch({
      kpis: {
        totalMessages: { current: 0, previous: 0 },
        uniqueContacts: { current: 0, previous: 0 },
        newContacts: { current: 0, previous: 0 },
        newConversations: { current: 0, previous: 0 },
      },
      flowBreakdown: { totalMessages: 0, rows: [] },
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
})
