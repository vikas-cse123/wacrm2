// ============================================================
// Calls dashboard formatters — display-only helpers for the
// /calls overview. Durations come from call_recordings.duration_seconds
// (nullable; NULL durations are excluded from sums/averages at
// the aggregation layer, never coerced to zero here).
// ============================================================

/**
 * Compact talk-time for KPI cards: "2h 18m", "56m 32s", "0:47".
 * Sub-minute values reuse the m:ss recording convention.
 */
export function formatTalkTime(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return '—';
  }
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `0:${String(s).padStart(2, '0')}`;
}

/** Average-call display: same scale as talk time ("1m 07s"). */
export function formatAvgDuration(avgSeconds: number | null | undefined): string {
  if (avgSeconds === null || avgSeconds === undefined || !Number.isFinite(avgSeconds)) {
    return '—';
  }
  return formatTalkTime(Math.round(avgSeconds));
}

/**
 * KPI-card duration: "16s", "2m 18s", "1h 24m" — sub-minute values
 * read as seconds rather than the m:ss recording convention.
 */
export function formatShortDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return '—';
  }
  const total = Math.max(0, Math.floor(totalSeconds));
  if (total < 60) return `${total}s`;
  return formatTalkTime(total);
}

/** "8,298 seconds" subtitle style. */
export function formatSecondsLong(totalSeconds: number): string {
  return `${Math.max(0, Math.floor(totalSeconds)).toLocaleString('en-US')} seconds`;
}

/** Direction label for the calls API/UI. NULL (or anything unexpected) → Unknown. */
export function formatCallDirection(direction: string | null | undefined): string {
  if (direction === 'in') return 'Incoming';
  if (direction === 'out') return 'Outgoing';
  return 'Unknown';
}

/** Short "Oct 5, 11:48 PM" style timestamp. Invalid → em dash. */
export function formatCallDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
