'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
} from 'lucide-react';
import type { CallRecording } from '@/lib/recordings/recordings';

const PAGE_SIZE = 25;

function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || totalSeconds === undefined) return '—';
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRecordedAt(value: string | null, fallback: string): string {
  const date = new Date(value ?? fallback);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<CallRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const fetchRecordings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/recordings?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
      );
      if (!res.ok) throw new Error('Failed to load recordings');
      const body = (await res.json()) as {
        recordings?: CallRecording[];
        total?: number;
      };
      setRecordings(body.recordings ?? []);
      setTotalCount(body.total ?? 0);
    } catch {
      toast.error('Failed to load recordings');
      setRecordings([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void fetchRecordings();
  }, [fetchRecordings]);

  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <Mic className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-semibold">Call Recordings</h1>
          <p className="text-sm text-muted-foreground">
            Phone call recordings uploaded from your devices. Press play to
            listen — audio streams on demand and is never loaded upfront.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : recordings.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <Mic className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-4 font-medium">No recordings yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload one with an API key that has the{' '}
            <code className="rounded bg-muted px-1">recordings:write</code>{' '}
            scope:
            <code className="mt-2 block rounded bg-muted p-2 text-xs">
              curl -X POST /api/v1/recordings -H &apos;Authorization: Bearer
              wacrm_live_…&apos; -F audio=@call.ogg -F duration_seconds=187
            </code>
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recording</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="w-[280px]">Play</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recordings.map((recording) => (
                  <TableRow key={recording.id}>
                    <TableCell className="max-w-[240px] truncate font-medium">
                      {recording.file_name ?? 'Untitled recording'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatRecordedAt(recording.recorded_at, recording.created_at)}
                    </TableCell>
                    <TableCell>{formatDuration(recording.duration_seconds)}</TableCell>
                    <TableCell>{formatSize(recording.file_size)}</TableCell>
                    <TableCell>
                      {/* preload="none": nothing is fetched until the
                          user presses play — the list stays light with
                          thousands of recordings. */}
                      <audio
                        src={`/api/recordings/${recording.id}/audio`}
                        controls
                        preload="none"
                        className="w-full max-w-[260px]"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {totalCount} recording{totalCount === 1 ? '' : 's'} — page{' '}
              {page + 1} of {pageCount}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
