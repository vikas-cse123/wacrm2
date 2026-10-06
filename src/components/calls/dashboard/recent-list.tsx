'use client';

import Link from 'next/link';
import { HelpCircle, PhoneIncoming, PhoneOutgoing, Play } from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import { Button } from '@/components/ui/button';
import type { RecentRecordingRow } from '@/lib/calls/client';
import { formatCallDateTime, formatTalkTime } from '@/lib/calls/formatters';
import { cn } from '@/lib/utils';

function displayName(r: RecentRecordingRow): string {
  if (r.contactName) return r.contactName;
  if (r.phoneNumber) return r.phoneNumber;
  if (r.fileName) return r.fileName;
  return 'Unknown recording';
}

/**
 * Latest 5 recordings. Playback reuses the existing secure audio
 * endpoint (/api/recordings/[id]/audio → 60s signed URL) — no raw
 * storage URLs, no second player implementation.
 */
export function RecentList({
  recent,
  loading,
}: {
  recent: RecentRecordingRow[] | null;
  loading: boolean;
}) {
  const [playingId, setPlayingId] = useState<string | null>(null);

  return (
    <section
      aria-label="Recent recorded calls"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
          Recent Recorded Calls
        </h2>
        <Button variant="ghost" size="sm" className="text-blue-600" render={<Link href="/recordings" />}>
          View All
        </Button>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        {loading || !recent ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[52px] w-full" />)
        ) : recent.length === 0 ? (
          <EmptyState title="No recordings yet" hint="Recordings will appear here once calls are uploaded." />
        ) : (
          recent.map((r) => {
            const Icon =
              r.direction === 'in' ? PhoneIncoming : r.direction === 'out' ? PhoneOutgoing : HelpCircle;
            const iconTone =
              r.direction === 'in'
                ? 'text-emerald-600 dark:text-emerald-400'
                : r.direction === 'out'
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-muted-foreground';
            const playing = playingId === r.id;
            return (
              <div key={r.id} className="rounded-lg px-2 py-1.5 hover:bg-muted/50">
                <div className="flex items-center gap-3">
                  <Icon className={cn('h-5 w-5 shrink-0', iconTone)} aria-label={r.direction === 'in' ? 'Inbound' : r.direction === 'out' ? 'Outbound' : 'Unknown direction'} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{displayName(r)}</p>
                    <p className="truncate text-xs text-muted-foreground">{formatCallDateTime(r.recordedAt ?? r.createdAt)}</p>
                  </div>
                  <span className="text-[13px] tabular-nums text-muted-foreground">
                    {r.durationSecs === null ? '—' : formatTalkTime(r.durationSecs)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={playing ? `Stop ${displayName(r)}` : `Play ${displayName(r)}`}
                    onClick={() => setPlayingId(playing ? null : r.id)}
                    className="h-9 w-9 rounded-full bg-muted text-foreground hover:bg-muted"
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                </div>
                {playing ? (
                  <audio
                    className="mt-2 h-8 w-full"
                    src={`/api/recordings/${r.id}/audio`}
                    controls
                    autoPlay
                    preload="none"
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
