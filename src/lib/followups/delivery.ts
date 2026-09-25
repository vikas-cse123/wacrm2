import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// Reminder delivery reconciliation: mirror Meta status webhooks
// onto `whatsapp_followups` via the reminder's own
// `whatsapp_message_id` correlation key.
//
// Reminders have no `messages` row by design (a self-reminder
// must never open a customer conversation), so the webhook's
// messages/broadcast mirrors can never reach them — without this
// step a row would sit on `sent` forever even after Meta
// reported failure. Semantics mirror the broadcast ladder:
//
//   sent      → keep Sent (acceptance was already recorded at
//               send time with sent_at).
//   delivered → fill delivered_at (once; never overwrite).
//   read      → fill read_at (and delivered_at when still empty,
//               since reading implies delivery).
//   failed    → flip to Failed with failed_at + Meta error detail.
//
// Only rows currently `sent` are touched: scheduled/processing
// rows haven't been accepted yet, cancelled rows must stay
// cancelled, and failed rows are terminal. Unknown statuses are
// ignored. No `messages` row is required (or created).
// ============================================================

export type ReminderDeliveryStatus = "sent" | "delivered" | "read" | "failed";

export function isReminderDeliveryStatus(
  value: unknown,
): value is ReminderDeliveryStatus {
  return (
    value === "sent" ||
    value === "delivered" ||
    value === "read" ||
    value === "failed"
  );
}

export interface MetaStatusError {
  code?: number;
  title?: string;
  message?: string;
  href?: string;
}

/** Human-readable Meta failure detail, capped for the row. */
export function formatReminderFailure(
  errors: ReadonlyArray<MetaStatusError> | null | undefined,
): string {
  const parts: string[] = [];
  for (const err of errors ?? []) {
    const bits = [
      err.code !== undefined ? `code ${err.code}` : "",
      err.title || err.message || "",
    ].filter(Boolean);
    if (bits.length > 0) parts.push(`Meta error ${bits.join(": ")}`);
  }
  const joined = parts.join("; ");
  const detail = joined || "Meta reported delivery failure.";
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
}

export interface ReconcileReminderDeliveryParams {
  /** Meta status value. */
  status: string;
  /** Meta event timestamp (seconds since epoch, per webhook shape). */
  timestamp: string;
  /** Meta error payload for `failed` (statuses[].errors). */
  errors?: ReadonlyArray<MetaStatusError> | null;
}

export interface ReconcileReminderDeliveryResult {
  /** A reminder row carries this wamid. */
  matched: boolean;
  /** The row was actually updated. */
  updated: boolean;
}

interface ReminderDeliveryRow {
  id: string;
  status: string;
  delivered_at: string | null;
  read_at: string | null;
}

/**
 * Apply one Meta status event to its reminder row. Never throws —
 * webhook processing must not break on a reconciliation failure.
 */
export async function reconcileReminderDelivery(
  db: SupabaseClient,
  wamid: string,
  params: ReconcileReminderDeliveryParams,
): Promise<ReconcileReminderDeliveryResult> {
  const none = { matched: false, updated: false };
  if (!wamid || !isReminderDeliveryStatus(params.status)) return none;

  let tsIso: string;
  try {
    const ms = parseInt(params.timestamp, 10) * 1000;
    if (!Number.isFinite(ms)) return none;
    tsIso = new Date(ms).toISOString();
  } catch {
    return none;
  }

  let row: ReminderDeliveryRow | null = null;
  try {
    const { data, error } = await db
      .from("whatsapp_followups")
      .select("id, status, delivered_at, read_at")
      .eq("whatsapp_message_id", wamid)
      .maybeSingle();
    if (error || !data) return none;
    row = data as ReminderDeliveryRow;
  } catch (err) {
    console.error("[followups] delivery lookup failed:", err);
    return none;
  }

  // Only in-flight (sent, accepted-but-unreconciled) rows move.
  if (!row || row.status !== "sent") return { matched: true, updated: false };
  if (params.status === "sent") return { matched: true, updated: false };

  const patch: Record<string, unknown> = {};
  if (params.status === "delivered") {
    if (!row.delivered_at) patch.delivered_at = tsIso;
  } else if (params.status === "read") {
    if (!row.delivered_at) patch.delivered_at = tsIso;
    if (!row.read_at) patch.read_at = tsIso;
  } else if (params.status === "failed") {
    patch.status = "failed";
    patch.failed_at = tsIso;
    patch.failure_reason = formatReminderFailure(params.errors);
  }
  if (Object.keys(patch).length === 0) return { matched: true, updated: false };

  try {
    const { error } = await db
      .from("whatsapp_followups")
      .update(patch)
      .eq("id", row.id);
    if (error) {
      console.error("[followups] delivery update failed:", error.message);
      return { matched: true, updated: false };
    }
    return { matched: true, updated: true };
  } catch (err) {
    console.error("[followups] delivery update failed:", err);
    return { matched: true, updated: false };
  }
}
