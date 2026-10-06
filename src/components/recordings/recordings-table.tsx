'use client';

import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Minus,
  Phone,
  Play,
} from 'lucide-react';

import { Skeleton } from '@/components/dashboard/skeleton';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatRecordedIndia, type CallRecording } from '@/lib/recordings/recordings';
import { cn } from '@/lib/utils';

export const PAGE_SIZE = 10;

function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return '—';
  }
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

export function leadInitial(name: string | null | undefined): string {
  const first = (name ?? '').trim().slice(0, 1).toUpperCase();
  return first || 'U';
}

function TypeBadge({ callType }: { callType: string | null | undefined }) {
  if (callType === 'phone') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
        <Phone className="h-3 w-3" /> Phone
      </span>
    );
  }
  if (callType === 'whatsapp') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        <MessageCircle className="h-3 w-3" /> WhatsApp
      </span>
    );
  }
  if (callType === 'whatsapp_business') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        <MessageCircle className="h-3 w-3" /> WhatsApp Business
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

function DirectionBadge({ direction }: { direction: string | null | undefined }) {
  if (direction === 'in') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
        <ArrowDown className="h-3 w-3" /> Incoming
      </span>
    );
  }
  if (direction === 'out') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        <ArrowUp className="h-3 w-3" /> Outgoing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <Minus className="h-3 w-3" /> Unknown
    </span>
  );
}

/**
 * Recordings table: Lead | Recorded | Type | Direction | Duration |
 * Uploaded By | Play. No filename, no size, no storage internals.
 * Any row click selects the recording (drawer); the Play button
 * selects it and autoplays in the drawer.
 */
export function RecordingsTable({
  recordings,
  loading,
  selectedId,
  onSelect,
  page,
  total,
  onPage,
}: {
  recordings: CallRecording[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (r: CallRecording, autoplay: boolean) => void;
  page: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Lead</TableHead>
              <TableHead>Recorded</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Uploaded By</TableHead>
              <TableHead className="text-right">Play</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: PAGE_SIZE }).map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={7}>
                    <Skeleton className="h-10 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              recordings.map((r) => {
                const linked = !!r.contact_id;
                const active = r.id === selectedId;
                return (
                  <TableRow
                    key={r.id}
                    aria-selected={active}
                    onClick={() => onSelect(r, false)}
                    className={cn(
                      'cursor-pointer',
                      active && 'bg-blue-50/70 hover:bg-blue-50 dark:bg-blue-500/10 dark:hover:bg-blue-500/10'
                    )}
                  >
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
                            linked
                              ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {linked ? leadInitial(r.contact_name) : 'U'}
                        </span>
                        {linked ? (
                          <span className="truncate font-medium text-blue-600 dark:text-blue-400">
                            {r.contact_name ?? 'Unlinked'}
                          </span>
                        ) : (
                          <span className="truncate text-rose-600 dark:text-rose-400">Unlinked</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[13px]">
                      {formatRecordedIndia(r.recorded_at, r.created_at)}
                    </TableCell>
                    <TableCell>
                      <TypeBadge callType={r.call_type} />
                    </TableCell>
                    <TableCell>
                      <DirectionBadge direction={r.direction} />
                    </TableCell>
                    <TableCell className="tabular-nums">{formatDuration(r.duration_seconds)}</TableCell>
                    <TableCell className="max-w-[140px] truncate text-[13px]">
                      {r.uploader_name ?? 'Unknown'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Play recording${r.contact_name ? ` of ${r.contact_name}` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(r, true);
                        }}
                        className="h-9 w-9 rounded-full bg-muted text-foreground hover:bg-muted"
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {total === 0
            ? 'No recordings'
            : `Showing ${page * PAGE_SIZE + 1}–${Math.min(total, (page + 1) * PAGE_SIZE)} of ${total.toLocaleString('en-US')} recordings`}
        </p>
        <Pagination page={page} pageCount={pageCount} onPage={onPage} />
      </div>
    </div>
  );
}

function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  const items: Array<number | '…'> = [0];
  for (let p = page - 1; p <= page + 1; p += 1) {
    if (p > 0 && p < pageCount - 1) items.push(p);
  }
  if (pageCount > 1) items.push(pageCount - 1);
  const deduped: Array<number | '…'> = [];
  for (const it of [...new Set(items)].sort((a, b) => (a as number) - (b as number))) {
    if (
      deduped.length > 0 &&
      typeof it === 'number' &&
      typeof deduped[deduped.length - 1] === 'number' &&
      it - (deduped[deduped.length - 1] as number) > 1
    ) {
      deduped.push('…');
    }
    deduped.push(it);
  }
  return (
    <nav aria-label="Recordings pages" className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {deduped.map((it, i) =>
        it === '…' ? (
          <span key={`e${i}`} className="px-1 text-xs text-muted-foreground">
            …
          </span>
        ) : (
          <Button
            key={it}
            variant={it === page ? 'default' : 'outline'}
            size="icon"
            className={cn('h-8 w-8', it === page && 'bg-blue-600 hover:bg-blue-600')}
            onClick={() => onPage(it)}
            aria-label={`Page ${it + 1}`}
            aria-current={it === page ? 'page' : undefined}
          >
            {it + 1}
          </Button>
        )
      )}
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        disabled={page + 1 >= pageCount}
        onClick={() => onPage(page + 1)}
        aria-label="Next page"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </nav>
  );
}
