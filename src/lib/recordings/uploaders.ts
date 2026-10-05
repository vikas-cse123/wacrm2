// ============================================================
// Uploader display-name join for call recordings.
//
// `call_recordings.uploaded_by` is an auth.users id (the API key
// minter). Display needs `profiles.full_name` (else email) —
// resolved here in ONE batched query per caller, never N+1.
// Only the display name crosses to the frontend; no other
// profile columns are selected.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveUploaderName } from './recordings';

/**
 * Map `uploaded_by` user id → display name for the given ids.
 * Unknown/removed users resolve via `resolveUploaderName(null)`
 * at the call site (`'Unknown'`); ids with no profile simply
 * have no entry. Never throws (returns {} on failure — the UI
 * falls back to 'Unknown' rather than breaking the list).
 */
export async function uploaderNamesByUserId(
  supabase: SupabaseClient,
  userIds: string[]
): Promise<Record<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return {};
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, full_name, email')
      .in('user_id', unique);
    if (error || !data) return {};
    const out: Record<string, string> = {};
    for (const p of data as Array<{
      user_id: string;
      full_name: string | null;
      email: string | null;
    }>) {
      out[p.user_id] = resolveUploaderName(p);
    }
    return out;
  } catch {
    return {};
  }
}
