// Pure presentation helpers shared by dashboard charts.

/**
 * Axis tick formatter for contact counts. Recharts renders raw
 * numbers ("1050") which — combined with a tight axis width — can
 * clip into corrupted-looking labels. Locale grouping ("1,050")
 * plus a wider axis keeps every tick legible at any data range.
 */
export function formatCountTick(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ''
  return Math.trunc(n).toLocaleString('en-US')
}

/** Estimated pixel width of the month tooltip card. */
export const MONTH_TOOLTIP_WIDTH = 260

/** Fallback tooltip height estimate before the card is measured. */
export const MONTH_TOOLTIP_FALLBACK_HEIGHT = 220

/** Gap between the cursor anchor and the tooltip card. */
export const MONTH_TOOLTIP_GAP = 12

/**
 * Clamp a tooltip's left edge so the card stays inside the chart:
 * centered on `anchorX` when there is room, pinned to the near edge
 * otherwise. Pure so edge behavior is unit-testable.
 */
export function clampTooltipX(
  anchorX: number,
  chartWidth: number,
  tooltipWidth: number = MONTH_TOOLTIP_WIDTH,
): number {
  if (!Number.isFinite(anchorX) || !Number.isFinite(chartWidth) || chartWidth <= 0) {
    return 4
  }
  const minX = 4
  const maxX = Math.max(minX, chartWidth - tooltipWidth - 4)
  return Math.min(Math.max(anchorX - tooltipWidth / 2, minX), maxX)
}

/**
 * Coerce a recharts active index to a month number. Recharts v3
 * reports categorical indices as strings ("6") — a strict
 * `typeof === 'number'` check silently drops every hover, which is
 * exactly how the tooltip lost its anchor. Returns null when the
 * value is not a usable index.
 */
export function toMonthIndex(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value)
  } else {
    return null
  }
  if (!Number.isInteger(n) || n < 0 || n > 11) return null
  return n
}

/**
 * Resolve the hovered month from the chart library's active-index
 * signal, with the axis label as a consistency fallback. The title,
 * total, rows, dimming, and anchor MUST all derive from this one
 * value: mixing the categorical index (drives dimming/anchor) with
 * the label text or an individual series payload (drives the old
 * title/total) is what rendered February content on the August bar.
 *
 * The index wins when usable because every other visible affordance
 * (cursor band, dimming, anchor) already follows it; the label only
 * rescues the case where the index signal itself is missing.
 */
export function resolveActiveMonth(
  activeIndex: unknown,
  activeLabel: unknown,
  monthLabels: readonly string[],
): number | null {
  const fromIndex = toMonthIndex(activeIndex)
  if (fromIndex !== null) return fromIndex
  if (typeof activeLabel === 'string') {
    const at = monthLabels.indexOf(activeLabel)
    if (at >= 0 && at <= 11) return at
  }
  return null
}

/**
 * Day-index coercion for the 30-day chart (mirrors toMonthIndex).
 * Recharts v3 reports categorical indices as strings.
 */
export function toDayIndex(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value)
  } else {
    return null
  }
  if (!Number.isInteger(n) || n < 0 || n > 29) return null
  return n
}

/**
 * Which category the tooltip anchors to: `back` categories before
 * the hovered one (monthly: 2 back — hover July → May area; daily:
 * 5 back — hover 30 Aug → 25 Aug area), so the wide card clears
 * the hovered bar. Falls back to the nearest valid category near
 * the edges. Returns null when the hovered index itself is unusable.
 */
export function anchorCategory(
  hoveredIndex: number | null,
  categoryCount: number,
  back = 2,
): number | null {
  if (
    hoveredIndex === null ||
    !Number.isInteger(hoveredIndex) ||
    hoveredIndex < 0 ||
    hoveredIndex >= categoryCount
  ) {
    return null
  }
  const candidates = [
    hoveredIndex - back,
    hoveredIndex - 1,
    hoveredIndex + 1,
  ]
  for (const c of candidates) {
    if (c >= 0 && c < categoryCount) return c
  }
  return null
}

/**
 * Center of a categorical band in wrapper pixels. `plotLeft` /
 * `plotRight` are the plot-area insets (YAxis width + margins);
 * callers pass the values matching their chart JSX.
 */
export function categoryCenterX(
  index: number,
  chartWidth: number,
  categoryCount: number,
  plotLeft: number,
  plotRight: number,
): number {
  if (!Number.isFinite(chartWidth) || chartWidth <= 0 || categoryCount <= 0) {
    return Number.NaN
  }
  const plotWidth = chartWidth - plotLeft - plotRight
  if (plotWidth <= 0) return Number.NaN
  return plotLeft + ((index + 0.5) * plotWidth) / categoryCount
}

/**
 * Park the tooltip beside the hovered bar so the bar stays fully
 * visible. `align` controls the preferred spot relative to the
 * anchor category: 'center' centers the card on it (daily chart),
 * 'start' begins the card at it (monthly chart — hover September
 * starts the card at July). The preferred spot yields to bar
 * clearance (shifted out when it would overlap the hovered bar)
 * and to chart bounds last. When the anchor sits right of the bar
 * (January fallback), the card goes right instead.
 * Clamped into the chart after; unmeasurable input parks left.
 */
export function placeTooltipBesideBar(args: {
  hoveredCenter: number
  anchorCenter: number
  chartWidth: number
  tooltipWidth?: number
  barHalfWidth?: number
  gap?: number
  align?: 'center' | 'start'
}): number {
  const {
    hoveredCenter,
    anchorCenter,
    chartWidth,
    tooltipWidth = MONTH_TOOLTIP_WIDTH,
    barHalfWidth = 19,
    gap = MONTH_TOOLTIP_GAP,
    align = 'center',
  } = args
  const minX = 4
  const maxX = (Number.isFinite(chartWidth) ? chartWidth : 0) - tooltipWidth - 4
  if (!Number.isFinite(hoveredCenter) || !Number.isFinite(anchorCenter)) {
    return minX
  }
  // Preferred spot: centered on the anchor ('center') or starting
  // at it ('start'). It yields to bar clearance, then bounds.
  const preferred =
    align === 'start' ? anchorCenter : anchorCenter - tooltipWidth / 2
  const leftX = hoveredCenter - barHalfWidth - gap - tooltipWidth
  const rightX = hoveredCenter + barHalfWidth + gap
  if (anchorCenter < hoveredCenter) {
    if (Math.min(preferred, leftX) >= minX) return Math.min(preferred, leftX)
    return Math.min(Math.max(rightX, minX), Math.max(minX, maxX))
  }
  return Math.min(Math.max(Math.max(preferred, rightX), minX), Math.max(minX, maxX))
}

/**
 * Vertical tooltip placement with a container bound: above the
 * cursor when the measured card fits, otherwise below the cursor
 * when the card fits between the cursor and `lowerBound` (the
 * largest allowed bottom edge in the same coordinate system),
 * otherwise pinned to the top so a tall card stays fully visible
 * instead of clipping past the card boundary.
 */
export function placeTooltipVertically(
  cursorY: number,
  tooltipHeight: number,
  lowerBound: number,
  gap: number = MONTH_TOOLTIP_GAP,
): number {
  const h =
    Number.isFinite(tooltipHeight) && tooltipHeight > 0
      ? tooltipHeight
      : MONTH_TOOLTIP_FALLBACK_HEIGHT
  if (!Number.isFinite(cursorY)) return 8
  const above = cursorY - h - gap
  if (above >= 4) return above
  const below = cursorY + gap + 4
  if (below + h <= lowerBound) return below
  return 4
}

/**
 * Vertical tooltip placement relative to the cursor anchor: above
 * the cursor when the measured card fits, otherwise flipped below
 * it. Both branches keep the card clear of the cursor point itself
 * so the hovered bar body is never covered by a parked tooltip.
 * (Prefer placeTooltipVertically when a container bound is known.)
 */
export function placeTooltipY(
  cursorY: number,
  tooltipHeight: number,
  gap: number = MONTH_TOOLTIP_GAP,
): number {
  const h = Number.isFinite(tooltipHeight) && tooltipHeight > 0
    ? tooltipHeight
    : MONTH_TOOLTIP_FALLBACK_HEIGHT
  if (!Number.isFinite(cursorY)) return 8
  const above = cursorY - h - gap
  if (above >= 4) return above
  return cursorY + gap + 4
}
