// ============================================================
// Server-side contact matching for call recordings (Phase 2B).
//
// A device says "this recording belongs to phone number X";
// WACRM decides, WITHIN the API key's account, whether X belongs
// to exactly one contact. The account/contact database stays
// authoritative — CallVault never learns contact IDs.
//
// Rules (deliberately conservative):
// - exact equality on digits-only forms, never fuzzy/suffix.
// - exactly 1 candidate → link; 0 or 2+ → NULL (unlinked).
//   A wrong lead association is worse than an unlinked recording.
// - matching NEVER fails the upload: lookup errors degrade to
//   NULL, and only safe diagnostics (none/ambiguous/unique) are
//   logged — never phone numbers.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizePhone } from '@/lib/whatsapp/phone-utils';

export type ContactMatchOutcome =
  | { kind: 'unique'; contactId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous' };

/**
 * Resolve `phoneNumber` to a contact id inside `accountId`.
 * Normalizes with the EXISTING `normalizePhone()` (digits-only —
 * the same shape as the `contacts.phone_normalized` generated
 * column), then reads at most 2 candidates. Pure exact match;
 * no alternate formats, no guessing.
 */
export async function matchContactByPhone(
  supabase: SupabaseClient,
  accountId: string,
  phoneNumber: string
): Promise<ContactMatchOutcome> {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return { kind: 'none' };
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('phone_normalized', normalized)
      .limit(2);
    if (error || !data) return { kind: 'none' };
    const rows = data as Array<{ id: string }>;
    if (rows.length === 1) return { kind: 'unique', contactId: rows[0].id };
    if (rows.length === 0) return { kind: 'none' };
    return { kind: 'ambiguous' };
  } catch {
    // A lookup problem must never prevent the upload itself.
    return { kind: 'none' };
  }
}
