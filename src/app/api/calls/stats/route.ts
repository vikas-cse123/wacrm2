// ============================================================
// GET /api/calls/stats — recording analytics for the Calls
// dashboard. One response carries every section the dashboard
// renders: KPIs + previous-period comparison, daily in/out
// series, direction distribution (NULL shown as Unknown),
// duration buckets, top clients, and recent recordings.
//
// The six KPI cards are exact database-side aggregates
// (migration 109, no row cap). The remaining list-derived
// sections (daily series, buckets, top clients, recent) still
// come from the bounded row fetch below — they are inherently
// top-N/per-day views, and `truncated` reports when the bound
// was hit.
//
// The model counts call_recordings rows exactly as stored —
// recordings, never claimed call-log events.
//
// Security: RLS-scoped SSR client (caller's JWT) + explicit
// account_id filter; account comes from the session, never from
// a query param. Storage bucket/path are never selected —
// playback goes through /api/recordings/[id]/audio.
//
// Query params:
//   from, to — ISO bounds, [from, to) over the EFFECTIVE time
//     (recorded_at ?? created_at). Both required. Max span
//     366 days, else 400.
//   user — optional auth user id; filters uploaded_by. Must be a
//     UUID, else 400. (Non-members simply match nothing.)
//   direction — optional "in" | "out"; anything else is 400.
//     Absent means all directions, NULLs included.
//   tz — optional IANA zone for daily bucketing; invalid falls
//     back to UTC. The from/to bounds themselves are absolute.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  aggregateRecordingMetrics,
  averageDurationSecs,
  bucketDaily,
  bucketDurations,
  latestRecordings,
  topClientsByRecordings,
  type CallsRecordingRow,
} from '@/lib/calls/aggregate';

export const dynamic = 'force-dynamic';

/** Hard row cap: bounds the scan for very large accounts. */
const MAX_ROWS = 5000;
/** Page size for the chunked reads. */
const FETCH_PAGE = 1000;
/** Max selectable window, mirroring the daily-range convention. */
const MAX_SPAN_DAYS = 366;
/** Rows shown in the dashboard's top-clients / recent sections. */
const TOP_CLIENTS_LIMIT = 5;
const RECENT_LIMIT = 5;

function parseBound(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveTimeZone(raw: string | null): string {
  if (!raw) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: raw });
    return raw;
  } catch {
    return 'UTC';
  }
}

type RecorderQuery = {
  // Minimal structural type for the supabase query builder in use.
  eq: (col: string, v: string) => RecorderQuery;
  or: (f: string) => RecorderQuery;
  range: (a: number, b: number) => Promise<{ data: unknown[] | null; error: unknown }>;
};

async function fetchWindow(
  supabase: { from: (t: string) => { select: (c: string) => RecorderQuery } },
  accountId: string,
  fromISO: string,
  toISO: string,
  user: string | null,
  direction: string | null
): Promise<{ rows: CallsRecordingRow[]; truncated: boolean }> {
  const orFilter =
    `and(recorded_at.gte.${fromISO},recorded_at.lt.${toISO}),` +
    `and(recorded_at.is.null,created_at.gte.${fromISO},created_at.lt.${toISO})`;
  const rows: CallsRecordingRow[] = [];
  let truncated = false;
  for (let offset = 0; offset < MAX_ROWS; offset += FETCH_PAGE) {
    let query = supabase
      .from('call_recordings')
      .select(
        'id, contact_id, direction, call_type, duration_seconds, recorded_at, created_at, uploaded_by, phone_number, file_name'
      )
      .eq('account_id', accountId);
    if (user) query = query.eq('uploaded_by', user);
    if (direction) query = query.eq('direction', direction);
    const { data, error } = await query.or(orFilter).range(offset, offset + FETCH_PAGE - 1);
    if (error) throw error;
    const page = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      contact_id: (r.contact_id as string | null) ?? null,
      direction: (r.direction as string | null) ?? null,
      call_type: (r.call_type as string | null) ?? null,
      duration_seconds: typeof r.duration_seconds === 'number' ? r.duration_seconds : null,
      recorded_at: (r.recorded_at as string | null) ?? null,
      created_at: r.created_at as string,
      uploaded_by: (r.uploaded_by as string | null) ?? null,
      phone_number: (r.phone_number as string | null) ?? null,
      file_name: (r.file_name as string | null) ?? null,
    }));
    rows.push(...page);
    if (page.length < FETCH_PAGE) break;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated };
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const params = new URL(request.url).searchParams;
    const from = parseBound(params.get('from'));
    const to = parseBound(params.get('to'));
    if (from === null || to === null || !(from < to)) {
      return NextResponse.json(
        { error: "'from' and 'to' must be valid ISO timestamps with 'from' before 'to'." },
        { status: 400 }
      );
    }
    if ((to - from) / 86_400_000 > MAX_SPAN_DAYS) {
      return NextResponse.json(
        { error: `Date range must be ${MAX_SPAN_DAYS} days or less.` },
        { status: 400 }
      );
    }
    const user = params.get('user')?.trim() || null;
    if (user && !UUID_RE.test(user)) {
      return NextResponse.json(
        { error: "'user' must be a valid user id." },
        { status: 400 }
      );
    }
    const directionRaw = params.get('direction')?.trim() || null;
    if (directionRaw && directionRaw !== 'in' && directionRaw !== 'out') {
      return NextResponse.json(
        { error: "'direction' must be 'in' or 'out'." },
        { status: 400 }
      );
    }
    const timeZone = resolveTimeZone(params.get('tz')?.trim() || null);

    const fromISO = new Date(from).toISOString();
    const toISO = new Date(to).toISOString();
    // Previous equal-length window, same filters — the comparison baseline.
    const span = to - from;
    const prevFromISO = new Date(from - span).toISOString();

    const client = supabase as unknown as {
      from: (t: string) => { select: (c: string) => RecorderQuery };
    };
    const [{ rows, truncated }, prev] = await Promise.all([
      fetchWindow(client, accountId, fromISO, toISO, user, directionRaw),
      fetchWindow(client, accountId, prevFromISO, fromISO, user, directionRaw),
    ]);

    // Exact KPI aggregates (migration 109): uncapped, so the cards
    // stay correct past the row bound above. Same window and
    // filters as the current-window fetch.
    const { data: kpiData, error: kpiError } = await supabase.rpc('call_kpis_summary', {
      p_account_id: accountId,
      p_from: fromISO,
      p_to: toISO,
      p_uploaded_by: user,
      p_direction: directionRaw,
    });
    if (kpiError) throw kpiError;
    const kpi = toKpis(kpiData);

    // Exact Missed / Rejected aggregates (migration 111): phone
    // call-events need no recording, so they live outside the
    // recording row set entirely. Same window and user/direction
    // filters as the cards — phone-only by table design.
    const { data: outcomesData, error: outcomesError } = await supabase.rpc(
      'call_event_outcomes_summary',
      {
        p_account_id: accountId,
        p_from: fromISO,
        p_to: toISO,
        p_user_id: user,
        p_direction: directionRaw,
      }
    );
    if (outcomesError) throw outcomesError;
    const outcomes = toOutcomes(outcomesData);

    const metrics = aggregateRecordingMetrics(rows);
    const prevMetrics = aggregateRecordingMetrics(prev.rows);
    const avg = averageDurationSecs(rows);
    const prevAvg = averageDurationSecs(prev.rows);

    // Contact display for the top-clients table and recent list: one
    // batched lookup, account-scoped, never N+1.
    const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))] as string[];
    const contactNames = new Map<string, { name: string | null; phone: string | null }>();
    if (contactIds.length > 0) {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('account_id', accountId)
        .in('id', contactIds);
      if (error) throw error;
      for (const c of (data ?? []) as Array<Record<string, unknown>>) {
        contactNames.set(c.id as string, {
          name: (c.name as string | null) ?? null,
          phone: (c.phone as string | null) ?? null,
        });
      }
    }

    const top = topClientsByRecordings(rows, TOP_CLIENTS_LIMIT).map((t) => ({
      contactId: t.contactId,
      name: contactNames.get(t.contactId)?.name ?? null,
      phone: contactNames.get(t.contactId)?.phone ?? null,
      recordings: t.recordings,
      talkTimeSecs: t.talkTimeSecs,
      lastRecordedAt: t.lastRecordedAt,
    }));
    const recent = latestRecordings(rows, RECENT_LIMIT).map((r) => ({
      ...r,
      contactName: r.contactId ? (contactNames.get(r.contactId)?.name ?? null) : null,
    }));

    return NextResponse.json({
      ...metrics,
      recordingCount: kpi.total,
      recordingDurationSecs: kpi.durationSecs,
      incomingRecordings: kpi.incoming,
      outgoingRecordings: kpi.outgoing,
      averageDurationSecs: avg,
      incomingDurationSecs: kpi.incomingDurationSecs,
      outgoingDurationSecs: kpi.outgoingDurationSecs,
      unknownDirectionRecordings: kpi.total - kpi.incoming - kpi.outgoing,
      missedRecordings: outcomes.missed,
      rejectedRecordings: outcomes.rejected,
      previous: {
        recordingCount: prevMetrics.recordingCount,
        recordingDurationSecs: prevMetrics.recordingDurationSecs,
        incomingRecordings: prevMetrics.incomingRecordings,
        outgoingRecordings: prevMetrics.outgoingRecordings,
        uniqueClients: prevMetrics.uniqueClients,
        averageDurationSecs: prevAvg,
        unlinkedRecordings: prevMetrics.unlinkedRecordings,
      },
      daily: bucketDaily(rows, { fromMs: from, toMs: to, timeZone }),
      durationBuckets: bucketDurations(rows),
      topClients: top,
      recent,
      truncated: truncated || prev.truncated,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Coerce the outcomes RPC's JSONB to card values. Counts are never
 * null; missing members fall back to zero (transport-skew guard).
 */
function toOutcomes(data: unknown): { missed: number; rejected: number } {
  if (!data || typeof data !== 'object') return { missed: 0, rejected: 0 };
  const row = data as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { missed: count(row.missed), rejected: count(row.rejected) };
}

/**
 * Coerce the KPI RPC's JSONB to card values. Counts are always
 * present (COUNT never yields NULL); duration members are NULL
 * when their side measured nothing (UI renders "—"). Non-finite
 * or missing members fall back safely — the function always
 * returns all six keys, so this only guards transport skew.
 */
function toKpis(data: unknown): {
  total: number;
  durationSecs: number | null;
  incoming: number;
  incomingDurationSecs: number | null;
  outgoing: number;
  outgoingDurationSecs: number | null;
} {
  const none = {
    total: 0,
    durationSecs: null as number | null,
    incoming: 0,
    incomingDurationSecs: null as number | null,
    outgoing: 0,
    outgoingDurationSecs: null as number | null,
  };
  if (!data || typeof data !== 'object') return none;
  const row = data as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const sum = (v: unknown) =>
    v === null || v === undefined
      ? null
      : typeof v === 'number' && Number.isFinite(v)
        ? v
        : null;
  return {
    total: count(row.total),
    durationSecs: sum(row.durationSecs),
    incoming: count(row.incoming),
    incomingDurationSecs: sum(row.incomingDurationSecs),
    outgoing: count(row.outgoing),
    outgoingDurationSecs: sum(row.outgoingDurationSecs),
  };
}
