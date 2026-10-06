'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Mic } from 'lucide-react';

import { LinkCallDrawer, type UnlinkedRecording } from '@/components/calls/link-call-drawer';
import { EmptyState } from '@/components/dashboard/empty-state';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { getCallsRange } from '@/lib/calls/ranges';
import type { CallRecording } from '@/lib/recordings/recordings';
import {
  loadMemberOptions,
  loadRecordingsList,
  loadRecordingsSummary,
  recordingsQuery,
  summaryQuery,
  type MemberOption,
  type RecordingsFilters,
  type RecordingsSummary,
} from '@/lib/recordings/library';
import { RecordingDrawer } from '@/components/recordings/recording-drawer';
import { RecordingsToolbar } from '@/components/recordings/recordings-toolbar';
import { PAGE_SIZE, RecordingsTable } from '@/components/recordings/recordings-table';
import { SummaryCards } from '@/components/recordings/summary-cards';

const DEFAULT_FILTERS: RecordingsFilters = {
  q: '',
  rangeKey: 'last30',
  customFrom: '',
  customTo: '',
  callType: null,
  direction: null,
  uploadedBy: null,
  status: null,
};

function toUnlinked(r: CallRecording): UnlinkedRecording {
  return {
    id: r.id,
    file_name: r.file_name,
    phone_number: r.phone_number ?? null,
    direction: r.direction ?? null,
    duration_seconds: r.duration_seconds,
    recorded_at: r.recorded_at,
    created_at: r.created_at,
    uploader_name: r.uploader_name ?? null,
  };
}

export default function RecordingsPage() {
  const tz = useMemo(
    () =>
      typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : 'UTC',
    []
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [filters, setFilters] = useState<RecordingsFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const [recordings, setRecordings] = useState<CallRecording[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState<RecordingsSummary | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CallRecording | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [linkTarget, setLinkTarget] = useState<UnlinkedRecording | null>(null);

  const debouncedQ = useDebouncedValue(filters.q, 300);
  const range = useMemo(
    () =>
      getCallsRange(filters.rangeKey, nowMs, tz, {
        fromInput: filters.customFrom,
        toInput: filters.customTo,
      }),
    [filters.rangeKey, filters.customFrom, filters.customTo, nowMs, tz]
  );
  const effectiveFilters = useMemo(
    () => ({ ...filters, q: debouncedQ }),
    [filters, debouncedQ]
  );

  const fetchList = useCallback(async () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const body = await loadRecordingsList(
        recordingsQuery(effectiveFilters, range, PAGE_SIZE, page * PAGE_SIZE),
        controller.signal
      );
      if (controller.signal.aborted) return;
      setRecordings(body.recordings);
      setTotalCount(body.total);
      setSelected((prev) => {
        if (!prev) return prev;
        const fresh = body.recordings.find((r) => r.id === prev.id) ?? null;
        return fresh;
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setRecordings([]);
      setTotalCount(0);
      const message = err instanceof Error ? err.message : 'Failed to load recordings';
      setError(message);
      toast.error(message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
    return () => controller.abort();
  }, [effectiveFilters, range, page]);

  const fetchSummary = useCallback(async () => {
    const controller = new AbortController();
    setSummaryLoading(true);
    try {
      const s = await loadRecordingsSummary(
        summaryQuery(effectiveFilters, range),
        controller.signal
      );
      if (!controller.signal.aborted) setSummary(s);
    } catch {
      if (!controller.signal.aborted) setSummary(null);
    } finally {
      if (!controller.signal.aborted) setSummaryLoading(false);
    }
    return () => controller.abort();
  }, [effectiveFilters, range]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void fetchList().then((c) => {
      cleanup = c;
    });
    return () => cleanup?.();
  }, [fetchList]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void fetchSummary().then((c) => {
      cleanup = c;
    });
    return () => cleanup?.();
  }, [fetchSummary]);

  useEffect(() => {
    const controller = new AbortController();
    void loadMemberOptions(controller.signal).then(setMembers).catch(() => undefined);
    return () => controller.abort();
  }, []);

  // Re-anchor "now" when the tab regains focus so Today stays current.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNowMs(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Filters (and search) reset pagination to page 1.
  const updateFilters = useCallback((f: RecordingsFilters) => {
    setFilters(f);
    setPage(0);
  }, []);

  const handleSelect = useCallback((r: CallRecording, play: boolean) => {
    setSelected(r);
    setAutoplay(play);
  }, []);

  const handleLinked = useCallback(() => {
    setLinkTarget(null);
    // Refresh so the row (and the open drawer, via the list merge
    // in fetchList) shows its new lead.
    void fetchList();
    void fetchSummary();
  }, [fetchList, fetchSummary]);

  const hasActiveFilters =
    filters.q.trim() !== '' ||
    filters.callType !== null ||
    filters.direction !== null ||
    filters.uploadedBy !== null ||
    filters.status !== null ||
    filters.rangeKey !== 'last30';

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Mic className="h-6 w-6 shrink-0" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Recordings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Recorded calls from your devices, connected to your leads.
          </p>
        </div>
      </div>

      <RecordingsToolbar
        filters={filters}
        onChange={updateFilters}
        nowMs={nowMs}
        timeZone={tz}
        members={members}
      />

      <SummaryCards summary={summary} loading={summaryLoading} />

      {error && !loading ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}{' '}
          <button type="button" onClick={() => void fetchList()} className="ml-2 underline">
            Retry
          </button>
        </p>
      ) : null}

      {!loading && recordings.length === 0 && !error ? (
        <EmptyState
          icon={Mic}
          title={hasActiveFilters ? 'No recordings match these filters' : 'No recordings yet'}
          hint={
            hasActiveFilters
              ? 'Try widening the date range or clearing the search.'
              : 'Upload one with an API key that has the recordings:write scope.'
          }
        />
      ) : (
        <RecordingsTable
          recordings={recordings}
          loading={loading}
          selectedId={selected?.id ?? null}
          onSelect={handleSelect}
          page={page}
          total={totalCount}
          onPage={setPage}
        />
      )}

      <RecordingDrawer
        recording={selected}
        onClose={() => {
          setSelected(null);
          setAutoplay(false);
        }}
        onFindLead={(r) => setLinkTarget(toUnlinked(r))}
        autoplay={autoplay}
      />

      <LinkCallDrawer
        recording={linkTarget}
        onClose={() => setLinkTarget(null)}
        onLinked={handleLinked}
      />
    </div>
  );
}
