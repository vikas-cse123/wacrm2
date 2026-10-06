"use client"

import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export type TileTone = 'neutral' | 'green' | 'orange' | 'red'

/**
 * Semantic accent, applied to the label icon only — the value
 * stays strong foreground, the label muted, like the rest of
 * WACRM. Uses the app's existing green/orange/red tones.
 */
const TONE_ICON: Record<TileTone, string> = {
  neutral: 'text-muted-foreground',
  green: 'text-emerald-600 dark:text-emerald-400',
  orange: 'text-orange-500 dark:text-orange-400',
  red: 'text-red-500 dark:text-red-400',
}

interface CallMetricTileProps {
  /** Display value ("31", "8m 58s", or "—" when unavailable). */
  value: string
  label: string
  icon: ComponentType<{ className?: string }>
  tone?: TileTone
  /** Shown on hover when the metric needs call-log data. */
  unavailableReason?: string
}

/**
 * One compact metric on a WACRM card surface: strong number,
 * smaller muted label, subtle icon. Unavailable metrics render
 * "—" (never 0) with an optional "Requires call-log data."
 * tooltip.
 */
export function CallMetricTile({
  value,
  label,
  icon: Icon,
  tone = 'neutral',
  unavailableReason,
}: CallMetricTileProps) {
  const tile = (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3">
      <p className="text-[22px] leading-none font-bold tracking-tight tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-1.5 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        <Icon className={cn('h-4 w-4 shrink-0', TONE_ICON[tone])} aria-hidden />
        <span className="truncate">{label}</span>
      </p>
    </div>
  )
  if (!unavailableReason) return tile
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="cursor-help">{tile}</div>} />
      <TooltipContent>
        <p className="text-xs">{unavailableReason}</p>
      </TooltipContent>
    </Tooltip>
  )
}
