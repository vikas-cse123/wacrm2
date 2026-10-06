'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatRecordingDuration } from '@/lib/recordings/recordings';

export interface UnlinkedRecording {
  id: string;
  file_name: string | null;
  phone_number: string | null;
  direction: string | null;
  duration_seconds: number | null;
  recorded_at: string | null;
  created_at: string;
  uploader_name: string | null;
}

interface LeadHit {
  id: string;
  name: string | null;
  phone: string | null;
  phone_normalized: string | null;
}

function formatDirection(direction: string | null): string {
  if (direction === 'in') return 'Incoming';
  if (direction === 'out') return 'Outgoing';
  return 'Unknown';
}

function formatRecordedAt(value: string | null, fallback: string): string {
  const date = new Date(value ?? fallback);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

/**
 * Find-Lead drawer: manual linking of one unlinked recording.
 * Suggests confidently (exact phone badge) but never auto-links —
 * every association is an explicit user click on POST .../link.
 */
export function LinkCallDrawer({
  recording,
  onClose,
  onLinked,
}: {
  recording: UnlinkedRecording | null;
  onClose: () => void;
  onLinked: (recordingId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [leads, setLeads] = useState<LeadHit[] | null>(null);
  const [exactMatchId, setExactMatchId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  useEffect(() => {
    setQuery('');
    setDebounced('');
    setLeads(null);
    setExactMatchId(null);
    setLinkingId(null);
  }, [recording?.id]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!recording || debounced.length < 2) {
      setLeads(debounced.length === 0 ? null : []);
      setExactMatchId(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    fetch(`/api/contacts/search?q=${encodeURIComponent(debounced)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        setLeads((body?.leads ?? []) as LeadHit[]);
        setExactMatchId((body?.exactMatchId ?? null) as string | null);
      })
      .catch(() => {
        if (!cancelled) {
          setLeads([]);
          setExactMatchId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, recording]);

  const link = useCallback(
    async (contactId: string) => {
      if (!recording || linkingId) return;
      setLinkingId(contactId);
      try {
        const res = await fetch(`/api/calls/unlinked/${recording.id}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact_id: contactId }),
        });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 409) {
          toast.error('This call has already been linked to a lead.');
          onLinked(recording.id);
          return;
        }
        if (!res.ok) throw new Error(body?.error ?? 'Failed to link call');
        toast.success('Call linked successfully.');
        onLinked(recording.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to link call');
      } finally {
        setLinkingId(null);
      }
    },
    [recording, linkingId, onLinked]
  );

  return (
    <Sheet open={recording !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        {recording && (
          <>
            <SheetHeader>
              <SheetTitle>Link Call to Lead</SheetTitle>
              <SheetDescription>
                {recording.file_name ?? 'Untitled recording'} ·{' '}
                {formatRecordedAt(recording.recorded_at, recording.created_at)}
              </SheetDescription>
            </SheetHeader>
            <div className="mt-4 space-y-4 overflow-y-auto px-5 pb-6">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Phone</dt>
                  <dd className="text-foreground font-medium tabular-nums">
                    {recording.phone_number ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Direction</dt>
                  <dd className="text-foreground">{formatDirection(recording.direction)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Duration</dt>
                  <dd className="text-foreground tabular-nums">
                    {formatRecordingDuration(recording.duration_seconds)}
                  </dd>
                </div>
              </dl>
              <audio
                src={`/api/recordings/${recording.id}/audio`}
                controls
                preload="none"
                className="h-8 w-full"
              />
              <div>
                <h3 className="text-foreground text-sm font-semibold">Search leads</h3>
                <div className="relative mt-2">
                  <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name or phone number..."
                    className="pl-9"
                    aria-label="Search leads"
                  />
                </div>
              </div>
              {searching ? (
                <div className="flex items-center gap-2 py-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-muted-foreground text-sm">Searching…</span>
                </div>
              ) : leads === null ? (
                <p className="text-muted-foreground text-sm">
                  Type at least 2 characters to search your leads.
                </p>
              ) : leads.length === 0 ? (
                <p className="text-muted-foreground text-sm">No leads found</p>
              ) : (
                <ul className="space-y-2">
                  {leads.map((lead) => (
                    <li
                      key={lead.id}
                      className="flex items-center gap-3 rounded-lg border border-border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground truncate text-sm font-medium">
                          {lead.name ?? 'Unnamed lead'}
                        </p>
                        <p className="text-muted-foreground truncate text-xs tabular-nums">
                          {lead.phone ?? '—'}
                        </p>
                        {lead.id === exactMatchId && (
                          <Badge variant="outline" className="mt-1">
                            Exact phone match
                          </Badge>
                        )}
                      </div>
                      <Button
                        size="sm"
                        disabled={linkingId !== null}
                        onClick={() => void link(lead.id)}
                      >
                        {linkingId === lead.id ? 'Linking…' : 'Link Call'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="outline" className="w-full" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
