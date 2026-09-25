import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SendMessageError,
  sendReminderToAgent,
} from '@/lib/followups/reminder-send';

// ============================================================
// Reminder scheduler: claim due rows and deliver each reminder TO
// ITS CREATOR's stored WhatsApp number (`recipient_phone`,
// snapshotted at creation) FROM the account's connected WhatsApp
// Business number. Mirrors the automations-cron claim pattern
// (status flip = lock, affected-row check = ownership).
//
// A reminder is personal, not a customer message, so this path
// deliberately avoids everything customer-related:
//   - no contact / conversation lookup or creation,
//   - no customer `messages` row, no preview mutation,
//   - no flow-run pausing, no contact phone auto-correct,
//   - no 24-hour customer-service window, no template fallback.
// The destination is ALWAYS the row's `recipient_phone` snapshot;
// nothing may override it (not latest messages, assignment, or
// profile state — a later profile-number change does not alter
// already-created reminders).
//
// Idempotency: a row is only processed after an atomic
// scheduled→processing flip affecting exactly that row; already-sent
// rows are never re-sent; stale 'processing' rows (crashed worker)
// are reclaimed while attempts < MAX_ATTEMPTS, then failed.
// ============================================================

export const FOLLOWUP_BATCH_LIMIT = 25;
export const FOLLOWUP_MAX_ATTEMPTS = 3;
/** Crashed-worker reclaim horizon (updated_at older than this). */
export const FOLLOWUP_STALE_MS = 10 * 60 * 1000;

interface FollowupRow {
  id: string;
  account_id: string;
  recipient_phone: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  scheduled_for: string;
  message_text: string;
  template_name: string | null;
  template_language: string | null;
  status: string;
  attempts: number;
  created_by: string | null;
}

function toFollowup(row: Record<string, unknown>): FollowupRow {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    recipient_phone: (row.recipient_phone as string | null) ?? null,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    scheduled_for: row.scheduled_for as string,
    message_text: row.message_text as string,
    template_name: (row.template_name as string | null) ?? null,
    template_language: (row.template_language as string | null) ?? null,
    status: row.status as string,
    attempts: (row.attempts as number) ?? 0,
    created_by: (row.created_by as string | null) ?? null,
  };
}

export interface DrainResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

async function markFollowup(
  db: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from('whatsapp_followups').update(patch).eq('id', id);
  if (error) {
    console.error('[followups] status update failed:', error.message);
  }
}

async function processOne(
  db: SupabaseClient,
  row: FollowupRow,
): Promise<'sent' | 'failed' | 'skipped'> {
  // Re-read under the claim: skip anything no longer scheduled
  // (cancelled concurrently) or already finished.
  const { data: fresh, error: freshErr } = await db
    .from('whatsapp_followups')
    .select('*')
    .eq('id', row.id)
    .maybeSingle();
  if (freshErr || !fresh) return 'skipped';
  const current = toFollowup(fresh as Record<string, unknown>);
  if (current.status === 'cancelled' || current.status === 'sent') {
    return 'skipped';
  }
  // The recipient is the immutable creation-time snapshot of the
  // creator's own WhatsApp number. Legacy rows without one fail
  // loudly — the scheduler must never guess (no customer phone,
  // no profile re-read, no conversation inference).
  if (!current.recipient_phone) {
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason:
        'Reminder has no recipient phone number. Re-create it after adding your WhatsApp number in Settings → Your profile.',
    });
    return 'failed';
  }

  // Audit attribution uses the reminder creator. No conversation is
  // opened: a self-reminder is delivered directly, never threaded
  // into a customer conversation.
  if (!row.created_by) {
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: 'Reminder has no creator for audit attribution.',
    });
    return 'failed';
  }

  try {
    const result = await sendReminderToAgent(db, current.account_id, {
      to: current.recipient_phone,
      text: current.message_text,
    });
    await markFollowup(db, row.id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      whatsapp_message_id: result.whatsappMessageId,
      failure_reason: null,
    });
    // Delivery diagnostics only (never tokens, never full numbers):
    // one line per accepted send so a future non-delivery is
    // traceable from logs alone — Meta acceptance, addressing, and
    // the wamid that later status webhooks correlate on.
    console.log('[followups] reminder sent', {
      reminder_id: row.id,
      to: maskPhoneForLog(current.recipient_phone),
      phone_number_id: result.phoneNumberId,
      whatsapp_message_id: result.whatsappMessageId,
      ...(result.recipientWaId ? { recipient_wa_id: result.recipientWaId } : {}),
    });
    return 'sent';
  } catch (err) {
    const reason =
      err instanceof SendMessageError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Send failed.';
    console.error('[followups] reminder send failed', {
      reminder_id: row.id,
      to: maskPhoneForLog(current.recipient_phone),
      reason,
    });
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: reason,
    });
    return 'failed';
  }
}

/**
 * Mask a phone number for logs: first two + last two digits only
 * (`9174******19`). Secrets and full numbers must never hit logs.
 */
function maskPhoneForLog(phone: string | null): string {
  if (!phone) return '(none)';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${digits.slice(0, 2)}******${digits.slice(-2)}`;
}

/**
 * Drain due follow-ups. Safe under overlapping workers: each row is
 * claimed atomically and re-checked after the claim. Never throws —
 * per-row failures are counted, and unexpected errors resolve to
 * zeroed counts so cron responses stay stable.
 */
export async function drainDueFollowups(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<DrainResult> {
  const outcome: DrainResult = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  try {
    const staleCutoff = new Date(now.getTime() - FOLLOWUP_STALE_MS).toISOString();
    const { data: due, error } = await db
      .from('whatsapp_followups')
      .select('*')
      .or(
        `and(status.eq.scheduled,scheduled_for.lte.${now.toISOString()}),and(status.eq.processing,updated_at.lt.${staleCutoff})`,
      )
      .order('scheduled_for', { ascending: true })
      .limit(FOLLOWUP_BATCH_LIMIT);
    if (error) {
      console.error('[followups] due query failed:', error.message);
      return outcome;
    }
    for (const raw of (due ?? []) as Record<string, unknown>[]) {
      const row = toFollowup(raw);
      if (row.attempts >= FOLLOWUP_MAX_ATTEMPTS) {
        await markFollowup(db, row.id, {
          status: 'failed',
          failed_at: new Date().toISOString(),
          failure_reason: 'Gave up after repeated attempts.',
        });
        outcome.processed += 1;
        outcome.failed += 1;
        continue;
      }
      // Atomic claim: exactly one worker flips the row. The
      // predicate repeats the due filter so a row claimed moments
      // ago by a live worker (fresh 'processing') can never be
      // re-claimed — only scheduled rows and provably stale
      // processing rows flip.
      const { data: claimed, error: claimErr } = await db
        .from('whatsapp_followups')
        .update({
          status: 'processing',
          attempts: row.attempts + 1,
        })
        .eq('id', row.id)
        .or(
          `and(status.eq.scheduled),and(status.eq.processing,updated_at.lt.${staleCutoff})`,
        )
        .select()
        .maybeSingle();
      if (claimErr || !claimed) continue;
      outcome.processed += 1;
      try {
        const result = await processOne(db, toFollowup(claimed as Record<string, unknown>));
        outcome[result] += 1;
      } catch (err) {
        console.error('[followups] row processing failed:', err);
        await markFollowup(db, row.id, {
          status: 'failed',
          failed_at: new Date().toISOString(),
          failure_reason: 'Unexpected processing error.',
        });
        outcome.failed += 1;
      }
    }
    return outcome;
  } catch (err) {
    console.error('[followups] drain failed:', err);
    return outcome;
  }
}
