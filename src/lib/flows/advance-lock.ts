/**
 * Per-contact flow-advance mutex for inbound dispatch.
 *
 * Why this exists: two Meta webhook deliveries seconds apart carry
 * different message ids, so message-id idempotency cannot collapse them —
 * and `current_node_key` only moves at suspending/end points, so a second
 * inbound arriving mid-advance still sees the old suspended node and walks
 * the whole auto-advance chain again (double set_tag dispatches, double
 * sends, double sheets appends). Serializing dispatch per contact closes
 * that window: the loser waits, then re-reads post-winner state and acts
 * on what is actually there (duplicate tap → no active run to advance;
 * different tap → evaluated against the fresh node).
 *
 * DB-backed (not process-local): webhook invocations may run on different
 * Node processes/workers, so the mutual exclusion must live in Postgres.
 * The mechanism mirrors the codebase's existing claim patterns (the
 * automations-cron conditional UPDATE, `claim_ai_reply_slot`): the table
 * PK makes INSERT the atomic acquire; 23505 means "held".
 *
 * Contention scope is one contact — different contacts never block each
 * other. Normal (uncontended) cost is one indexed INSERT + one DELETE.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Lock older than this is treated as a crashed holder and taken over. */
export const FLOW_ADVANCE_LOCK_STALE_MS = 120_000;
/** Max time a waiter blocks before giving up (webhook awaits dispatch). */
export const FLOW_ADVANCE_LOCK_WAIT_MS = 8_000;
/** Poll interval while waiting for the holder to release. */
export const FLOW_ADVANCE_LOCK_POLL_MS = 250;

export type AdvanceLockResult<T> = { ok: true; value: T } | { ok: false };

interface LockOptions {
  waitMs?: number;
  staleMs?: number;
  pollMs?: number;
  /** Injectable clock/sleeper for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable owner id for tests (defaults to a random UUID). */
  owner?: string;
}

function isConflictError(err: unknown): boolean {
  // PostgREST surfaces unique violations as 23505 — same convention as
  // the engine's `idx_one_active_run_per_contact` handling in startNewRun.
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "23505") return true;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" &&
    (msg.includes("23505") || msg.includes("duplicate key"));
}

/**
 * True only when the lock table itself is missing (migration 064 not
 * applied). Matched narrowly — any other DB error must keep fail-closed
 * behavior so ambiguous state can never be mistaken for ownership.
 */
function isMissingTableError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "42P01") return true;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" &&
    msg.includes("flow_advance_locks") &&
    (msg.includes("does not exist") || msg.includes("42P01"));
}

/**
 * Run `fn` holding the advance lock for (accountId, contactId).
 *
 * - Uncontended: insert, run, delete in `finally` (release is
 *   owner-scoped so a holder can never delete another holder's row).
 * - Contended: poll until the holder releases or `waitMs` elapses, then
 *   return `{ ok: false }` — the caller must treat the inbound as
 *   handled-but-skipped, never as an error to retry blindly.
 * - Crashed holder (lock older than `staleMs`): delete + take over, so a
 *   dead process can neither wedge the contact nor cause overlap. The
 *   takeover delete is itself conditional (`locked_at` < cutoff) so it
 *   can never remove a freshly-acquired row.
 * - Non-conflict insert errors fail closed to `{ ok: false }` (skip
 *   rather than risk a duplicate advance on ambiguous DB state), except
 *   a missing lock table (migration 064 not applied), which runs
 *   unlocked with a loud log instead of blacking out all flows.
 */
export async function withFlowAdvanceLock<T>(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  fn: () => Promise<T>,
  opts?: LockOptions,
): Promise<AdvanceLockResult<T>> {
  const waitMs = opts?.waitMs ?? FLOW_ADVANCE_LOCK_WAIT_MS;
  const staleMs = opts?.staleMs ?? FLOW_ADVANCE_LOCK_STALE_MS;
  const pollMs = opts?.pollMs ?? FLOW_ADVANCE_LOCK_POLL_MS;
  const now = opts?.now ?? Date.now;
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const owner =
    opts?.owner ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const tryInsert = async (): Promise<boolean> => {
    const { error } = await db.from("flow_advance_locks").insert({
      account_id: accountId,
      contact_id: contactId,
      owner,
    });
    return !error;
  };

  const release = async (): Promise<void> => {
    const { error } = await db
      .from("flow_advance_locks")
      .delete()
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .eq("owner", owner);
    if (error) {
      console.error("[flows] advance lock release failed:", error.message);
    }
  };

  const runHeld = async (): Promise<AdvanceLockResult<T>> => {
    try {
      return { ok: true, value: await fn() };
    } finally {
      await release();
    }
  };

  // Fast path — no contention.
  {
    const { error } = await db.from("flow_advance_locks").insert({
      account_id: accountId,
      contact_id: contactId,
      owner,
    });
    if (!error) return runHeld();
    if (isMissingTableError(error)) {
      // Migration 064 not applied yet: the lock table does not exist, so
      // no mutual exclusion is possible. Run unlocked (exact pre-lock
      // behavior, duplicate-advance race included) rather than skipping
      // every inbound — a missing table must never black out flows.
      // Loud on purpose: this line should disappear once 064 is applied.
      console.error(
        "[flows] advance lock unavailable: migration 064 (flow_advance_locks) is not applied — running unlocked. Apply the migration, then redeploy.",
      );
      return { ok: true, value: await fn() };
    }
    if (!isConflictError(error)) {
      console.error("[flows] advance lock acquire failed:", error.message);
      return { ok: false };
    }
  }

  // Contended — wait for release, take over if stale, give up at deadline.
  // The deadline is re-checked every iteration so no interleaving of
  // takeovers can spin past it.
  const deadline = now() + waitMs;
  for (;;) {
    if (now() >= deadline) return { ok: false };
    const { data, error } = await db
      .from("flow_advance_locks")
      .select("owner, locked_at")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .maybeSingle();
    if (!error && !data) {
      if (await tryInsert()) return runHeld();
      continue;
    }
    if (!error && data) {
      const age =
        now() - new Date((data as { locked_at: string }).locked_at).getTime();
      if (Number.isFinite(age) && age > staleMs) {
        // Take over ONLY if the row is still stale: scope the delete to
        // locked_at < cutoff so a fresh row inserted concurrently (owner
        // released + new holder acquired between our read and this write)
        // is never deleted. If nothing was removed, someone else holds a
        // fresh lock — loop back and wait on it instead of assuming
        // ownership.
        const cutoff = new Date(now() - staleMs).toISOString();
        const { data: removed, error: delErr } = await db
          .from("flow_advance_locks")
          .delete()
          .eq("account_id", accountId)
          .eq("contact_id", contactId)
          .lt("locked_at", cutoff)
          .select("account_id");
        if (!delErr && Array.isArray(removed) && removed.length > 0) {
          continue;
        }
      }
    }
    await sleep(pollMs);
  }
}
