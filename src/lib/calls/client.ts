// ============================================================
// Calls stats fetch client — one GET per dashboard filter state
// (range + user + direction). Mirrors the dashboard
// analytics-client conventions (no-store, throws on non-ok,
// AbortSignal passthrough).
// ============================================================

import type {
  DayBucket,
  DurationBuckets,
  RecordingMetrics,
} from './aggregate';

export interface TopClientRow {
  contactId: string;
  name: string | null;
  phone: string | null;
  recordings: number;
  talkTimeSecs: number;
  lastRecordedAt: string | null;
}

export interface RecentRecordingRow {
  id: string;
  contactId: string | null;
  contactName: string | null;
  phoneNumber: string | null;
  direction: string | null;
  callType: string | null;
  durationSecs: number | null;
  recordedAt: string | null;
  createdAt: string;
  fileName: string | null;
}

export interface PreviousPeriod {
  recordingCount: number;
  recordingDurationSecs: number | null;
  incomingRecordings: number;
  outgoingRecordings: number;
  uniqueClients: number;
  averageDurationSecs: number | null;
  unlinkedRecordings: number;
}

export interface CallsDashboard extends RecordingMetrics {
  averageDurationSecs: number | null;
  unknownDirectionRecordings: number;
  previous: PreviousPeriod;
  daily: DayBucket[];
  durationBuckets: DurationBuckets;
  topClients: TopClientRow[];
  recent: RecentRecordingRow[];
  truncated: boolean;
}

export interface CallsStatsParams {
  fromISO: string;
  toISO: string;
  /** auth user id (uploaded_by) or null for everyone. */
  user?: string | null;
  /** 'in' | 'out' or null for all directions (NULLs included). */
  direction?: string | null;
  /** IANA zone for daily bucketing. */
  timeZone?: string;
  signal?: AbortSignal;
}

export type CallsStatsResult = CallsDashboard;

export async function loadCallsStats(params: CallsStatsParams): Promise<CallsStatsResult> {
  const qs = new URLSearchParams({
    from: params.fromISO,
    to: params.toISO,
  });
  if (params.user) qs.set('user', params.user);
  if (params.direction) qs.set('direction', params.direction);
  if (params.timeZone) qs.set('tz', params.timeZone);
  const res = await fetch(`/api/calls/stats?${qs.toString()}`, {
    cache: 'no-store',
    signal: params.signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Failed to load call analytics');
  }
  const json = (await res.json()) as CallsStatsResult;
  if (
    !json ||
    typeof json !== 'object' ||
    typeof json.recordingCount !== 'number' ||
    !Array.isArray(json.daily)
  ) {
    throw new Error('Bad call analytics response shape');
  }
  return json;
}
