// ============================================================
// Outgoing message status ordering — single source of truth.
//
// Strict progression for `messages.status`:
//
//   sending < sent < delivered < read
//
// Meta can redeliver webhooks and deliver them out of order; a
// late/duplicate `delivered` (or `sent`) arriving after `read`
// must NEVER flip a Seen bubble back to Unseen. Both the webhook
// mirror (server) and the realtime merge (client) gate status
// writes through isForwardMessageStatus, so regressions are
// impossible on either path while legitimate forward moves
// (including repeats of the same value) still apply.
//
// `failed` is terminal truth, not a ladder rung: it always
// applies (except when already failed — a no-op), because a
// genuine Meta failure must surface even if ordering metadata is
// odd. `sending` exists only on optimistic client rows, never in
// status events.
// ============================================================

export const MESSAGE_STATUS_ORDER: readonly string[] = [
  "sending",
  "sent",
  "delivered",
  "read",
];

/**
 * True when a status write may proceed: strictly forward along
 * the ladder, a repeat of the current value, a terminal `failed`,
 * or an unknown current value (fail open — never strand a row).
 * Unknown incoming values never apply.
 */
export function isForwardMessageStatus(
  current: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  if (incoming === "failed") return current !== "failed";
  if (current === "failed") return false;
  if (typeof incoming !== "string" || incoming === "") return false;
  const ti = MESSAGE_STATUS_ORDER.indexOf(incoming);
  if (ti < 0) return false;
  if (typeof current !== "string" || current === "") return true;
  const fi = MESSAGE_STATUS_ORDER.indexOf(current);
  if (fi < 0) return true;
  return ti >= fi;
}
