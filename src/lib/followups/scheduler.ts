import type { SupabaseClient } from '@supabase/supabase-js';

import { getOrCreateConversation } from '@/lib/conversations/get-or-create';
import {
  SendMessageError,
  sendMessageToConversation,
} from '@/lib/whatsapp/send-message';

// ============================================================
// Follow-up scheduler: claim due rows, enforce Meta's messaging
// policy at SEND time, send through the existing send core, and
// persist results. Mirrors the automations-cron claim pattern
// (status flip = lock, affected-row check = ownership).
//
// Send-time policy (Meta customer-service window):
//   - customer message within 24h → free-form text send.
//   - window closed + approved template set → template send.
//   - window closed + no template → failed with an actionable
//     reason (edit to add a template, or wait for inbound).
// The decision is re-evaluated at every send attempt, because the
// window may have opened or closed since scheduling.
//
// Idempotency: a row is only processed after an atomic
// scheduled→processing flip affecting exactly that row; already-sent
// rows are never re-sent; stale 'processing' rows (crashed worker)
// are reclaimed while attempts < MAX_ATTEMPTS, then failed.
// Webhook delivered/read/failed updates land on the SAME messages
// row via the stored wamid (existing webhook correlation).
// ============================================================

export const FOLLOWUP_BATCH_LIMIT = 25;
export const FOLLOWUP_MAX_ATTEMPTS = 3;
/** Crashed-worker reclaim horizon (updated_at older than this). */
export const FOLLOWUP_STALE_MS = 10 * 60 * 1000;
/** Meta 24-hour customer service window. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface FollowupRow {
  id: string;
  account_id: string;
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

/**
 * True when the conversation had inbound customer activity within
 * the Meta 24h customer-service window (evaluated at send time).
 */
export async function isServiceWindowOpen(
  db: SupabaseClient,
  conversationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return false;
  const at = Date.parse((data as { created_at: string }).created_at);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at <= SERVICE_WINDOW_MS;
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
  if (!current.contact_id) {
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: 'Contact no longer exists.',
    });
    return 'failed';
  }

  // Resolve (or create) the thread — never fork duplicates.
  // Audit attribution uses the follow-up creator.
  if (!row.created_by) {
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: 'Follow-up has no creator for audit attribution.',
    });
    return 'failed';
  }
  const convResult = await getOrCreateConversation(
    db,
    current.account_id,
    current.contact_id,
    row.created_by,
  );
  if (!convResult) {
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: 'Could not open a conversation for this contact.',
    });
    return 'failed';
  }
  const conversationId = convResult.conversation.id as string;
  if (conversationId !== current.conversation_id) {
    await markFollowup(db, row.id, { conversation_id: conversationId });
  }

  // Send-time Meta policy decision.
  const inWindow = await isServiceWindowOpen(db, conversationId);
  const useTemplate = !inWindow;
  if (useTemplate && !current.template_name) {
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason:
        'Outside the 24-hour messaging window and no approved template is set. Edit the follow-up to add one, or retry after the customer messages.',
    });
    return 'failed';
  }

  try {
    const result = await sendMessageToConversation(db, current.account_id, {
      conversationId,
      messageType: useTemplate ? 'template' : 'text',
      contentText: useTemplate ? undefined : current.message_text,
      templateName: useTemplate ? current.template_name ?? undefined : undefined,
      templateLanguage: useTemplate ? current.template_language ?? 'en_US' : undefined,
    });
    await markFollowup(db, row.id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      whatsapp_message_id: result.whatsappMessageId,
      message_id: result.messageId,
      failure_reason: null,
    });
    return 'sent';
  } catch (err) {
    const reason =
      err instanceof SendMessageError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Send failed.';
    // A DB-persist failure AFTER a Meta accept is the one case a
    // blind retry could double-send — say so explicitly.
    const suffix =
      err instanceof SendMessageError && err.code === 'db_error'
        ? ' The message may already have been sent — check the inbox before retrying.'
        : '';
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: `${reason}${suffix}`,
    });
    return 'failed';
  }
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
