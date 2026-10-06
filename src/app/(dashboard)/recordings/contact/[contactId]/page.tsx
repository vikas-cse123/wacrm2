'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
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
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
} from 'lucide-react';
import type { CallRecording } from '@/lib/recordings/recordings';
import { formatRecordingDuration } from '@/lib/recordings/recordings';

const PAGE_SIZE = 25;

function formatRecordedAt(value: string | null, fallback: string): string {
  const date = new Date(value ?? fallback);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatDirection(direction: string | null | undefined): string {
  if (direction === 'in') return 'Incoming';
  if (direction === 'out') return 'Outgoing';
  return '—';
}

interface ContactHeader {
  id: string;
  name: string | null;
  phone: string | null;
}

export default function ContactRecordingsPage() {
  const params = useParams<{ contactId: string }>();
  const contactId = params.contactId;
  const [recordings, setRecordings] = useState<CallRecording[]>([]);
  const [contact, setContact] = useState<ContactHeader | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const fetchRecordings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/recordings?contact_id=${encodeURIComponent(contactId)}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
      );
      if (res.status === 404) {
        setNotFound(true);
        setRecordings([]);
        return;
      }
      if (!res.ok) throw new Error('Failed to load recordings');
      const body = (await res.json()) as {
        recordings?: CallRecording[];
        total?: number;
        contact?: ContactHeader | null;
      };
      setRecordings(body.recordings ?? []);
      setTotalCount(body.total ?? 0);
      setContact(body.contact ?? null);
    } catch {
      toast.error('Failed to load recordings');
      setRecordings([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [contactId, page]);

  useEffect(() => {
    void fetchRecordings();
  }, [fetchRecordings]);

  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  if (notFound) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <p className="text-muted-foreground text-sm">Contact not found.</p>
        <Link href="/recordings" className="text-sm text-primary">
          ← All recordings
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <Link
          href="/recordings"
          className="text-muted-foreground flex items-center gap-1 text-sm hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          All recordings
        </Link>
        <div className="mt-3 flex items-center gap-3">
          <Mic className="h-6 w-6" />
          <div>
            <h1 className="text-2xl font-semibold">Call Recordings</h1>
            <p className="text-sm text-muted-foreground">
              Lead: {contact?.name ?? '…'}
              {contact?.phone ? ` · ${contact.phone}` : ''}
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : recordings.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <Mic className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-4 font-medium">No recordings for this lead yet.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            New uploads linked to this contact will appear here automatically.
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
                  <TableHead>Direction</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Uploaded by</TableHead>
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
                    <TableCell>
                      {formatRecordingDuration(recording.duration_seconds)}
                    </TableCell>
                    <TableCell>
                      {formatDirection(recording.direction ?? null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {recording.phone_number ?? '—'}
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate">
                      {recording.uploader_name ?? 'Unknown'}
                    </TableCell>
                    <TableCell>
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
