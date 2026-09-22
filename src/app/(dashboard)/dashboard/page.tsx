"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageCircle, MessagesSquare, UserPlus, Users } from 'lucide-react'
import {
  getDashboardRange,
  getYearRange,
  toDateInputValue,
  type DashboardDateFilter,
} from '@/lib/dashboard/date-utils'
import { loadDashboardAnalytics } from '@/lib/dashboard/analytics-client'
import type { DashboardKpis, FlowBreakdownRow, MonthlyFlowMonth } from '@/lib/dashboard/types'
import { DateFilter } from '@/components/dashboard/date-filter'
import { KpiCard } from '@/components/dashboard/kpi-card'
import { FlowBreakdown } from '@/components/dashboard/flow-breakdown'
import { MonthlyChart } from '@/components/dashboard/monthly-chart'
import { SkeletonCard } from '@/components/dashboard/skeleton'

export default function DashboardPage() {
  const [filter, setFilter] = useState<DashboardDateFilter>('today')
  const [customFrom, setCustomFrom] = useState(() => toDateInputValue(new Date()))
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()))

  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const years = useMemo(() => {
    const out: number[] = []
    for (let y = currentYear - 3; y <= currentYear; y++) out.push(y)
    return out
  }, [currentYear])

  const range = useMemo(
    () => getDashboardRange(filter, new Date(), customFrom, customTo),
    [filter, customFrom, customTo],
  )
  // One analytics request per (range, year): KPIs + flow breakdown +
  // monthly uniques are aggregated server-side in a single RPC.
  const requestKey = useMemo(
    () =>
      `${range.start.toISOString()}|${range.end.toISOString()}|${range.prevStart.toISOString()}|${range.prevEnd.toISOString()}|${year}`,
    [range, year],
  )

  const [kpis, setKpis] = useState<DashboardKpis | null>(null)
  const [flowRows, setFlowRows] = useState<FlowBreakdownRow[] | null>(null)
  const [monthly, setMonthly] = useState<number[] | null>(null)
  const [monthlyFlows, setMonthlyFlows] = useState<MonthlyFlowMonth[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    const yearRange = getYearRange(year)
    const tz =
      typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : 'UTC'
    loadDashboardAnalytics(
      {
        startISO: range.start.toISOString(),
        endISO: range.end.toISOString(),
        prevStartISO: range.prevStart.toISOString(),
        prevEndISO: range.prevEnd.toISOString(),
        yearStartISO: yearRange.start.toISOString(),
        yearEndISO: yearRange.end.toISOString(),
        year,
        tz,
      },
      ctrl.signal,
    )
      .then((d) => {
        setKpis(d.kpis)
        setFlowRows(d.flowRows)
        setMonthly(d.monthly)
        setMonthlyFlows(d.monthlyFlows)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[dashboard] analytics failed:', err)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => {
      ctrl.abort()
    }
    // Re-run when the computed range or year changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  const handleCustomApply = useCallback((from: string, to: string) => {
    setCustomFrom(from)
    setCustomTo(to)
    setFilter('custom')
  }, [])

  const kpiLoading = loading || !kpis
  const flowLoading = loading || flowRows == null
  const monthlyLoading = loading || monthly == null

  return (
    <div className="space-y-5">
      {/* Header + date filter */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            WhatsApp performance for your travel agency — messages, contacts and flows.
          </p>
        </div>
        <DateFilter
          value={filter}
          onChange={setFilter}
          customFrom={customFrom}
          customTo={customTo}
          onCustomApply={handleCustomApply}
        />
      </div>

      {/* KPI cards — only the four specified metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpiLoading || !kpis ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <KpiCard
              title="Total Messages"
              value={kpis.totalMessages.current}
              icon={MessagesSquare}
              previous={kpis.totalMessages.previous}
              prevLabel={range.prevLabel}
            />
            <KpiCard
              title="Unique Contacts Messaged"
              value={kpis.uniqueContacts.current}
              icon={Users}
              previous={kpis.uniqueContacts.previous}
              prevLabel={range.prevLabel}
            />
            <KpiCard
              title="New Contacts"
              value={kpis.newContacts.current}
              icon={UserPlus}
              previous={kpis.newContacts.previous}
              prevLabel={range.prevLabel}
            />
            <KpiCard
              title="New Conversations"
              value={kpis.newConversations.current}
              icon={MessageCircle}
              previous={kpis.newConversations.previous}
              prevLabel={range.prevLabel}
            />
          </>
        )}
      </div>

      {/* Primary: message breakdown by flow */}
      <FlowBreakdown rows={flowRows} loading={flowLoading} rangeLabel={range.label} />

      {/* Bottom: monthly uniques — final major section */}
      <MonthlyChart
        data={monthly}
        flows={monthlyFlows}
        year={year}
        years={years}
        onYearChange={setYear}
        loading={monthlyLoading}
      />
    </div>
  )
}
