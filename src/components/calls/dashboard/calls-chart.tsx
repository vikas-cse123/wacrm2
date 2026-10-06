'use client';

import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import type { DayBucket } from '@/lib/calls/aggregate';
import { formatTalkTime } from '@/lib/calls/formatters';
import { cn } from '@/lib/utils';

export const INBOUND_COLOR = '#22c55e';
export const OUTBOUND_COLOR = '#2563eb';
export const UNKNOWN_COLOR = '#94a3b8';
export const DURATION_COLOR = '#8b5cf6';

function shortDay(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (!y || !m || !d) return dateKey;
  return `${months[m - 1]} ${d}`;
}

/**
 * Recorded-calls-over-time: stacked inbound/outbound(/unknown) bars
 * per calendar day, or daily talk time in Duration mode. Zero-filled
 * by the API, so gaps are real zeros — never fabricated.
 */
export function CallsChart({
  daily,
  loading,
}: {
  daily: DayBucket[] | null;
  loading: boolean;
}) {
  const [mode, setMode] = useState<'calls' | 'duration'>('calls');

  const hasData = !!daily && daily.some((d) => d.inbound + d.outbound + d.unknown > 0);
  const showUnknown = !!daily && daily.some((d) => d.unknown > 0);

  return (
    <section
      aria-label="Recorded calls over time"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
            Recorded Calls Over Time
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Number of recorded calls per day
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Chart metric"
          className="flex rounded-full border border-border bg-muted/60 p-0.5 text-[13px]"
        >
          {(['calls', 'duration'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-full px-3.5 py-1 font-medium transition-colors',
                mode === m
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {m === 'calls' ? 'Calls' : 'Duration'}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {loading || !daily ? (
          <Skeleton className="h-[280px] w-full" />
        ) : !hasData ? (
          <EmptyState
            title="No recorded calls in this period"
            hint="Try a wider date range or a different filter."
          />
        ) : (
          <>
            <div className="h-[280px] w-full">
              <ResponsiveContainer>
                <BarChart data={daily} margin={{ top: 12, right: 8, bottom: 0, left: -8 }} barCategoryGap="28%">
                  <CartesianGrid stroke="#eef2f7" vertical={false} className="dark:opacity-20" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDay}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e5e9f0' }}
                    minTickGap={24}
                  />
                  <YAxis
                    allowDecimals={false}
                    width={48}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) =>
                      mode === 'duration' ? formatTalkTime(v) : String(v)
                    }
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0]?.payload as DayBucket | undefined;
                      return (
                        <div className="min-w-[200px] rounded-lg border border-border bg-popover px-3 py-2 shadow-md">
                          <p className="mb-1 text-[13px] font-semibold text-foreground">
                            {typeof label === 'string' ? shortDay(label) : ''}
                          </p>
                          {mode === 'calls' ? (
                            <>
                              <ChartTipRow color={OUTBOUND_COLOR} name="Outbound" value={String(row?.outbound ?? 0)} />
                              <ChartTipRow color={INBOUND_COLOR} name="Inbound" value={String(row?.inbound ?? 0)} />
                              {showUnknown ? (
                                <ChartTipRow color={UNKNOWN_COLOR} name="Unknown" value={String(row?.unknown ?? 0)} />
                              ) : null}
                            </>
                          ) : (
                            <ChartTipRow
                              color={DURATION_COLOR}
                              name="Talk time"
                              value={formatTalkTime(row?.durationSecs ?? 0)}
                            />
                          )}
                        </div>
                      );
                    }}
                  />
                  {mode === 'calls' ? (
                    <>
                      <Bar dataKey="outbound" stackId="calls" fill={OUTBOUND_COLOR} radius={[0, 0, 0, 0]} />
                      <Bar dataKey="inbound" stackId="calls" fill={INBOUND_COLOR} radius={[4, 4, 0, 0]} />
                      {showUnknown ? (
                        <Bar dataKey="unknown" stackId="calls" fill={UNKNOWN_COLOR} radius={[4, 4, 0, 0]} />
                      ) : null}
                    </>
                  ) : (
                    <Bar dataKey="durationSecs" fill={DURATION_COLOR} radius={[4, 4, 0, 0]} name="Talk time" />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-[13px] text-muted-foreground">
              {mode === 'calls' ? (
                <>
                  <LegendDot color={OUTBOUND_COLOR} label="Outbound" />
                  <LegendDot color={INBOUND_COLOR} label="Inbound" />
                  {showUnknown ? <LegendDot color={UNKNOWN_COLOR} label="Unknown" /> : null}
                </>
              ) : (
                <LegendDot color={DURATION_COLOR} label="Talk time" />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function ChartTipRow({ color, name, value }: { color: string; name: string; value: string }) {
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="flex-1">{name}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </p>
  );
}
