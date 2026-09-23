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
//   getUser resolves user:null +          → { status: 'unknown' }
//     rotation-race error (invalid_grant /
//     refresh_token_not_found)
//   getUser → 401/403 once, still         → { status: 'unknown' }
//     failing on ONE retry (torn cookie?)
//   getUser → 401/403 twice, or no        → { status: 'dead' }
//     session at all (session-missing /
//     anonymous)
//   infrastructure failure (timeout /
//   network / 5xx throw)                  → { status: 'unknown' }
//
// 'unknown' MUST keep existing state (no wipe, no redirect): a
// blip must not log the user out, and the next auth event
// re-evaluates. 'dead' wipes → dashboard shell redirects.
//
// Why the resolved error matters: supabase-js RESOLVES (never
// throws) getUser() with { user: null, error } when the refresh
// token was already consumed by a sibling tab (rotation race).
// Mapping every resolved-null to 'dead' converts that transient
// race into a confirmed logout — the multi-tab auto-logout.
// The error is classified with the shared auth-errors rules
// instead of being discarded.
//
// No hammering: at most two network calls per verification
// (second only on a single 401/403), and the caller serializes
// concurrent verifications. Never throws.
// ============================================================

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { classifyAuthFailure, withAuthTimeout } from "./auth-errors";

export type SessionVerification =
  | { status: "active"; user: User }
  | { status: "dead" }
  | { status: "unknown" };

export interface VerifySessionOptions {
  /** Bound for the server check. Default 4000ms. */
  getUserTimeoutMs?: number;
}

/**
 * True when the error means "there is locally nothing to verify
 * with" — no session in storage and no JWT. Distinct from a
 * rotation-race rejection: this is a confirmed absence, safe to
 * treat as signed out. Matched by name (not instanceof) so unit
 * tests and alternative client builds don't need the class.
 */
function isSessionMissingError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>).name === "AuthSessionMissingError"
  );
}

async function checkServerUser(
  supabase: SupabaseClient,
  timeoutMs: number,
): Promise<{ user: User | null; kind: ReturnType<typeof classifyAuthFailure> }> {
  const result = await withAuthTimeout(supabase.auth.getUser(), timeoutMs);
  const user = result.data.user ?? null;
  if (user) return { user, kind: "anonymous" };
  // getUser() RESOLVES (does not throw) with user:null plus an
  // error object on refresh failures — classify it instead of
  // treating every null as death.
  const kind = isSessionMissingError(result.error)
    ? ("anonymous" as const)
    : classifyAuthFailure(result.error ?? null);
  return { user: null, kind };
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
    const first = await checkServerUser(supabase, timeoutMs);
    if (first.user) return { status: "active", user: first.user };
    if (first.kind === "anonymous") return { status: "dead" };
    if (first.kind === "invalid_refresh") return { status: "unknown" };
    if (first.kind !== "rejected") return { status: "unknown" };
    // Single retry on a deterministic 401/403: a torn cookie write
    // mid-rotation can fail once and succeed a moment later, while a
    // genuinely dead token fails twice. Bounded and rare.
    const second = await checkServerUser(supabase, timeoutMs);
    if (second.user) return { status: "active", user: second.user };
    if (second.kind === "anonymous") return { status: "dead" };
    return second.kind === "rejected" ? { status: "dead" } : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Confirm a SIGNED_OUT event before acting on it. The auth client
 * emits SIGNED_OUT not only for explicit sign-outs but also when a
 * failed background refresh removes the local session (e.g. this
 * tab lost a refresh-token rotation race while a sibling tab holds
 * fresh tokens). Returns true only when the session is proven
 * dead; any live-or-unknown outcome means "do not wipe".
 */
export async function confirmSignedOut(
  supabase: SupabaseClient,
  opts?: VerifySessionOptions,
): Promise<boolean> {
  const verification = await verifySessionActive(supabase, opts);
  return verification.status === "dead";
}
