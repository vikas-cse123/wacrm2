'use client';

import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import type { ComponentType } from 'react';

import { cn } from '@/lib/utils';

/**
 * KPI card matching the reference dashboard: soft icon disc, big
 * tabular number, and a period-over-period delta line. The delta
 * renders only when it is mathematically meaningful (null when the
 * previous period was empty) — never an invented trend.
 */
export function KpiCard({
  icon: Icon,
  label,
  value,
  deltaPct,
  prevLabel,
  /** Flip the good/bad color: rising unlinked calls are bad news. */
  invertDelta = false,
  iconClassName,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  deltaPct: number | null;
  prevLabel: string;
  invertDelta?: boolean;
  iconClassName?: string;
  action?: React.ReactNode;
}) {
  const up = deltaPct !== null && deltaPct > 0.05;
  const down = deltaPct !== null && deltaPct < -0.05;
  const good = invertDelta ? down : up;
  const bad = invertDelta ? up : down;
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div
        className={cn(
          'flex h-12 w-12 shrink-0 items-center justify-center rounded-full',
          iconClassName ?? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
        )}
      >
        <Icon className="h-6 w-6" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-muted-foreground">{label}</p>
        <p className="text-[26px] leading-8 font-bold tracking-tight tabular-nums text-foreground">
          {value}
        </p>
        {deltaPct !== null ? (
          <p className="mt-0.5 flex items-center gap-1 text-xs">
            <span
              className={cn(
                'inline-flex items-center gap-0.5 font-semibold tabular-nums',
                good && 'text-emerald-600 dark:text-emerald-400',
                bad && 'text-red-500 dark:text-red-400',
                !good && !bad && 'text-muted-foreground'
              )}
            >
              {up ? <ArrowUp className="h-3.5 w-3.5" /> : down ? <ArrowDown className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
              {`${Math.abs(deltaPct) < 10 ? deltaPct.toFixed(1) : Math.round(deltaPct)}%`}
            </span>
            <span className="text-muted-foreground">{prevLabel}</span>
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
