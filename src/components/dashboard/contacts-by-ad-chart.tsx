"use client"

import { useMemo, useState } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { ExternalLink, Megaphone } from 'lucide-react'
import {
  NO_AD_KEY,
  OTHERS_KEY,
} from '@/lib/dashboard/flow-colors'
import {
  adBucketColors,
  adChartState,
  shortAdUrl,
  toSafeAdUrl,
} from '@/lib/dashboard/contacts-by-ad'
import type { ContactsByAd } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ContactsByAdChartProps {
  data: ContactsByAd | null
  loading: boolean
  rangeLabel: string
}

export function ContactsByAdChart({ data, loading, rangeLabel }: ContactsByAdChartProps) {
  // Colors reuse the dashboard chart system: ad URLs hash to palette
  // slots (stable across ranges for the same URL set), Other/No Ad
  // take the reserved neutral slots.
  const colored = useMemo(() => {
    if (!data) return null
    const colors = adBucketColors(data.rows)
    return data.rows.map((r) => {
      const isReserved = r.adKey === NO_AD_KEY || r.adKey === OTHERS_KEY
      return {
        ...r,
        displayLabel: isReserved ? r.adLabel : shortAdUrl(r.adLabel),
        // Only genuine ad/source URLs link out; reserved buckets and
        // unsafe values stay plain text.
        href: isReserved ? null : toSafeAdUrl(r.adLabel),
        color: colors.get(r.adKey) ?? '#64748b',
      }
    })
  }, [data])

  const [active, setActive] = useState<number | null>(null)

  const state = data ? adChartState(data.totalContacts, data.rows) : 'empty'

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Contacts by Ad">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
          Contacts by Ad
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Unique contacts who messaged from each ad · {rangeLabel}
        </p>
      </header>

      <div className="p-5">
        {loading || !data || !colored ? (
          <Skeleton className="h-[260px] w-full" />
        ) : state === 'empty' ? (
          <EmptyState
            icon={Megaphone}
            title="No contacts messaged in this period"
            hint="Ad-attributed contacts appear here once they message you."
          />
        ) : state === 'no-ads' ? (
          <EmptyState
            icon={Megaphone}
            title="No ad-attributed contacts in this period"
            hint="Contacts messaged you, but none came from a tracked ad. Share a Click-to-WhatsApp ad link to start attributing."
          />
        ) : (
          <div className="flex flex-col items-center gap-6 md:flex-row md:items-center">
            <div className="relative h-[240px] w-full max-w-[320px] shrink-0 md:w-[46%]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip
                    content={({ active: isActive, payload }) => {
                      if (!isActive || !payload?.length) return null
                      const datum = payload[0]?.payload as
                        | { adLabel?: unknown; contacts?: unknown; pct?: unknown; color?: unknown }
                        | undefined
                      const label = typeof datum?.adLabel === 'string' ? datum.adLabel : ''
                      const value = Number(datum?.contacts ?? 0)
                      const pct = Number(datum?.pct ?? 0)
                      const color = typeof datum?.color === 'string' ? datum.color : undefined
                      return (
                        <div className="max-w-[260px] rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md">
                          <p className="flex items-center gap-2 font-medium break-words text-foreground">
                            {color && (
                              <span
                                className="size-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: color }}
                              />
                            )}
                            <span className="break-all">{label}</span>
                          </p>
                          <p className="mt-0.5 text-muted-foreground tabular-nums">
                            {value.toLocaleString()} unique contact{value === 1 ? '' : 's'} ·{' '}
                            {pct.toFixed(1)}%
                          </p>
                        </div>
                      )
                    }}
                  />
                  <Pie
                    data={colored}
                    dataKey="contacts"
                    nameKey="displayLabel"
                    innerRadius="64%"
                    outerRadius="88%"
                    paddingAngle={2}
                    strokeWidth={0}
                    onMouseEnter={(_, i) => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                  >
                    {colored.map((row, i) => (
                      <Cell
                        key={`${row.adKey}-${i}`}
                        fill={row.color}
                        opacity={active === null || active === i ? 1 : 0.5}
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              {/* Donut center: total chart contacts (No Ad included). */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <p className="text-[26px] leading-none font-bold tracking-tight tabular-nums text-foreground">
                  {data.totalContacts.toLocaleString()}
                </p>
                <p className="mt-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  Contacts
                </p>
              </div>
            </div>

            <ul aria-label="Ad sources" className="max-h-60 w-full min-w-0 flex-1 space-y-1 overflow-y-auto md:max-h-64">
              {colored.map((row, i) => (
                <li key={`${row.adKey}-${i}`}>
                  <div
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    title={row.adLabel}
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 tabular-nums transition-colors hover:bg-muted/60"
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: row.color }}
                      aria-hidden
                    />
                    {row.href ? (
                      <a
                        href={row.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ad source ${row.displayLabel}`}
                        className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-[13px] text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <span className="min-w-0 flex-1 truncate">{row.displayLabel}</span>
                        <ExternalLink
                          className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                          aria-hidden
                        />
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {row.displayLabel}
                      </span>
                    )}
                    <span className="shrink-0 text-[13px] font-medium text-foreground">
                      {row.contacts.toLocaleString()}
                    </span>
                    <span className="w-12 shrink-0 text-right text-[12px] text-muted-foreground">
                      {row.pct.toFixed(1)}%
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
