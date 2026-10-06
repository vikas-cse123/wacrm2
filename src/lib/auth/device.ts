// ============================================================
// Mobile-device user authentication — resolve a Supabase user
// access token (from a logged-in app, e.g. CallVault) into an
// account context.
//
// This is the user-identity counterpart of `requireApiKey`
// (machine credentials → account). Where an API key says "some
// holder of this account's secret", a user token says "this
// specific authenticated user, and transitively their account".
//
// Calling convention — routes that accept uploads from logged-in
// devices do:
//
//   const token = bearerToken(request);
//   const dev = token && !looksLikeApiKey(token)
//     ? await requireDeviceUser(request)   // user session
//     : await requireApiKey(request, 'x'); // machine key (legacy)
//
// Why two clients: the RLS user client proves the token and
// scopes member reads; the service client performs the
// privileged writes (storage upload, catalog insert) exactly as
// the API-key path already does, with the same explicit
// account_id discipline.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { hasMinRole, isAccountRole, type AccountRole } from '@/lib/auth/roles';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { forbidden, rateLimited, unauthorized } from '@/lib/api/v1/respond';

export interface DeviceAuthContext {
  /** Discriminant — lets shared logic tell user auth from key auth. */
  authType: 'user';
  /** RLS-scoped client carrying the caller's JWT. */
  supabase: SupabaseClient;
  /** Service-role client for privileged writes (storage, catalog). */
  service: SupabaseClient;
  /** auth.uid() — the actual authenticated user. */
  userId: string;
  /** The account this user belongs to (server-derived, never client input). */
  accountId: string;
  /** The user's role within their account. */
  role: AccountRole;
  /** Display name for attribution surfaces. */
  fullName: string | null;
  /** Auth email (may be null for exotic providers). */
  email: string | null;
}

/**
 * Extract the bearer token from the `Authorization` header.
 * Returns null when absent. Unlike `requireApiKey`, no shape
 * requirement — any non-empty bearer value is a session candidate.
 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value.length > 0 ? value : null;
}

/**
 * Authenticate a device request bearing a Supabase user access
 * token and authorize recording uploads.
 *
 * Throws an `ApiError` (mapped by `toApiErrorResponse`):
 *   401 unauthorized — no token, invalid/expired session, no profile
 *   403 forbidden    — valid session but role may not upload (viewer)
 *   429 rate_limited — per-user budget exhausted
 *
 * Role rule: recording upload is operational write access, the
 * same bar as sending messages — agent and above. Viewers are
 * read-only and must never gain write access merely by logging
 * in. Owner/admin/agent all pass.
 */
export async function requireDeviceUser(
  request: Request
): Promise<DeviceAuthContext> {
  const token = bearerToken(request);
  if (!token) {
    throw unauthorized('Missing credentials');
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw unauthorized('Authentication is not configured');
  }

  // The token travels only in this server-side client, which is
  // never persisted (no session storage) and never logged.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await userClient.auth.getUser();
  const userId = !error ? data.user?.id : undefined;
  if (!userId) {
    // Invalid, expired, or revoked session — indistinguishable on
    // the wire from a missing one, so probes learn nothing.
    throw unauthorized('Invalid or expired session');
  }
  const authEmail =
    typeof data.user?.email === 'string' && data.user.email ? data.user.email : null;

  // Membership + role come from our own profiles row (service-role
  // read: the user JWT itself is proof of authentication, and RLS
  // member-reads would couple this check to policy details).
  // A user with no profile row is not a workspace member.
  const { data: profile, error: profileError } = await supabaseAdmin()
    .from('profiles')
    .select('account_id, account_role, full_name')
    .eq('user_id', userId)
    .maybeSingle();
  const accountId = !profileError
    ? (profile as { account_id?: unknown } | null)?.account_id
    : undefined;
  const role = !profileError
    ? (profile as { account_role?: unknown } | null)?.account_role
    : undefined;
  if (typeof accountId !== 'string' || !isAccountRole(role)) {
    throw unauthorized('Account membership not found');
  }

  if (!hasMinRole(role, 'agent')) {
    throw forbidden('Your WhatsApp Max account does not have permission to upload recordings.');
  }

  const limit = checkRateLimit(`device:${userId}`, RATE_LIMITS.publicApi);
  if (!limit.success) {
    throw rateLimited(limit);
  }

  const fullName = (profile as { full_name?: unknown } | null)?.full_name;
  return {
    authType: 'user',
    supabase: userClient,
    service: supabaseAdmin(),
    userId,
    accountId,
    role,
    fullName: typeof fullName === 'string' && fullName.trim() ? fullName.trim() : null,
    email: authEmail,
  };
}
