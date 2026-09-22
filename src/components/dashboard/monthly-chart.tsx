"use client"

import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Users } from 'lucide-react'
import { MONTH_SHORT } from '@/lib/dashboard/date-utils'
import { buildMonthlyStacks, type StackMonth } from '@/lib/dashboard/monthly-stacks'
import { OTHERS_KEY, SOLID_BAR_COLOR } from '@/lib/dashboard/flow-colors'
import type { MonthlyFlowMonth } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface MonthlyChartProps {
  data: number[] | null
  /** Per-flow monthly split (migration 075). Null/empty → solid bars. */
  flows?: MonthlyFlowMonth[] | null
  year: number
  years: number[]
  onYearChange: (y: number) => void
  loading: boolean
}

const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export function MonthlyChart({ data, flows, year, years, onYearChange, loading }: MonthlyChartProps) {
  // Totals ALWAYS come from `data` (monthlyUniqueContacts) — the
  // stacked segments only split that total, never recompute it.
  const totals = useMemo(() => MONTH_SHORT.map((_, i) => data?.[i] ?? 0), [data])

  const stacks = useMemo(
    () => (flows && flows.length > 0 ? buildMonthlyStacks(flows) : null),
    [flows],
  )
  // Stack structure exists when at least one real flow is present. A
  // year with solely unattributed contacts renders the classic bar.
  const stacked =
    stacks !== null &&
    stacks.keys.some((k) => k.flowId !== null || k.key === OTHERS_KEY)

  // Hovered month index (0 = Jan). Only the hovered bar shows flow
  // colors; every other bar renders solid blue. Pure client state —
  // hovering never triggers a network request.
  const [hovered, setHovered] = useState<number | null>(null)

  const chartData = useMemo(() => {
    if (!stacked || !stacks) {
      return MONTH_SHORT.map((m, i) => ({ month: m, contacts: totals[i] ?? 0 }))
    }
    return stacks.months.map((sm: StackMonth, i: number) => {
      const row: Record<string, string | number> = {
        month: MONTH_SHORT[i] ?? '',
        total: totals[i] ?? 0,
      }
      for (const seg of sm.segments) row[seg.key] = seg.value
      return row
    })
  }, [stacked, stacks, totals])

  const lastKey = stacked && stacks ? stacks.keys[stacks.keys.length - 1]?.key : null

  // Topmost non-zero segment of the hovered month gets the rounded
  // top; otherwise the last key does (solid-blue look everywhere).
  const roundedKey = useMemo(() => {
    if (hovered == null || !stacked || !stacks) return lastKey
    const sm = stacks.months[hovered]
    if (!sm) return lastKey
    for (let i = sm.segments.length - 1; i >= 0; i--) {
      if ((sm.segments[i]?.value ?? 0) > 0) return sm.segments[i]!.key
    }
    return lastKey
  }, [hovered, stacked, stacks, lastKey])

  const hasData = totals.some((v) => v > 0)
  const yearTotal = totals.reduce((s, v) => s + v, 0)

  const renderTotalLabel = (props: {
    x?: number | string
    y?: number | string
    width?: number | string
    index?: number
  }) => {
    const total = totals[props.index ?? -1] ?? 0
    if (!total) return null
    const x = Number(props.x ?? 0) + Number(props.width ?? 0) / 2
    const y = Number(props.y ?? 0) - 6
    return (
      <text x={x} y={y} textAnchor="middle" fontSize={11} fill="#64748b">
        {total.toLocaleString()}
      </text>
    )
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Month Wise Unique Contacts Messaged">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
            Month Wise Unique Contacts Messaged
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {loading || data == null
              ? `Unique contacts per month · ${year}`
              : `${yearTotal.toLocaleString()} contact-months · ${year}`}
          </p>
        </div>
        <Select value={String(year)} onValueChange={(v) => v && onYearChange(Number(v))}>
          <SelectTrigger className="w-[110px] border-border bg-card" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      <div className="p-5">
        {loading || data == null ? (
          <Skeleton className="h-[280px] w-full" />
        ) : !hasData ? (
          <EmptyState
            icon={Users}
            title={`No messages in ${year} yet`}
            hint="Each bar counts distinct contacts messaged that month."
          />
        ) : (
          <>
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 18, right: 8, bottom: 0, left: -12 }}
                  barCategoryGap="28%"
                  onMouseMove={(s: { activeTooltipIndex?: unknown } | undefined) => {
                    const idx = s?.activeTooltipIndex
                    setHovered(typeof idx === 'number' ? idx : null)
                  }}
                  onMouseLeave={() => setHovered(null)}
                >
                  <CartesianGrid vertical={false} stroke="#eef2f7" />
                  <XAxis
                    dataKey="month"
                    tickLine={false}
                    axisLine={{ stroke: '#e2e8f0' }}
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    interval={0}
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    width={44}
                  />
                  <Tooltip
                    cursor={{ fill: '#f1f5f9', opacity: 0.6 }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      if (!stacked || !stacks) {
                        const v = Number(payload[0]?.value ?? 0)
                        return (
                          <div className="rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                            <p className="font-medium text-foreground">{label}</p>
                            <p className="text-muted-foreground tabular-nums">
                              {v.toLocaleString()} contact{v === 1 ? '' : 's'}
                            </p>
                          </div>
                        )
                      }
                      const datum = payload[0]?.payload as Record<string, unknown> | undefined
                      const total = Number(datum?.total ?? 0)
                      const monthIdx = (MONTH_SHORT as readonly string[]).indexOf(String(label))
                      const title = `${MONTH_LONG[monthIdx] ?? label} ${year}`
                      if (total <= 0) {
                        return (
                          <div className="rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                            <p className="font-medium text-foreground">{title}</p>
                            <p className="text-muted-foreground tabular-nums">No contacts this month</p>
                          </div>
                        )
                      }
                      const rows = stacks.keys
                        .map((k) => ({
                          ...k,
                          value: Number(datum?.[k.key] ?? 0),
                        }))
                        .filter((r) => r.value > 0)
                        .sort((a, b) => b.value - a.value)
                      return (
                        <div className="min-w-[220px] rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                          <p className="font-medium text-foreground">{title}</p>
                          <p className="mb-1 text-muted-foreground tabular-nums">
                            {total.toLocaleString()} unique contact{total === 1 ? '' : 's'}
                          </p>
                          <div className="space-y-1 border-t border-border pt-1.5">
                            {rows.map((r) => (
                              <div key={r.key} className="flex items-center gap-2 tabular-nums">
                                <span
                                  className="size-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: r.color }}
                                />
                                <span className="min-w-0 flex-1 truncate text-foreground">{r.name}</span>
                                <span className="font-medium text-foreground">
                                  {r.value.toLocaleString()}
                                </span>
                                <span className="w-11 text-right text-muted-foreground">
                                  {total > 0 ? ((r.value / total) * 100).toFixed(1) : '0.0'}%
                                </span>
                              </div>
                            ))}
                          </div>
                          <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5 font-medium tabular-nums">
                            <span className="flex-1 text-foreground">Total</span>
                            <span className="text-foreground">{total.toLocaleString()}</span>
                            <span className="w-11 text-right text-muted-foreground">100%</span>
                          </div>
                        </div>
                      )
                    }}
                  />
                  {stacked && stacks ? (
                    stacks.keys.map((k) => (
                      <Bar
                        key={k.key}
                        dataKey={k.key}
                        name={k.name}
                        stackId="contacts"
                        radius={k.key === roundedKey ? [6, 6, 0, 0] : [0, 0, 0, 0]}
                        maxBarSize={38}
                      >
                        {stacks.months.map((sm, i) => (
                          <Cell
                            key={i}
                            fill={hovered === i ? k.color : SOLID_BAR_COLOR}
                          />
                        ))}
                        {k.key === lastKey && lastKey ? (
                          <LabelList dataKey={lastKey} position="top" content={renderTotalLabel} />
                        ) : null}
                      </Bar>
                    ))
                  ) : (
                    <Bar dataKey="contacts" fill="#2563eb" radius={[6, 6, 0, 0]} maxBarSize={38} name="Contacts">
                      <LabelList
                        dataKey="contacts"
                        position="top"
                        formatter={(v: unknown) => {
                          const n = Number(v)
                          return n > 0 ? n.toLocaleString() : ''
                        }}
                        style={{ fontSize: 11, fill: '#64748b' }}
                      />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
            {stacked && stacks && (
              <div
                className="mt-4 flex max-h-20 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto border-t border-border pt-3"
                aria-label="Flows legend"
              >
                {stacks.keys.map((k) => (
                  <span key={k.key} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: k.color }}
                    />
                    {k.name}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
