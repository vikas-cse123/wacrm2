"use client"

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, GitBranch } from 'lucide-react'
import type { FlowBreakdownRow } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'
import { Button } from '@/components/ui/button'

interface FlowBreakdownProps {
  rows: FlowBreakdownRow[] | null
  /** Distinct contacts messaged in range (section total). */
  totalContacts: number | null
  loading: boolean
  rangeLabel: string
}

const INITIAL_VISIBLE = 6

export function FlowBreakdown({ rows, totalContacts, loading, rangeLabel }: FlowBreakdownProps) {
  const [expanded, setExpanded] = useState(false)

  if (loading || rows == null) {
    return (
      <section className="rounded-xl border border-border bg-card" aria-label="Contact Breakdown by Flow">
        <Header rangeLabel={rangeLabel} total={null} />
        <div className="space-y-3 p-5">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </section>
    )
  }

  const visible = expanded ? rows : rows.slice(0, INITIAL_VISIBLE)
  const hiddenCount = rows.length - visible.length

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Contact Breakdown by Flow">
      <Header rangeLabel={rangeLabel} total={totalContacts} />

      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={GitBranch}
            title="No contacts messaged in this period"
            hint="Contacts appear here once they exchange messages with a flow."
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  <th scope="col" className="px-5 py-3 font-medium">Flow</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Contacts</th>
                  <th scope="col" className="w-[38%] min-w-[180px] px-5 py-3 font-medium">% of Contacts</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.flowId ?? '__no_flow__'} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-5 py-3.5">
                      {row.flowId ? (
                        <>
                          <Link
                            href={`/flows/${row.flowId}`}
                            title={`Open ${row.flowName}`}
                            className="font-medium text-foreground hover:text-blue-600 hover:underline"
                          >
                            {row.flowName}
                          </Link>{' '}
                          <Link
                            href={`/flows/${row.flowId}/runs`}
                            title={`View runs for ${row.flowName}`}
                            className="ml-1 text-xs font-normal text-muted-foreground hover:text-blue-600 hover:underline"
                          >
                            Runs
                          </Link>
                        </>
                      ) : (
                        <span className="font-medium text-foreground">{row.flowName}</span>
                      )}
                    </td>
                    <td className="px-3 py-3.5 text-right font-semibold tabular-nums text-foreground">
                      {row.contacts.toLocaleString()}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div
                          className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                          role="progressbar"
                          aria-valuenow={Math.round(row.pct)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`${row.flowName} ${row.pct.toFixed(1)} percent of total`}
                        >
                          <div
                            className="h-full rounded-full bg-blue-500 transition-[width]"
                            style={{ width: `${Math.max(2, Math.min(100, row.pct))}%` }}
                          />
                        </div>
                        <span className="w-11 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
                          {row.pct.toFixed(row.pct >= 10 ? 0 : 1)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > INITIAL_VISIBLE && (
            <div className="border-t border-border px-5 py-3">
              <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} className="text-[13px]">
                {expanded ? (
                  <>
                    Show less <ChevronUp className="size-3.5" />
                  </>
                ) : (
                  <>
                    View all {rows.length} flows {hiddenCount > 0 && `(${hiddenCount} more)`} <ChevronDown className="size-3.5" />
                  </>
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Header({ rangeLabel, total }: { rangeLabel: string; total: number | null }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-5 py-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">Contact Breakdown by Flow</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {total == null ? `Contacts messaged per flow · ${rangeLabel}` : `${total.toLocaleString()} contacts messaged · ${rangeLabel}`}
        </p>
      </div>
    </header>
  )
}
