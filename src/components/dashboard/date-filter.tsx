"use client"

import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { DashboardDateFilter } from '@/lib/dashboard/date-utils'
import { toDateInputValue } from '@/lib/dashboard/date-utils'

interface DateFilterProps {
  value: DashboardDateFilter
  onChange: (v: DashboardDateFilter) => void
  customFrom: string
  customTo: string
  onCustomApply: (from: string, to: string) => void
}

const OPTIONS: { value: DashboardDateFilter; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: 'last30days', label: 'Last 30 Days' },
  { value: 'custom', label: 'Custom' },
]

export function DateFilter({ value, onChange, customFrom, customTo, onCustomApply }: DateFilterProps) {
  const [open, setOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState(customFrom)
  const [draftTo, setDraftTo] = useState(customTo)

  const todayInput = toDateInputValue(new Date())

  const applyCustom = () => {
    const from = draftFrom || todayInput
    const to = draftTo || draftFrom || todayInput
    onCustomApply(from, to)
    setOpen(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Dashboard date range">
      {OPTIONS.filter((o) => o.value !== 'custom').map((o) => {
        const active = value === o.value
        return (
          <Button
            key={o.value}
            role="tab"
            aria-selected={active}
            variant={active ? 'default' : 'outline'}
            size="sm"
            onClick={() => onChange(o.value)}
            className={cn(
              'h-8 rounded-full px-3.5 text-[13px] font-medium',
              !active && 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {o.label}
          </Button>
        )
      })}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant={value === 'custom' ? 'default' : 'outline'}
              size="sm"
              className={cn(
                'h-8 rounded-full px-3.5 text-[13px] font-medium',
                value !== 'custom' && 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            />
          }
        >
          <CalendarDays className="size-3.5" />
          {value === 'custom' && customFrom && customTo ? `${customFrom} – ${customTo}` : 'Custom'}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <p className="text-sm font-medium text-foreground">Custom date range</p>
          <p className="text-xs text-muted-foreground">Pick a start and end day. Metrics compare against the previous equal-length period.</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              From
              <Input
                type="date"
                value={draftFrom || customFrom || todayInput}
                max={todayInput}
                onChange={(e) => setDraftFrom(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              To
              <Input
                type="date"
                value={draftTo || customTo || todayInput}
                max={todayInput}
                onChange={(e) => setDraftTo(e.target.value)}
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={applyCustom}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
