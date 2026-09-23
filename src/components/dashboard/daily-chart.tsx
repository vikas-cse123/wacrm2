"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Users } from 'lucide-react'
import { MONTH_SHORT } from '@/lib/dashboard/date-utils'
import { buildDailyStacks, buildDailyTooltip } from '@/lib/dashboard/daily-stacks'
import { MONTH_TOOLTIP_WIDTH, anchorCategory, categoryCenterX, formatCountTick, placeTooltipBesideBar, placeTooltipVertically, toDayIndex } from '@/lib/dashboard/chart-helpers'
import { OTHERS_KEY } from '@/lib/dashboard/flow-colors'
import type { DailyContactsDay, DailyFlowDay } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface DailyChartProps {
  data: DailyContactsDay[] | null
  /** Per-day flow split. Null/empty → solid bars. */
  flows?: DailyFlowDay[] | null
  loading: boolean
}

const BAR_COLOR = '#2563eb'

function shortLabel(date: string): string {
  // 'YYYY-MM-DD' without Date parsing (no timezone shift).
  const parts = date.split('-')
  if (parts.length !== 3) return ''
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12) return ''
  return `${d} ${MONTH_SHORT[m - 1] ?? ''}`
}

function longLabel(date: string): string {
  const parts = date.split('-')
  if (parts.length !== 3) return date || 'Unknown date'
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return date
  return `${d} ${MONTH_SHORT[m - 1] ?? ''} ${y}`
}

export function DailyChart({ data, flows, loading }: DailyChartProps) {
  const days = useMemo(() => data ?? [], [data])
  const hasData = days.some((d) => d.contacts > 0)

  const stacks = useMemo(
    () => (flows && flows.length > 0 ? buildDailyStacks(flows) : null),
    [flows],
  )
  // Stack structure exists when at least one real flow is present.
  const stacked =
    stacks !== null &&
    stacks.keys.some((k) => k.flowId !== null || k.key === OTHERS_KEY)

  // Hover state: the day index plus which flow segment the cursor is
  // over. The hovered day stays full-strength while others dim.
  const [hover, setHover] = useState<{ key: string; day: number } | null>(null)
  const hoveredDay = hover?.day ?? null

  // Measured geometry for edge-aware tooltip placement. Callback
  // refs (not a mount effect) attach the observers whenever the
  // elements exist — a mount-only effect misses them because the
  // chart branch renders after loading, which would leave the
  // measured width at 0 and park every tooltip at the left edge.
  // wrapRef: the 240px chart box (tooltip coordinate system).
  // bodyRef: the padded content box (clip boundary).
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
      return days.map((d) => ({
        date: d.date,
        label: shortLabel(d.date),
        contacts: d.contacts,
      }))
    }
    return stacks.days.map((sd) => {
      const row: Record<string, string | number> = {
        date: sd.date,
        label: shortLabel(sd.date),
        total: sd.total,
      }
      for (const seg of sd.segments) row[seg.key] = seg.value
      return row
    })
  }, [stacked, stacks, days])

  const lastKey = stacked && stacks ? stacks.keys[stacks.keys.length - 1]?.key : null

  // Topmost non-zero segment of the hovered day gets the rounded top.
  const roundedKey = useMemo(() => {
    if (hoveredDay == null || !stacked || !stacks) return lastKey
    const sd = stacks.days[hoveredDay]
    if (!sd) return lastKey
    for (let i = sd.segments.length - 1; i >= 0; i--) {
      if ((sd.segments[i]?.value ?? 0) > 0) return sd.segments[i]!.key
    }
    return lastKey
  }, [hoveredDay, stacked, stacks, lastKey])

  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const validCursor =
    cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) && (cursor.x > 0 || cursor.y > 0)
      ? cursor
      : null
  // Tooltip anchor: FIVE days back from the hovered day, with the
  // card shifted one extra category left so its left edge starts a
  // full five days back (hover 30 Aug → card starts at 25 Aug;
  // early days fall back nearer). The shift applies only when the
  // card stays clear of the hovered bar — right-side fallbacks
  // (first day) and clamped positions keep their safe spot.
  // Content (date/total/rows) still comes from the hovered day.
  // Plot insets mirror the BarChart margin + YAxis width below.
  const PLOT_LEFT = 44
  const PLOT_RIGHT = 8
  const BAR_HALF = 19
  const tooltipX = useMemo(() => {
    const n = chartData.length
    const anchorDay = anchorCategory(hoveredDay, n, 5)
    if (hoveredDay == null || anchorDay == null || n <= 0 || chartWidth <= 0) return 4
    const hoveredCenter = categoryCenterX(
      hoveredDay,
      chartWidth,
      n,
      PLOT_LEFT,
      PLOT_RIGHT,
    )
    const anchorCenter = categoryCenterX(
      anchorDay,
      chartWidth,
      n,
      PLOT_LEFT,
      PLOT_RIGHT,
    )
    const base = placeTooltipBesideBar({
      hoveredCenter,
      anchorCenter,
      chartWidth,
    })
    if (anchorCenter >= hoveredCenter) return base
    const catW = (chartWidth - PLOT_LEFT - PLOT_RIGHT) / n
    const shifted = base - catW
    const barLeft = hoveredCenter - BAR_HALF
    return shifted + MONTH_TOOLTIP_WIDTH <= barLeft - 4 ? Math.max(4, shifted) : base
  }, [hoveredDay, chartWidth, chartData.length])

  const [tipH, setTipH] = useState(220)
  const setTipRef = useCallback((el: HTMLDivElement | null) => {
    const h = el?.offsetHeight ?? 0
    if (h > 0) setTipH((prev) => (prev === h ? prev : h))
  }, [])
  const tooltipY =
    validCursor && Number.isFinite(validCursor.y)
      ? placeTooltipVertically(validCursor.y, tipH, bodyHeight - 24)
      : 8

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Contacts Messaged Last 30 Days">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
          Contacts Messaged — Last 30 Days
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Unique contacts per day · trailing 30 days
        </p>
      </header>

      <div ref={setBodyRef} className="p-5">
        {loading || data == null ? (
          <Skeleton className="h-[240px] w-full" />
        ) : !hasData ? (
          <EmptyState
            icon={Users}
            title="No contacts messaged in the last 30 days"
            hint="Each bar counts distinct contacts messaged that day."
          />
        ) : (
          <div ref={setWrapRef} className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 12, right: 8, bottom: 0, left: -12 }}
                barCategoryGap="32%"
                onMouseMove={(s: { activeTooltipIndex?: unknown; activeCoordinate?: unknown } | undefined) => {
                  const idx = toDayIndex(s?.activeTooltipIndex)
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
                  setHover((prev) => (prev?.day === idx ? prev : { key: '', day: idx }))
                }}
                onMouseLeave={() => {
                  setHover(null)
                  setCursor(null)
                }}
              >
                <CartesianGrid vertical={false} stroke="#eef2f7" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={{ stroke: '#e2e8f0' }}
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  interval={4}
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
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    // Single source of truth: the categorical day index
                    // (drives dimming + anchor). Totals pass through
                    // from the RPC, rows from the same stack model as
                    // the bars.
                    const dayIdx = hoveredDay
                    const day = dayIdx != null ? stacks?.days[dayIdx] : undefined
                    if (!stacked || !stacks || dayIdx == null || !day) {
                      const datum = payload[0]?.payload as
                        | { date?: unknown; contacts?: unknown }
                        | undefined
                      const date = typeof datum?.date === 'string' ? datum.date : ''
                      const value = Number(datum?.contacts ?? 0)
                      return (
                        <div ref={setTipRef} className="rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                          <p className="font-medium text-foreground">{longLabel(date)}</p>
                          <p className="text-muted-foreground tabular-nums">
                            {value.toLocaleString()} unique contact{value === 1 ? '' : 's'}
                          </p>
                        </div>
                      )
                    }
                    const total = day.total
                    if (total <= 0) {
                      return (
                        <div ref={setTipRef} className="rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                          <p className="font-medium text-foreground">{longLabel(day.date)}</p>
                          <p className="text-muted-foreground tabular-nums">No contacts this day</p>
                        </div>
                      )
                    }
                    const rows = dayIdx != null && stacks
                      ? buildDailyTooltip(stacks, dayIdx).rows
                      : []
                    return (
                      <div ref={setTipRef} className="min-w-[220px] rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                        <p className="font-medium text-foreground">{longLabel(day.date)}</p>
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
                      stackId="daily-contacts"
                      radius={k.key === roundedKey ? [5, 5, 0, 0] : [0, 0, 0, 0]}
                      maxBarSize={18}
                      onMouseEnter={(_, i) => {
                        const m = toDayIndex(i)
                        if (m !== null) setHover({ key: k.key, day: m })
                      }}
                    >
                      {stacks.days.map((sd, i) => {
                        const dimmed = hoveredDay !== null && i !== hoveredDay
                        const sameDayMuted =
                          hoveredDay === i &&
                          hover !== null &&
                          hover.key !== '' &&
                          hover.key !== k.key
                        return (
                          <Cell
                            key={i}
                            fill={k.color}
                            opacity={dimmed ? 0.35 : sameDayMuted ? 0.55 : 1}
                          />
                        )
                      })}
                    </Bar>
                  ))
                ) : (
                  <Bar dataKey="contacts" name="Contacts" radius={[5, 5, 0, 0]} maxBarSize={18}>
                    {chartData.map((d, i) => (
                      <Cell key={`${d.date || 'pad'}-${i}`} fill={BAR_COLOR} fillOpacity={Number(d.contacts) > 0 ? 1 : 0.25} />
                    ))}
                  </Bar>
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  )
}
