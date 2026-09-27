// ============================================================
// Travel CRM integration — account owner email resolution.
//
// Server-only: resolves the calling account's OWNER email from the
// database (accounts.owner_user_id → account-scoped profiles.email),
// normalized with the shared normalizeOwnerEmail helper for Travel
// CRM identity matching.
//
// The email always comes from the authenticated account's own rows —
// never from request input, the browser, or configuration — so one
// account can never supply another account's locator (account
// isolation). Returns null when unresolvable; callers proceed
// without the locator (existing degraded behavior), never failing
// hard because of it.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeOwnerEmail } from "./lead";

/**
 * Resolve the normalized email of the account's owner.
 *
 * Reads `accounts.owner_user_id`, then that member's account-scoped
 * `profiles` row — the same pattern as the email notification
 * recipient resolution. Null on any miss or database error.
 */
export async function resolveAccountOwnerEmail(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  try {
    const { data: acct } = await db
      .from("accounts")
      .select("owner_user_id")
      .eq("id", accountId)
      .maybeSingle();
    const ownerId = (acct as { owner_user_id?: unknown } | null)?.owner_user_id;
    if (typeof ownerId !== "string" || !ownerId) return null;
    const { data: profile } = await db
      .from("profiles")
      .select("email")
      .eq("account_id", accountId)
      .eq("user_id", ownerId)
      .maybeSingle();
    return normalizeOwnerEmail((profile as { email?: unknown } | null)?.email);
  } catch {
    return null;
  }
}
