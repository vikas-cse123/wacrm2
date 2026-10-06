'use client';

import Link from 'next/link';
import {
  Clock3,
  Mic,
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  Unlink,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/dashboard/skeleton';
import { CallsChart } from '@/components/calls/dashboard/calls-chart';
import { DirectionDonut } from '@/components/calls/dashboard/direction-donut';
import { FilterBar, type MemberOption } from '@/components/calls/dashboard/filter-bar';
import { KpiCard } from '@/components/calls/dashboard/kpi-card';
import { DurationBars, TopClients } from '@/components/calls/dashboard/panels';
import { RecentList } from '@/components/calls/dashboard/recent-list';
import { percentChange } from '@/lib/calls/aggregate';
import { loadCallsStats, type CallsStatsResult } from '@/lib/calls/client';
import { formatAvgDuration, formatTalkTime } from '@/lib/calls/formatters';
import { getCallsRange, type CallsRangeKey } from '@/lib/calls/ranges';

interface MembersResponse {
  members?: Array<{
    user_id: string;
    full_name: string | null;
    email: string | null;
  }>;
}

export default function CallsPage() {
  const tz = useMemo(
    () =>
      typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : 'UTC',
    []
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [rangeKey, setRangeKey] = useState<CallsRangeKey>('last30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [userFilter, setUserFilter] = useState<string | null>(null);
  const [directionFilter, setDirectionFilter] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [stats, setStats] = useState<CallsStatsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(
    () =>
      getCallsRange(rangeKey, nowMs, tz, { fromInput: customFrom, toInput: customTo }),
    [rangeKey, nowMs, tz, customFrom, customTo]
  );

  const fetchAll = useCallback(async () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const [dashboard, membersRes] = await Promise.all([
        loadCallsStats({
          fromISO: range.fromISO,
          toISO: range.toISO,
          user: userFilter,
          direction: directionFilter,
          timeZone: tz,
          signal: controller.signal,
        }),
        fetch('/api/account/members', { cache: 'no-store', signal: controller.signal }).then(
          async (res) => {
            if (!res.ok) return null;
            return (await res.json()) as MembersResponse;
          }
        ),
      ]);
      if (controller.signal.aborted) return;
      setStats(dashboard);
      setMembers(
        (membersRes?.members ?? []).map((m) => ({
          user_id: m.user_id,
          label: m.full_name || m.email || 'Unknown user',
        }))
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setStats(null);
      setError(err instanceof Error ? err.message : 'Failed to load call analytics');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
    return () => controller.abort();
  }, [range, userFilter, directionFilter, tz]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void fetchAll().then((c) => {
      cleanup = c;
    });
    return () => cleanup?.();
  }, [fetchAll]);

  // Re-anchor "now" when the tab regains focus so Today stays current.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNowMs(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const prev = stats?.previous ?? null;
  const deltas = useMemo(() => {
    if (!stats || !prev) return null;
    return {
      count: percentChange(stats.recordingCount, prev.recordingCount),
      inbound: percentChange(stats.incomingRecordings, prev.incomingRecordings),
      outbound: percentChange(stats.outgoingRecordings, prev.outgoingRecordings),
      duration: percentChange(stats.recordingDurationSecs, prev.recordingDurationSecs),
      unique: percentChange(stats.uniqueClients, prev.uniqueClients),
      avg: percentChange(stats.averageDurationSecs, prev.averageDurationSecs),
      unlinked: percentChange(stats.unlinkedRecordings, prev.unlinkedRecordings),
    };
  }, [stats, prev]);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-600 text-white">
            <PhoneCall className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Calls</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Recorded phone calls from your devices. Analyze call activity, durations and team
              performance.
            </p>
          </div>
        </div>
        <FilterBar
          rangeKey={rangeKey}
          onRangeKey={setRangeKey}
          customFrom={customFrom}
          customTo={customTo}
          onCustom={(f, t) => {
            setCustomFrom(f);
            setCustomTo(t);
          }}
          nowMs={nowMs}
          timeZone={tz}
          members={members}
          userFilter={userFilter}
          onUserFilter={setUserFilter}
          directionFilter={directionFilter}
          onDirectionFilter={setDirectionFilter}
        />
      </div>

      {stats?.truncated && !loading ? (
        <p className="text-xs text-muted-foreground">
          Very large result set — metrics computed over the most recent 5,000 recordings in this
          range.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}{' '}
          <Button variant="outline" size="sm" className="ml-2" onClick={() => void fetchAll()}>
            Retry
          </Button>
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {loading || !stats ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] w-full rounded-xl" />)
            ) : (
              <>
                <KpiCard
                  icon={Mic}
                  label="Recorded Calls"
                  value={stats.recordingCount.toLocaleString('en-US')}
                  deltaPct={deltas?.count ?? null}
                  prevLabel={range.prevLabel}
                  iconClassName="bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400"
                />
                <KpiCard
                  icon={PhoneIncoming}
                  label="Inbound Recordings"
                  value={stats.incomingRecordings.toLocaleString('en-US')}
                  deltaPct={deltas?.inbound ?? null}
                  prevLabel={range.prevLabel}
                  iconClassName="bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
                />
                <KpiCard
                  icon={PhoneOutgoing}
                  label="Outbound Recordings"
                  value={stats.outgoingRecordings.toLocaleString('en-US')}
                  deltaPct={deltas?.outbound ?? null}
                  prevLabel={range.prevLabel}
                  iconClassName="bg-rose-50 text-rose-500 dark:bg-rose-500/10 dark:text-rose-400"
                />
                <KpiCard
                  icon={Clock3}
                  label="Total Recording Time"
                  value={formatTalkTime(stats.recordingDurationSecs)}
                  deltaPct={deltas?.duration ?? null}
                  prevLabel={range.prevLabel}
                  iconClassName="bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400"
                />
              </>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {loading || !stats ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[104px] w-full rounded-xl" />)
            ) : (
              <>
                <KpiCard
                  icon={Users}
                  label="Unique Clients"
                  value={stats.uniqueClients.toLocaleString('en-US')}
                  deltaPct={deltas?.unique ?? null}
                  prevLabel={range.prevLabel}
                  iconClassName="bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400"
                />
                <KpiCard
                  icon={Clock3}
                  label="Average Recording Duration"
                  value={formatAvgDuration(stats.averageDurationSecs)}
                  deltaPct={deltas?.avg ?? null}
                  prevLabel={range.prevLabel}
                  iconClassName="bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400"
                />
                <KpiCard
                  icon={Unlink}
                  label="Unlinked Recordings"
                  value={stats.unlinkedRecordings.toLocaleString('en-US')}
                  deltaPct={deltas?.unlinked ?? null}
                  prevLabel={range.prevLabel}
                  invertDelta
                  iconClassName="bg-rose-50 text-rose-500 dark:bg-rose-500/10 dark:text-rose-400"
                  action={
                    stats.unlinkedRecordings > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 hover:text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
                        render={<Link href="/calls/unlinked" />}
                      >
                        View Unlinked Calls →
                      </Button>
                    ) : undefined
                  }
                />
              </>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <CallsChart daily={stats?.daily ?? null} loading={loading} />
            </div>
            <DirectionDonut
              inbound={stats?.incomingRecordings ?? 0}
              outbound={stats?.outgoingRecordings ?? 0}
              unknown={stats?.unknownDirectionRecordings ?? 0}
              loading={loading}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <DurationBars buckets={stats?.durationBuckets ?? null} loading={loading} />
            <TopClients clients={stats?.topClients ?? null} loading={loading} />
            <div className="md:col-span-2 xl:col-span-1">
              <RecentList recent={stats?.recent ?? null} loading={loading} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
