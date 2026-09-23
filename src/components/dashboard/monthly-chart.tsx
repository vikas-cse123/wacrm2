"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Users } from 'lucide-react'
import { MONTH_SHORT } from '@/lib/dashboard/date-utils'
import { buildMonthlyStacks, buildMonthTooltip, type StackMonth } from '@/lib/dashboard/monthly-stacks'
import { anchorCategory, categoryCenterX, formatCountTick, placeTooltipBesideBar, placeTooltipVertically, resolveActiveMonth, toMonthIndex } from '@/lib/dashboard/chart-helpers'
import { OTHERS_KEY } from '@/lib/dashboard/flow-colors'
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

  // Hover state: the month index plus which flow segment the cursor
  // is over (segment key, when the library reports a per-Bar hover).
  // Every bar always renders its real flow segments; the hovered
  // month stays full-strength while other months dim. Pure client
  // state — hovering never triggers a network request.
  const [hover, setHover] = useState<{ key: string; month: number } | null>(null)
  const hoveredMonth = hover?.month ?? null

  // Measured geometry for edge-aware tooltip placement. Callback
  // refs (not a mount effect) attach the observers whenever the
  // elements exist — a mount-only effect misses them because the
  // chart branch renders after loading, which previously left the
  // measured width at 0 and parked every tooltip at the left edge.
  // wrapRef: the 280px chart box (tooltip coordinate system).
  // bodyRef: the padded content box incl. legend (clip boundary).
  const wrapRoRef = useRef<ResizeObserver | null>(null)
  const [chartWidth, setChartWidth] = useState(0)
  const setWrapRef = useCallback((el: HTMLDivElement | null) => {
    wrapRoRef.current?.disconnect()
    wrapRoRef.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setChartWidth((prev) => (prev === w ? prev : w))
    })
    wrapRoRef.current = ro
    ro.observe(el)
  }, [])
  const bodyRoRef = useRef<ResizeObserver | null>(null)
  const [bodyHeight, setBodyHeight] = useState(0)
  const setBodyRef = useCallback((el: HTMLDivElement | null) => {
    bodyRoRef.current?.disconnect()
    bodyRoRef.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (typeof h === 'number') setBodyHeight((prev) => (prev === h ? prev : h))
    })
    bodyRoRef.current = ro
    ro.observe(el)
  }, [])
  useEffect(() => {
    const wrapRo = wrapRoRef.current
    const bodyRo = bodyRoRef.current
    return () => {
      wrapRo?.disconnect()
      bodyRo?.disconnect()
    }
  }, [])

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
  // top; otherwise the last key does (solid look for the fallback).
  const roundedKey = useMemo(() => {
    if (hoveredMonth == null || !stacked || !stacks) return lastKey
    const sm = stacks.months[hoveredMonth]
    if (!sm) return lastKey
    for (let i = sm.segments.length - 1; i >= 0; i--) {
      if ((sm.segments[i]?.value ?? 0) > 0) return sm.segments[i]!.key
    }
    return lastKey
  }, [hoveredMonth, stacked, stacks, lastKey])

  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  // Degenerate origins are never a real hover (a visible tooltip at
  // (0,0) means the library's coordinate lookup missed).
  const validCursor =
    cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) && (cursor.x > 0 || cursor.y > 0)
      ? cursor
      : null

  // Tooltip anchor: two categories back from the hovered month,
  // so the card sits in that area instead of covering the hovered
  // bar's segments (hover July → May area; January → February area).
  // Content (title/total/rows) still comes from the hovered month.
  // Plot insets mirror the BarChart margin + YAxis width below.
  const PLOT_LEFT = 44
  const PLOT_RIGHT = 8
  const CATEGORY_COUNT = 12
  const anchorMonth = anchorCategory(hoveredMonth, CATEGORY_COUNT)
  const tooltipX = useMemo(() => {
    if (hoveredMonth == null || anchorMonth == null) return 4
    const hoveredCenter = categoryCenterX(
      hoveredMonth,
      chartWidth,
      CATEGORY_COUNT,
      PLOT_LEFT,
      PLOT_RIGHT,
    )
    const anchorCenter = categoryCenterX(
      anchorMonth,
      chartWidth,
      CATEGORY_COUNT,
      PLOT_LEFT,
      PLOT_RIGHT,
    )
    return placeTooltipBesideBar({
      hoveredCenter,
      anchorCenter,
      chartWidth,
      align: 'start',
    })
  }, [hoveredMonth, anchorMonth, chartWidth])
  // Measured tooltip height so vertical placement can pin above the
  // cursor and flip below only when there is no room. Measured via
  // callback ref (no render-phase reads); updates only on change.
  const [tipH, setTipH] = useState(220)
  const setTipRef = useCallback((el: HTMLDivElement | null) => {
    const h = el?.offsetHeight ?? 0
    if (h > 0) setTipH((prev) => (prev === h ? prev : h))
  }, [])
  const tooltipY =
    validCursor && Number.isFinite(validCursor.y)
      ? placeTooltipVertically(validCursor.y, tipH, bodyHeight - 24)
      : 8

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

      <div ref={setBodyRef} className="p-5">
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
            <div ref={setWrapRef} className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 18, right: 8, bottom: 0, left: -12 }}
                  barCategoryGap="28%"
                  onMouseMove={(s: { activeTooltipIndex?: unknown; activeCoordinate?: unknown } | undefined) => {
                    // Recharts v3 reports categorical indices as
                    // strings and exposes the true tooltip anchor as
                    // `activeCoordinate` (wrapper pixels). Both are
                    // read defensively — never viewport clientX.
                    const idx = toMonthIndex(s?.activeTooltipIndex)
                    if (idx === null) {
                      setHover(null)
                      setCursor(null)
                      return
                    }
                    const coord = s?.activeCoordinate as
                      | { x?: unknown; y?: unknown }
                      | undefined
                    const cx = coord && typeof coord.x === 'number' ? coord.x : null
                    const cy = coord && typeof coord.y === 'number' ? coord.y : null
                    setCursor(cx !== null && cy !== null ? { x: cx, y: cy } : null)
                    // Segment handlers below refine `key` when the
                    // library reports a per-Bar hover; the month index
                    // always updates so the tooltip never goes stale.
                    setHover((prev) => (prev?.month === idx ? prev : { key: '', month: idx }))
                  }}
                  onMouseLeave={() => {
                    setHover(null)
                    setCursor(null)
                  }}
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
                    tickFormatter={formatCountTick}
                    width={56}
                  />
                  <Tooltip
                    cursor={{ fill: '#f1f5f9', opacity: 0.6 }}
                    allowEscapeViewBox={{ x: false, y: false }}
                    wrapperStyle={{ pointerEvents: 'none', zIndex: 10 }}
                    position={{
                      x: tooltipX,
                      y: tooltipY,
                    }}
                    content={({ active, payload, label, activeIndex }) => {
                      if (!active || !payload?.length) return null
                      // Single source of truth for the hovered month:
                      // the categorical index (drives dimming + anchor),
                      // with the axis label as fallback. Never mix the
                      // index with an individual series payload or the
                      // label alone — that disagreement rendered
                      // February content on the August bar.
                      const monthIdx = resolveActiveMonth(activeIndex, label, MONTH_SHORT)
                      if (monthIdx === null) return null
                      if (!stacked || !stacks) {
                        const v = totals[monthIdx] ?? 0
                        return (
                          <div ref={setTipRef} className="rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                            <p className="font-medium text-foreground">{MONTH_SHORT[monthIdx]}</p>
                            <p className="text-muted-foreground tabular-nums">
                              {v.toLocaleString()} contact{v === 1 ? '' : 's'}
                            </p>
                          </div>
                        )
                      }
                      const total = totals[monthIdx] ?? 0
                      const title = `${MONTH_LONG[monthIdx] ?? label} ${year}`
                      if (total <= 0) {
                        return (
                          <div ref={setTipRef} className="rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                            <p className="font-medium text-foreground">{title}</p>
                            <p className="text-muted-foreground tabular-nums">No contacts this month</p>
                          </div>
                        )
                      }
                      // Rows derive from the same stack model as the
                      // bars, so tooltip colors always match segments.
                      const { rows } = stacks ? buildMonthTooltip(stacks, monthIdx) : { rows: [] as never[] }
                      return (
                        <div ref={setTipRef} className="min-w-[220px] rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                          <p className="font-medium text-foreground">{title}</p>
                          <p className="mb-1 text-muted-foreground tabular-nums">
                            {total.toLocaleString()} unique contact{total === 1 ? '' : 's'}
                          </p>
                          <div className="space-y-1 border-t border-border pt-1.5">
                            {rows.map((r) => {
                              const emphasized = hover?.key === r.key
                              return (
                                <div
                                  key={r.key}
                                  className={
                                    emphasized
                                      ? 'flex items-center gap-2 rounded bg-muted/70 font-semibold tabular-nums'
                                      : 'flex items-center gap-2 tabular-nums'
                                  }
                                >
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
                              )
                            })}
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
                        onMouseEnter={(_, i) => {
                          const m = toMonthIndex(i)
                          if (m !== null) setHover({ key: k.key, month: m })
                        }}
                      >
                        {stacks.months.map((sm, i) => {
                          const dimmed = hoveredMonth !== null && i !== hoveredMonth
                          const sameMonthMuted =
                            hoveredMonth === i &&
                            hover !== null &&
                            hover.key !== '' &&
                            hover.key !== k.key
                          return (
                            <Cell
                              key={i}
                              fill={k.color}
                              opacity={dimmed ? 0.35 : sameMonthMuted ? 0.55 : 1}
                            />
                          )
                        })}
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
