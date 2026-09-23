"use client"

import { useState } from 'react'
import { CalendarDays, ChevronDown } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { parseDateInput, toDateInputValue } from '@/lib/dashboard/date-utils'
import {
  formatDayRangeLabel,
  validateCustomDailyRange,
} from '@/lib/dashboard/daily-range'

/**
 * The "Contacts Messaged" chart's own range control. Lives in that
 * card's header and controls nothing else on the dashboard —
 * presets are Last 30 Days (default) or a custom calendar range.
 * Reuses the shared Calendar range picker (no new dependency);
 * theme-aware classes match the WACRM enterprise UI in both
 * light and dark mode.
 */
export type DailyChartRange =
  | { kind: 'last30' }
  | { kind: 'custom'; from: string; to: string }

interface DailyRangeControlProps {
  value: DailyChartRange
  onChange: (v: DailyChartRange) => void
  disabled?: boolean
}

function rangeToDateRange(value: DailyChartRange): DateRange | undefined {
  if (value.kind !== 'custom') return undefined
  const from = parseDateInput(value.from)
  const to = parseDateInput(value.to)
  if (!from || !to) return undefined
  return { from, to }
}

export function DailyRangeControl({ value, onChange, disabled }: DailyRangeControlProps) {
  const [open, setOpen] = useState(false)
  const [preset, setPreset] = useState<'last30' | 'custom'>(
    value.kind === 'custom' ? 'custom' : 'last30',
  )
  const [range, setRange] = useState<DateRange | undefined>(() => rangeToDateRange(value))
  const [error, setError] = useState<string | null>(null)

  const triggerLabel =
    value.kind === 'custom'
      ? formatDayRangeLabel(value.from, value.to)
      : 'Last 30 Days'

  const handleOpenChange = (next: boolean) => {
    if (next) {
      // Fresh draft from the applied value every time the picker opens.
      setPreset(value.kind === 'custom' ? 'custom' : 'last30')
      setRange(rangeToDateRange(value))
      setError(null)
    }
    setOpen(next)
  }

  const handleApply = () => {
    if (preset === 'last30') {
      onChange({ kind: 'last30' })
      setOpen(false)
      return
    }
    if (!range?.from) {
      setError('Pick a start and an end date.')
      return
    }
    const from = toDateInputValue(range.from)
    const to = toDateInputValue(range.to ?? range.from)
    const problem = validateCustomDailyRange(from, to)
    if (problem) {
      setError(problem)
      return
    }
    onChange({ kind: 'custom', from, to })
    setOpen(false)
  }

  const today = new Date()

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-8 rounded-full px-3.5 text-[13px] font-medium border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        }
      >
        <CalendarDays className="mr-1.5 size-3.5" />
        {triggerLabel}
        <ChevronDown className="ml-1.5 size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-3">
        <p className="text-xs font-medium text-foreground">Chart range</p>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {(
            [
              { id: 'last30', label: 'Last 30 Days' },
              { id: 'custom', label: 'Custom' },
            ] as const
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPreset(p.id)
                setError(null)
              }}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px] transition-colors',
                preset === p.id
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted/60',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="mt-2 rounded-md border border-border">
            <Calendar
              mode="range"
              selected={range}
              onSelect={setRange}
              numberOfMonths={1}
              disabled={{ after: today }}
              autoFocus
            />
            <p className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
              {range?.from
                ? formatDayRangeLabel(
                    toDateInputValue(range.from),
                    toDateInputValue(range.to ?? range.from),
                  )
                : 'Pick a start and end date'}
            </p>
          </div>
        )}
        {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleApply}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
