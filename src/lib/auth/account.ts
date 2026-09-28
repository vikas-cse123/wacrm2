// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createBufferedServerClient } from "@/lib/supabase/server";
import {
  classifyAuthFailure,
  isConfirmedUnauthenticated,
  withAuthTimeout,
  type AuthFailureKind,
} from "./auth-errors";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

/**
 * Bound on the Supabase auth round-trip in API routes. A slow/unreachable
 * auth server must not hang the request past the reverse proxy's timeout,
 * and a timeout is a TEMPORARY failure (503), never an auth rejection.
 */
const API_AUTH_LOOKUP_TIMEOUT_MS = 10_000;

// ------------------------------------------------------------
// Shared auth-check resolution
//
// One buffered server client per check. @supabase/ssr writes clearing
// cookies when a refresh fails with the access token already expired;
// a transient failure (rotation race, timeout, network, 5xx, 429) must
// NOT persist those clears — the caller commits them only for a real
// user or a confirmed absence, and discards them on a transient failure
// so a blip can't wipe the browser's valid session cookie.
// ------------------------------------------------------------

interface ResolvedAuthCheck {
  supabase: SupabaseClient;
  commit: () => void;
  discard: () => void;
  user: { id: string } | null;
  kind: AuthFailureKind;
}

async function resolveAuthCheck(): Promise<ResolvedAuthCheck> {
  const { client: supabase, commit, discard } = await createBufferedServerClient();

  let user: { id: string } | null = null;
  let userErr: unknown = null;
  try {
    const result = await withAuthTimeout(
      supabase.auth.getUser(),
      API_AUTH_LOOKUP_TIMEOUT_MS,
    );
    user = result.data.user ?? null;
    userErr = result.error ?? null;
  } catch (err) {
    userErr = err;
  }

  return { supabase, commit, discard, user, kind: classifyAuthFailure(userErr) };
}

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Temporary auth-infrastructure failure (timeout, network blip, 5xx,
 * rate limit, refresh-rotation race). The session may still be valid —
 * the auth backend just couldn't confirm it right now. Returns 503 so
 * the client treats it as a transient server error, NEVER as a logout.
 */
export class TemporaryAuthError extends Error {
  readonly status = 503 as const;
  constructor(message = "Authentication service temporarily unavailable") {
    super(message);
    this.name = "TemporaryAuthError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (
    err instanceof UnauthorizedError ||
    err instanceof ForbiddenError ||
    err instanceof TemporaryAuthError
  ) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session or the token
 * was deterministically rejected.
 * Throws `TemporaryAuthError` (503) if the auth backend was unreachable,
 * slow (bounded timeout), rate-limited, returned 5xx, or a refresh-token
 * rotation race occurred — the caller's session may still be valid, so
 * this must never be surfaced as a logout.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const { supabase, commit, discard, user, kind } = await resolveAuthCheck();

  if (!user) {
    // A resolved `AuthSessionMissingError` (or a clean null) means there is
    // no session at all — definitively unauthenticated. Everything else is
    // classified: a deterministic rejection (401/403) is dead → 401;
    // transient failures (timeout, network, 5xx, rate limit, rotation
    // race, unknown) must stay a temporary 503 so the caller is never
    // treated as logged out because the auth backend was briefly down.
    if (isConfirmedUnauthenticated(kind)) {
      // Genuinely dead session — persist the SDK's cleanup cookie clears.
      commit();
      throw new UnauthorizedError();
    }
    // Transient — never persist the SDK's clearing cookies.
    discard();
    throw new TemporaryAuthError();
  }

  // The session is valid. Persist any rotated session cookies the
  // refresh produced before we touch the database.
  commit();

  const { data, error } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[getCurrentAccount] profile fetch error:", error);
    throw new ForbiddenError("Could not load account context");
  }
  if (!data || !data.account_id || !data.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (!isAccountRole(data.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${data.account_role}`);
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  const { data: account, error: accountErr } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("id", data.account_id)
    .maybeSingle();

  if (accountErr) {
    console.error("[getCurrentAccount] account fetch error:", accountErr);
    throw new ForbiddenError("Could not load account context");
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError("Profile is not linked to an account");
  }

  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    account: { id: account.id, name: account.name },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}

/**
 * Guard-style authenticated-user check for API routes that only need
 * `userId` + an RLS-scoped client (no profile/account resolution).
 *
 * Replaces the common `getUser() → if (!user) 401` pattern that treated
 * a transient auth failure (resolved `{ user: null, error }` from a lost
 * refresh-token rotation race, timeout, network, 5xx, 429) as a confirmed
 * logout. Returns a guard so callers keep their existing `if (!guard.ok)`
 * shape:
 *
 *   ok:true  → userId + a buffered client whose rotated cookies were
 *              already committed; use it for the route's queries.
 *   ok:false  → 401 (confirmed unauthenticated) or 503 (transient), with
 *              the buffered cookie clears discarded on the transient path.
 */
export async function requireAuthenticatedUser(): Promise<
  | { ok: true; userId: string; supabase: SupabaseClient }
  | { ok: false; status: 401 | 503; body: { error: string } }
> {
  const { supabase, commit, discard, user, kind } = await resolveAuthCheck();

  if (user) {
    commit();
    return { ok: true, userId: user.id, supabase };
  }

  if (isConfirmedUnauthenticated(kind)) {
    commit();
    return { ok: false, status: 401, body: { error: "Unauthorized" } };
  }

  discard();
  return {
    ok: false,
    status: 503,
    body: { error: "Authentication service temporarily unavailable" },
  };
}
