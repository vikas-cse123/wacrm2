import { describe, expect, it } from 'vitest'
import {
  MONTH_TOOLTIP_WIDTH,
  anchorCategory,
  categoryCenterX,
  clampTooltipX,
  formatCountTick,
  placeTooltipBesideBar,
  placeTooltipVertically,
  placeTooltipY,
  resolveActiveMonth,
  toDayIndex,
  toMonthIndex,
} from './chart-helpers'
describe('formatCountTick', () => {
  it('groups thousands so ticks never render as ambiguous raw digits', () => {
    expect(formatCountTick(0)).toBe('0')
    expect(formatCountTick(999)).toBe('999')
    expect(formatCountTick(1050)).toBe('1,050')
    expect(formatCountTick(1174)).toBe('1,174')
    expect(formatCountTick(1174000)).toBe('1,174,000')
  })

  it('handles non-numeric input without throwing', () => {
    expect(formatCountTick('2500')).toBe('2,500')
    expect(formatCountTick(NaN)).toBe('')
    expect(formatCountTick(undefined)).toBe('')
    expect(formatCountTick(12.7)).toBe('12')
  })
})

describe('clampTooltipX', () => {
  const W = 800

  it('centers the card on the anchor in open water', () => {
    expect(clampTooltipX(400, W)).toBe(400 - MONTH_TOOLTIP_WIDTH / 2)
  })

  it('pins to the left edge near January', () => {
    expect(clampTooltipX(10, W)).toBe(4)
  })

  it('pins to the right edge near December', () => {
    expect(clampTooltipX(W - 5, W)).toBe(W - MONTH_TOOLTIP_WIDTH - 4)
  })

  it('degrades safely on narrow or unmeasured containers', () => {
    expect(clampTooltipX(400, 200)).toBeGreaterThanOrEqual(4)
    expect(clampTooltipX(400, 200)).toBeLessThanOrEqual(200)
    expect(clampTooltipX(NaN, W)).toBe(4)
    expect(clampTooltipX(400, 0)).toBe(4)
  })
})

describe('toMonthIndex', () => {
  it('accepts numbers and numeric strings from recharts v3', () => {
    expect(toMonthIndex(6)).toBe(6)
    expect(toMonthIndex('6')).toBe(6)
    expect(toMonthIndex(0)).toBe(0)
    expect(toMonthIndex('0')).toBe(0)
  })

  it('rejects anything that is not a month index', () => {
    expect(toMonthIndex('jul')).toBeNull()
    expect(toMonthIndex('')).toBeNull()
    expect(toMonthIndex(null)).toBeNull()
    expect(toMonthIndex(undefined)).toBeNull()
    expect(toMonthIndex(12)).toBeNull()
    expect(toMonthIndex(-1)).toBeNull()
    expect(toMonthIndex(6.5)).toBeNull()
  })
})

describe('placeTooltipY', () => {
  it('pins above the cursor when the card fits', () => {
    expect(placeTooltipY(200, 150)).toBe(200 - 150 - 12)
  })

  it('flips below the cursor near the top edge', () => {
    expect(placeTooltipY(100, 180)).toBe(100 + 12 + 4)
    // Flipped position stays below the cursor point.
    expect(placeTooltipY(100, 180)).toBeGreaterThan(100)
  })

  it('falls back safely without measurements', () => {
    expect(placeTooltipY(NaN, 150)).toBe(8)
    // Zero height → fallback height path.
    expect(placeTooltipY(200, 0)).toBe(216)
  })
})

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

describe('resolveActiveMonth', () => {
  it.each([
    [7, 'Aug', 7],
    [6, 'Jul', 6],
    [8, 'Sep', 8],
    [1, 'Feb', 1],
  ])(
    'hover month %i (%s) resolves month %i',
    (index, label, expected) => {
      // String indices are what recharts v3 actually reports.
      expect(resolveActiveMonth(String(index), label, MONTHS)).toBe(expected)
      expect(resolveActiveMonth(index, label, MONTHS)).toBe(expected)
    },
  )

  it('falls back to the axis label only when the index is unusable', () => {
    expect(resolveActiveMonth(null, 'Sep', MONTHS)).toBe(8)
    expect(resolveActiveMonth(undefined, 'Feb', MONTHS)).toBe(1)
    expect(resolveActiveMonth('n/a', 'Jul', MONTHS)).toBe(6)
  })

  it('returns null when neither signal resolves', () => {
    expect(resolveActiveMonth(null, null, MONTHS)).toBeNull()
    expect(resolveActiveMonth(null, 'Smarch', MONTHS)).toBeNull()
    expect(resolveActiveMonth(99, 'Smarch', MONTHS)).toBeNull()
  })

  it('keeps multiple stacked series on the same category month', () => {
    // Nine stacked Bar series share one categorical index; the month
    // must not come from any single series payload.
    expect(resolveActiveMonth('7', 'Aug', MONTHS)).toBe(7)
    expect(resolveActiveMonth('7', 'Aug', MONTHS)).not.toBe(1)
  })
})

describe('toDayIndex', () => {
  it('accepts numbers and numeric strings in the 30-day window', () => {
    expect(toDayIndex(0)).toBe(0)
    expect(toDayIndex(29)).toBe(29)
    expect(toDayIndex('11')).toBe(11)
  })

  it('rejects anything outside the window', () => {
    expect(toDayIndex('')).toBeNull()
    expect(toDayIndex(null)).toBeNull()
    expect(toDayIndex(undefined)).toBeNull()
    expect(toDayIndex('sep')).toBeNull()
    expect(toDayIndex(30)).toBeNull()
    expect(toDayIndex(-1)).toBeNull()
    expect(toDayIndex(3.5)).toBeNull()
  })
})

describe('placeTooltipVertically', () => {
  // Chart box 280 tall, content box ~400: lower bound for the card
  // bottom edge in wrapper coordinates.
  const BOUND = 400 - 24

  it('pins above the cursor when the measured card fits', () => {
    expect(placeTooltipVertically(200, 150, BOUND)).toBe(200 - 150 - 12)
  })

  it('flips below the cursor only when the card fits there', () => {
    // Low cursor, card too tall for above: below fits in bounds.
    expect(placeTooltipVertically(100, 150, BOUND)).toBe(100 + 12 + 4)
    const y = placeTooltipVertically(100, 150, BOUND)
    expect(y + 150).toBeLessThanOrEqual(BOUND)
  })

  it('falls back to the top instead of clipping past the boundary', () => {
    // Tall card, low cursor, short container: neither fits.
    expect(placeTooltipVertically(250, 300, 300)).toBe(4)
  })

  it('uses the dynamic measured height, not a fixed one', () => {
    // One-flow February card vs six-flow July card at same cursor.
    expect(placeTooltipVertically(150, 80, BOUND)).toBe(150 - 80 - 12)
    expect(placeTooltipVertically(150, 260, BOUND)).toBe(4)
  })

  it('falls back safely without measurements', () => {
    expect(placeTooltipVertically(NaN, 150, BOUND)).toBe(8)
    expect(placeTooltipVertically(200, 0, BOUND)).toBe(4)
  })
})

describe('anchorCategory', () => {
  it('anchors two categories back', () => {
    expect(anchorCategory(6, 12)).toBe(4) // July → May area
    expect(anchorCategory(7, 12)).toBe(5) // August → June area
    expect(anchorCategory(8, 12)).toBe(6) // September → July area
    expect(anchorCategory(11, 12)).toBe(9) // December → October area
  })

  it('falls back to the nearest valid category near the left edge', () => {
    expect(anchorCategory(1, 12)).toBe(0) // February → January area
    expect(anchorCategory(0, 12)).toBe(1) // January → February area
  })

  it('returns null for unusable input', () => {
    expect(anchorCategory(null, 12)).toBeNull()
    expect(anchorCategory(12, 12)).toBeNull()
    expect(anchorCategory(-1, 12)).toBeNull()
    expect(anchorCategory(0, 1)).toBeNull()
  })

  it('supports a custom lookback for the daily chart', () => {
    expect(anchorCategory(27, 30, 5)).toBe(22)
    expect(anchorCategory(10, 30, 5)).toBe(5)
    expect(anchorCategory(4, 30, 5)).toBe(3)
    expect(anchorCategory(0, 30, 5)).toBe(1)
  })
})

describe('beside-bar end-to-end placement', () => {
  // Plot geometry mirrors the monthly chart JSX (YAxis width 56 +
  // margin.left -12 = 44 left inset, margin.right 8).
  const W = 900
  const PLOT_LEFT = 44
  const PLOT_RIGHT = 8
  const N = 12
  const center = (month: number) => categoryCenterX(month, W, N, PLOT_LEFT, PLOT_RIGHT)
  const placedX = (month: number) => {
    const anchor = anchorCategory(month, N)!
    return placeTooltipBesideBar({
      hoveredCenter: center(month),
      anchorCenter: center(anchor),
      chartWidth: W,
    })
  }

  it.each([6, 7, 8])(
    'hover month %i parks left of its bar with data intact',
    (month) => {
      const x = placedX(month)
      const barLeft = center(month) - 19
      // Card right edge clears the hovered bar with a gap.
      expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(barLeft - 4)
      expect(x).toBeGreaterThanOrEqual(4)
    },
  )

  it('July parks in the May area', () => {
    const x = placedX(6)
    // May category center sits inside the card span.
    expect(center(4)).toBeGreaterThan(x)
    expect(center(4)).toBeLessThan(x + MONTH_TOOLTIP_WIDTH)
  })

  it('right-edge December stays inside', () => {
    const x = placedX(11)
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(W)
  })

  it('January falls back right of its bar', () => {
    expect(anchorCategory(0, N)).toBe(1)
    const x = placedX(0)
    // January bar (left of the card) stays clear.
    expect(x).toBeGreaterThanOrEqual(center(0) + 19)
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(W)
  })

  it('zero-value February uses the January area without escaping', () => {
    expect(anchorCategory(1, N)).toBe(0)
    const x = placedX(1)
    expect(x).toBeGreaterThanOrEqual(4)
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(W)
  })

  it('narrow widths clamp inside instead of parking off-chart', () => {
    const narrow = 340
    const plotW = narrow - PLOT_LEFT - PLOT_RIGHT
    const julyCenter = PLOT_LEFT + ((6 + 0.5) * plotW) / N
    const mayCenter = PLOT_LEFT + ((4 + 0.5) * plotW) / N
    const x = placeTooltipBesideBar({
      hoveredCenter: julyCenter,
      anchorCenter: mayCenter,
      chartWidth: narrow,
    })
    expect(x).toBeGreaterThanOrEqual(4)
    expect(x).toBeLessThanOrEqual(narrow - 4)
  })

  it('unmeasurable containers fall back to the left edge, never NaN', () => {
    const x = placeTooltipBesideBar({
      hoveredCenter: Number.NaN,
      anchorCenter: Number.NaN,
      chartWidth: 0,
    })
    expect(x).toBe(4)
  })
})

describe('daily previous-day end-to-end placement', () => {
  // Plot geometry mirrors the daily chart JSX (same insets as monthly).
  // Anchor rule: five days back (hover 30 Aug → 25 Aug area), plus one
  // extra category shift so the card's left edge starts a full five
  // days back. January-style right fallbacks shift nothing.
  const W = 900
  const PLOT_LEFT = 44
  const PLOT_RIGHT = 8
  const N = 30
  const center = (day: number) => categoryCenterX(day, W, N, PLOT_LEFT, PLOT_RIGHT)
  const catW = (W - PLOT_LEFT - PLOT_RIGHT) / N
  // Mirrors the daily chart exactly: extra shift gated on clearance.
  const placedX = (day: number) => {
    const anchor = anchorCategory(day, N, 5)!
    const base = placeTooltipBesideBar({
      hoveredCenter: center(day),
      anchorCenter: center(anchor),
      chartWidth: W,
    })
    if (center(anchor) >= center(day)) return base
    const shifted = base - catW
    const barLeft = center(day) - 19
    return shifted + MONTH_TOOLTIP_WIDTH <= barLeft - 4 ? Math.max(4, shifted) : base
  }

  it.each([27, 20, 15])(
    'hover day %i parks left of its bar, clear of it',
    (day) => {
      const x = placedX(day)
      const barLeft = center(day) - 19
      expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(barLeft - 4)
      expect(x).toBeGreaterThanOrEqual(4)
    },
  )

  it('early days go right instead of covering their bar', () => {
    // Day 2 has no room on the left: the card goes right of the
    // bar rather than overlapping it.
    const x = placedX(2)
    const barRight = center(2) + 19
    expect(x).toBeGreaterThanOrEqual(barRight)
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(W)
  })

  it('parks starting around five days back', () => {
    const x = placedX(27)
    // Card starts at/before the anchor day's neighborhood...
    expect(x).toBeLessThanOrEqual(center(22) + 40)
    // ...while the hovered bar stays clear.
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(center(27) - 19 - 4)
  })

  it('first day falls back right of its bar', () => {
    expect(anchorCategory(0, N, 5)).toBe(1)
    const x = placedX(0)
    expect(x).toBeGreaterThanOrEqual(center(0) + 19)
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(W)
  })

  it('zero-contact days still anchor by category', () => {
    // No bar is required: the anchor is purely categorical.
    const x = placedX(10)
    expect(Number.isFinite(x)).toBe(true)
    expect(x).toBeGreaterThanOrEqual(4)
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(W)
  })

  it('clamps inside at both edges', () => {
    const lastX = placedX(N - 1)
    expect(lastX + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(W)
    expect(placedX(0)).toBeGreaterThanOrEqual(4)
  })
})

describe('placeTooltipBesideBar start alignment', () => {
  // Monthly chart geometry at desktop width.
  const W = 900
  const PLOT_LEFT = 44
  const PLOT_RIGHT = 8
  const N = 12
  const center = (month: number) => categoryCenterX(month, W, N, PLOT_LEFT, PLOT_RIGHT)
  const placedStart = (month: number) => {
    const anchor = anchorCategory(month, N)!
    return placeTooltipBesideBar({
      hoveredCenter: center(month),
      anchorCenter: center(anchor),
      chartWidth: W,
      align: 'start',
    })
  }

  it('September starts at the July position on wide charts', () => {
    const wide = 1850
    const plotW = wide - PLOT_LEFT - PLOT_RIGHT
    const july = PLOT_LEFT + ((6 + 0.5) * plotW) / N
    const sep = PLOT_LEFT + ((8 + 0.5) * plotW) / N
    const x = placeTooltipBesideBar({
      hoveredCenter: sep,
      anchorCenter: july,
      chartWidth: wide,
      align: 'start',
    })
    // Left edge lands on the anchor; September bar stays clear.
    expect(x).toBeCloseTo(july, 5)
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(sep - 19 - 4)
  })

  it('falls back to clearance when starting at the anchor would overlap', () => {
    // September at desktop width: starting at July would cover the
    // September bar, so the card shifts left to clear it.
    const x = placedStart(8)
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(center(8) - 19 - 4)
    expect(x).toBeGreaterThanOrEqual(4)
  })

  it('keeps default center alignment untouched', () => {
    const x = placeTooltipBesideBar({
      hoveredCenter: center(8),
      anchorCenter: center(6),
      chartWidth: W,
    })
    // Centered on the anchor, then clearance-shifted (old behavior).
    expect(x + MONTH_TOOLTIP_WIDTH).toBeLessThanOrEqual(center(8) - 19 - 4)
  })
})
