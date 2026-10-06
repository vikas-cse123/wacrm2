'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Mic, PhoneCall } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import { formatRecordingDuration } from '@/lib/recordings/recordings';
import {
  formatCallDateTime,
  formatCallDirection,
} from '@/lib/calls/formatters';
import { LinkCallDrawer, type UnlinkedRecording } from '@/components/calls/link-call-drawer';

const PAGE_SIZE = 25;

export default function UnlinkedCallsPage() {
  const [recordings, setRecordings] = useState<UnlinkedRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [selected, setSelected] = useState<UnlinkedRecording | null>(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/calls/unlinked?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
        { cache: 'no-store' }
      );
      if (!res.ok) throw new Error('Failed to load unlinked calls');
      const body = (await res.json()) as {
        recordings?: UnlinkedRecording[];
        total?: number;
      };
      setRecordings(body.recordings ?? []);
      setTotalCount(body.total ?? 0);
    } catch {
      toast.error('Failed to load unlinked calls');
      setRecordings([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void fetchQueue();
  }, [fetchQueue]);

  const handleLinked = useCallback(
    (recordingId: string) => {
      // The row is linked now: drop it from the queue and close the
      // drawer. Counts refresh from the server on next load.
      setRecordings((prev) => prev.filter((r) => r.id !== recordingId));
      setTotalCount((prev) => Math.max(0, prev - 1));
      setSelected(null);
    },
    []
  );

  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <Link
          href="/calls"
          className="text-muted-foreground flex items-center gap-1 text-sm hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Calls
        </Link>
        <div className="mt-3 flex items-center gap-3">
          <PhoneCall className="h-6 w-6" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Unlinked Calls
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Call recordings that haven&apos;t been linked to a lead yet.
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-[300px] w-full" />
      ) : recordings.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <EmptyState
            icon={Mic}
            title="All calls are linked"
            hint="There are no unlinked call recordings right now."
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date &amp; Time</TableHead>
                  <TableHead>Caller / File</TableHead>
                  <TableHead>Phone Number</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="w-[260px]">Recording</TableHead>
                  <TableHead className="text-right">Find Lead</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recordings.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatCallDateTime(r.recorded_at ?? r.created_at)}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate font-medium">
                      {r.file_name ?? 'Untitled recording'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {r.phone_number ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatCallDirection(r.direction)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatRecordingDuration(r.duration_seconds)}
                    </TableCell>
                    <TableCell>
                      <audio
                        src={`/api/recordings/${r.id}/audio`}
                        controls
                        preload="none"
                        className="h-8 w-full max-w-[240px]"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" onClick={() => setSelected(r)}>
                        Find Lead
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {totalCount} unlinked call{totalCount === 1 ? '' : 's'} — page{' '}
              {page + 1} of {pageCount}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0 || loading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pageCount || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading unlinked calls…
        </div>
      )}

      <LinkCallDrawer
        recording={selected}
        onClose={() => setSelected(null)}
        onLinked={handleLinked}
      />
    </div>
  );
}
