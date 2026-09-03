// ============================================================
// Atomic get-or-create for conversations.
//
// Intended invariant (DB-enforced by migration 062):
//   ONE conversation per (account_id, contact_id), regardless of
//   status. A closed thread is REUSED on next inbound — no path
//   forks a fresh thread after close.
//
// Concurrency protocol (same pattern the contact path already
// uses via isUniqueViolation):
//   1. Fast-path SELECT (oldest-first, LIMIT 1 so legacy duplicate
//      rows pre-backfill resolve deterministically instead of
//      erroring).
//   2. INSERT.
//   3. On 23505 unique violation, a concurrent writer won —
//      re-SELECT and return the winner.
// Only a genuine DB failure returns null.
//
// Account isolation: every statement filters on account_id, and
// the unique index includes account_id, so two accounts never
// share or steal each other's thread.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';

// Minimal structural type so both the typed SupabaseClient and the
// webhook's untyped service-role client (`any`) are accepted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | any;

export interface ConversationResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversation: any;
  created: boolean;
}

async function selectExisting(
  db: Db,
  accountId: string,
  contactId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const { data, error } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * Return the contact's conversation in this account, creating one if
 * none exists. Safe under concurrent webhook/API/send callers: at
 * most one INSERT wins, losers re-read the winner via the
 * (account_id, contact_id) unique index (migration 062).
 *
 * `auditUserId` fills the NOT NULL `user_id` audit column on insert
 * only — never updated on the fast path, so assignment/status are
 * preserved. Returns null only on genuine DB failure.
 */
export async function getOrCreateConversation(
  db: Db,
  accountId: string,
  contactId: string,
  auditUserId: string,
): Promise<ConversationResult | null> {
  const existing = await selectExisting(db, accountId, contactId);
  if (existing) return { conversation: existing, created: false };

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      contact_id: contactId,
    })
    .select()
    .single();

  if (!createError && created) {
    return { conversation: created, created: true };
  }

  // Lost a race: a concurrent writer inserted between our SELECT and
  // INSERT and the unique index rejected us. Re-read the winner
  // instead of forking a duplicate or dropping the message.
  if (isUniqueViolation(createError)) {
    const raced = await selectExisting(db, accountId, contactId);
    if (raced) return { conversation: raced, created: false };
  }

  console.error('[conversations] get-or-create failed:', createError);
  return null;
}
