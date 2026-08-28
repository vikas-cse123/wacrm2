/**
 * Durable outbox for flow email notifications.
 *
 * Two responsibilities, split so the flow engine stays synchronous and
 * trivially non-blocking:
 *
 *   1. `enqueueFlowEmailNotification` — the ONLY thing the flow engine
 *      calls. It inserts a row into `flow_email_notifications` (one
 *      fast DB write) and returns. The engine then immediately advances
 *      to the next node. No SMTP, no provider, no await on delivery.
 *
 *   2. `drainFlowEmailNotifications` — called by the flows cron
 *      (`runFlowCron`), which already runs every minute on Vercel and
 *      inside persistent Node deployments via instrumentation.ts. It
 *      claims due rows (status flip acts as the lock, mirroring
 *      `automation_pending_executions`), performs the actual SMTP call
 *      with a bounded timeout, and applies the retry/backoff policy.
 *
 * Failure isolation: every email failure (provider down, timeout, SMTP
 * unconfigured, invalid recipient) is recorded on the job row and
 * logged here. It can never mark a flow run failed or block the next
 * node — the engine doesn't even await this module's send path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { FlowNodeRow, FlowRunRow } from "@/lib/flows/types";
import { interpolateEmail } from "./interpolate";
import { sendEmail } from "./send";
import { isValidEmail } from "./validate";
import type {
  EmailNotificationNodeConfig,
  EnqueueEmailResult,
  EmailDrainResult,
  FlowEmailNotificationRow,
} from "./types";

// ------------------------------------------------------------
// Retry / backoff policy
// ------------------------------------------------------------

/** Max attempts (including the first) before a job is terminal-failed. */
export const EMAIL_MAX_ATTEMPTS = 3;

/**
 * Exponential backoff for the *next* retry: 1m, 2m, 4m, … capped at
 * 15 minutes. Pure + exported for tests.
 */
export function nextRetryDelayMs(attempt: number): number {
  // attempt is the number of attempts STARTED; the first retry happens
  // after attempt 1 failed → 2^0 = 1 minute.
  return Math.min(60_000 * 2 ** (attempt - 1), 900_000);
}

/** Number of attempts remaining before this job becomes terminal. */
export function hasAttemptsLeft(row: { attempt: number; max_attempts: number }): boolean {
  return row.attempt < row.max_attempts;
}

// ------------------------------------------------------------
// Enqueue — called by the flow engine (synchronous, non-blocking)
// ------------------------------------------------------------

export async function enqueueFlowEmailNotification(
  db: SupabaseClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<EnqueueEmailResult> {
  const cfg = node.config as unknown as EmailNotificationNodeConfig;

  // Custom recipient is validated here (defensively — the builder
  // validator also blocks it) so an invalid address becomes a logged
  // no-op instead of a flow-affecting error.
  if (cfg.recipient_mode === "custom") {
    const email = (cfg.recipient_email ?? "").trim();
    if (!isValidEmail(email)) {
      return { ok: false, error: `invalid custom recipient "${email}"` };
    }
  }

  try {
    const { data, error } = await db
      .from("flow_email_notifications")
      .insert({
        account_id: run.account_id,
        user_id: run.user_id,
        flow_id: run.flow_id,
        flow_run_id: run.id,
        contact_id: run.contact_id,
        node_key: node.node_key,
        recipient_mode: cfg.recipient_mode === "custom" ? "custom" : "my_email",
        recipient:
          cfg.recipient_mode === "custom"
            ? (cfg.recipient_email ?? "").trim()
            : null,
        subject: cfg.subject ?? "",
        body: cfg.body ?? "",
        // Snapshot so interpolation reflects the run's state when the
        // node fired, not whenever the cron happens to send.
        vars: run.vars ?? {},
        max_attempts: EMAIL_MAX_ATTEMPTS,
      })
      .select("id")
      .single();

    if (error) {
      return { ok: false, error: error.message };
    }
    const jobId = (data as { id: string } | null)?.id;
    return jobId ? { ok: true, jobId } : { ok: false, error: "no id returned" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ------------------------------------------------------------
// Send-time resolution + rendering
// ------------------------------------------------------------

/**
 * Resolve the recipient for a job. 'custom' → the stored (validated)
 * address. 'my_email' → the account owner's profile email, falling back
 * to the flow author's email if the owner's profile has none.
 * Returns null when no address resolves.
 */
export async function resolveRecipient(
  db: SupabaseClient,
  row: FlowEmailNotificationRow,
): Promise<string | null> {
  if (row.recipient_mode === "custom") {
    const email = (row.recipient ?? "").trim();
    return isValidEmail(email) ? email : null;
  }

  const [{ data: acct }, { data: ownerProfile }] = await Promise.all([
    db
      .from("accounts")
      .select("owner_user_id")
      .eq("id", row.account_id)
      .maybeSingle(),
    db
      .from("profiles")
      .select("email")
      .eq("user_id", row.user_id)
      .maybeSingle(),
  ]);

  const ownerId = (acct as { owner_user_id?: string } | null)?.owner_user_id;
  if (ownerId && ownerId !== row.user_id) {
    const { data: owner } = await db
      .from("profiles")
      .select("email")
      .eq("user_id", ownerId)
      .maybeSingle();
    const ownerEmail = (owner as { email?: string } | null)?.email;
    if (ownerEmail && isValidEmail(ownerEmail)) return ownerEmail;
  }

  const authorEmail = (ownerProfile as { email?: string } | null)?.email;
  return authorEmail && isValidEmail(authorEmail) ? authorEmail : null;
}

/**
 * Render the final subject/body for a job by resolving contact fields
 * and the flow name from the DB, then interpolating the stored
 * templates. Missing contact/flow rows render as empty strings.
 */
export async function renderEmailContent(
  db: SupabaseClient,
  row: FlowEmailNotificationRow,
): Promise<{ subject: string; body: string }> {
  const [{ data: contact }, { data: flow }] = await Promise.all([
    row.contact_id
      ? db
          .from("contacts")
          .select("name, email, phone, company")
          .eq("id", row.contact_id)
          .maybeSingle()
      : Promise.resolve({ data: null as { name?: string | null } | null }),
    db
      .from("flows")
      .select("name")
      .eq("id", row.flow_id)
      .maybeSingle(),
  ]);

  const c = (contact as
    | { name?: string | null; email?: string | null; phone?: string | null; company?: string | null }
    | null) ?? null;
  const flowName = (flow as { name?: string } | null)?.name ?? null;

  const ctx = {
    vars: row.vars ?? {},
    contact: {
      name: c?.name ?? null,
      email: c?.email ?? null,
      phone: c?.phone ?? null,
      company: c?.company ?? null,
    },
    flowName,
  };

  return {
    subject: interpolateEmail(row.subject, ctx),
    body: interpolateEmail(row.body, ctx),
  };
}

// ------------------------------------------------------------
// Drain — called by the flows cron
// ------------------------------------------------------------

const STALE_SENDING_CUTOFF_MS = 10 * 60_000;

// Per-sweep bounds so the email drain can never monopolize the cron /
// event loop. A retry storm (provider down + many due jobs × 10s
// timeout each) could otherwise hold the sweep for minutes on end.
const EMAIL_MAX_PER_SWEEP = 20;
const EMAIL_SWEEP_TIME_BUDGET_MS = 25_000;

// Cached probe: does `flow_email_notifications.sent_message_id` exist in
// the connected database? Migration 058 adds it; deployments that apply
// the new code before the migration must NOT fail their `sent` status
// write on a missing column. Probed once (cheap REST call), cached for
// the process lifetime — the column, once present, stays present.
let sentMessageIdAvailable: boolean | null = null;

async function hasSentMessageIdColumn(db: SupabaseClient): Promise<boolean> {
  if (sentMessageIdAvailable !== null) return sentMessageIdAvailable;
  // A projection on the missing column makes PostgREST return an error;
  // `limit(0)` means no rows are actually fetched. Any error (column
  // missing, network blip) → treat as absent and omit the field.
  const { error } = await db
    .from("flow_email_notifications")
    .select("sent_message_id")
    .limit(0);
  sentMessageIdAvailable = !error;
  return sentMessageIdAvailable;
}

/**
 * Sweep due email jobs: claim → send (bounded) → sent / schedule retry.
 * Never throws for per-job failures — each job's outcome is recorded on
 * its row and logged. Callers may rely on this being safe to run from a
 * cron endpoint or an internal timer.
 */
export async function drainFlowEmailNotifications(
  db: SupabaseClient,
): Promise<EmailDrainResult> {
  const now = new Date();
  const nowIso = now.toISOString();

  // Crash recovery: a row left in 'sending' for >10min means the
  // process died mid-network-call. Reset it so the normal path retries.
  const staleCutoff = new Date(now.getTime() - STALE_SENDING_CUTOFF_MS).toISOString();
  await db
    .from("flow_email_notifications")
    .update({ status: "queued", next_attempt_at: nowIso, updated_at: nowIso })
    .eq("status", "sending")
    .lte("updated_at", staleCutoff);

  const { data: due, error } = await db
    .from("flow_email_notifications")
    .select("*")
    .in("status", ["queued", "failed"])
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(EMAIL_MAX_PER_SWEEP);

  if (error) {
    console.error("[email-cron] due-jobs scan failed:", error.message);
    return { sent: 0, failed: 0, finalFailures: 0 };
  }

  const rows = (due as FlowEmailNotificationRow[] | null) ?? [];
  const result: EmailDrainResult = { sent: 0, failed: 0, finalFailures: 0 };
  const sweepStartedAt = Date.now();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    // Stop claiming once the sweep's wall-clock budget is spent. Rows
    // left behind stay 'queued'/'failed' and are picked up on the next
    // tick — the cron runs every minute, so nothing is starved.
    if (Date.now() - sweepStartedAt > EMAIL_SWEEP_TIME_BUDGET_MS) {
      console.warn(
        `[email-cron] sweep time budget (${EMAIL_SWEEP_TIME_BUDGET_MS}ms) reached — deferring ${rows.length - i} remaining job(s) to the next tick`,
      );
      break;
    }
    const attempt = row.attempt + 1;

    // Claim — the status flip is the lock. Overlapping cron invocations
    // (external + internal timer) can both read `due`, but only one
    // wins the UPDATE; the loser sees zero rows and skips.
    const { data: claimed } = await db
      .from("flow_email_notifications")
      .update({ status: "sending", attempt, updated_at: nowIso })
      .eq("id", row.id)
      .in("status", ["queued", "failed"])
      .lte("next_attempt_at", nowIso)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      const recipient = await resolveRecipient(db, row);
      if (!recipient) {
        throw new Error("no valid recipient resolved");
      }
      const { subject, body } = await renderEmailContent(db, row);
      const { messageId, response } = await sendEmail({ to: recipient, subject, text: body });

      const patch: Record<string, unknown> = {
        status: "sent",
        sent_at: nowIso,
        last_error: null,
        next_attempt_at: null,
        updated_at: nowIso,
      };
      if (await hasSentMessageIdColumn(db)) {
        patch.sent_message_id = messageId ?? null;
      }

      await db
        .from("flow_email_notifications")
        .update(patch)
        .eq("id", row.id);
      result.sent += 1;
      console.log(
        `[email-cron] sent job ${row.id} → ${recipient} (flow ${row.flow_id}, contact ${row.contact_id ?? "?"}) messageId=${messageId ?? "n/a"}${response ? ` response="${response}"` : ""}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (hasAttemptsLeft({ attempt, max_attempts: row.max_attempts })) {
        const delayMs = nextRetryDelayMs(attempt);
        await db
          .from("flow_email_notifications")
          .update({
            status: "failed",
            last_error: message,
            attempt,
            next_attempt_at: new Date(now.getTime() + delayMs).toISOString(),
            updated_at: nowIso,
          })
          .eq("id", row.id);
        result.failed += 1;
        console.error(
          `[email-cron] job ${row.id} failed (attempt ${attempt}/${row.max_attempts}): ${message} — retrying in ${Math.round(delayMs / 1000)}s. Flow execution unaffected.`,
        );
      } else {
        await db
          .from("flow_email_notifications")
          .update({
            status: "failed",
            last_error: message,
            attempt,
            failed_at: nowIso,
            next_attempt_at: null,
            updated_at: nowIso,
          })
          .eq("id", row.id);
        result.failed += 1;
        result.finalFailures += 1;
        console.error(
          `[email-cron] job ${row.id} FAILED permanently after ${attempt} attempts: ${message}. Recipient ${row.recipient ?? "my_email"}, flow ${row.flow_id}, run ${row.flow_run_id}. Flow execution unaffected.`,
        );
      }
    }
  }

  return result;
}