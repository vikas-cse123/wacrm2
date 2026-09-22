// ============================================================
// Bounded session recovery verification (client).
//
// Called when the auth listener sees a null session on anything
// OTHER than an explicit SIGNED_OUT event (boot race, torn cookie
// read mid-rotation, cross-tab pickup). Single pass — local read
// first, one bounded server check — never a retry loop:
//
//   getSession() → user                   → { status: 'active' }
//   getSession() → null, getUser → user   → { status: 'active' }
//   both confirm no session               → { status: 'dead' }
//   infrastructure failure (timeout /
//   network / 5xx throw)                  → { status: 'unknown' }
//
// 'unknown' MUST keep existing state (no wipe, no redirect): a
// blip must not log the user out, and the next auth event
// re-evaluates. 'dead' wipes → dashboard shell redirects.
//
// No hammering: at most one network call per verification, and the
// caller serializes concurrent verifications. Never throws.
// ============================================================

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { withAuthTimeout } from "./auth-errors";

export type SessionVerification =
  | { status: "active"; user: User }
  | { status: "dead" }
  | { status: "unknown" };

export interface VerifySessionOptions {
  /** Bound for the server check. Default 4000ms. */
  getUserTimeoutMs?: number;
}

export async function verifySessionActive(
  supabase: SupabaseClient,
  opts?: VerifySessionOptions,
): Promise<SessionVerification> {
  const timeoutMs = opts?.getUserTimeoutMs ?? 4000;

  try {
    // Bounded like the server check: the whole point of this helper
    // is paths where local reads hang (lock contention), so an
    // unbounded getSession() here would defeat it.
    const {
      data: { session },
    } = await withAuthTimeout(supabase.auth.getSession(), 3000);
    if (session?.user) return { status: "active", user: session.user };
  } catch {
    // Local read failed or hung — fall through to the server check,
    // which distinguishes dead from unreachable.
  }

  try {
    const user = await withAuthTimeout(
      supabase.auth.getUser().then((r) => r.data.user ?? null),
      timeoutMs,
    );
    return user ? { status: "active", user } : { status: "dead" };
  } catch {
    return { status: "unknown" };
  }
}
