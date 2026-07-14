// ============================================================
// Google OAuth — account-level connection for the Sheets sync feature.
//
// One Google account is connected per CRM account and reused across
// every flow. Tokens are stored encrypted in `google_connections`
// (AES-256-GCM, same helper the WhatsApp config uses). We talk to
// Google's REST endpoints directly (no googleapis SDK) to keep the
// serverless bundle small.
//
// Required env (set from your Google Cloud OAuth client):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
// The redirect URI is derived from the request host and must be
// whitelisted in the Cloud console as:
//   {origin}/api/integrations/google/callback
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { encrypt, decrypt } from "@/lib/whatsapp/encryption";

// Narrow scopes (paste-a-link flow — no Drive listing needed):
//   spreadsheets  — read/write the linked sheet
//   drive.file    — create new spreadsheets + access ones the app opened
//   userinfo.email — show which Google account is connected
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

// Refresh a little before the real expiry so an in-flight append never
// races the boundary.
const EXPIRY_SKEW_MS = 60_000;

export function googleOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Build the redirect URI from the incoming request's origin. */
export function redirectUriFromRequest(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  const base = explicit
    ? explicit.replace(/\/$/, "")
    : originFromHeaders(request);
  return `${base}/api/integrations/google/callback`;
}

function originFromHeaders(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return `${proto}://${host}`;
}

/**
 * The consent URL. `state` carries the encrypted account id so the
 * callback can bind the grant to the right account (and reject a
 * mismatched session).
 */
export function buildAuthUrl(accountId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force refresh_token even on re-consent
    include_granted_scopes: "true",
    state: encrypt(accountId),
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Decrypt the OAuth `state` back into an account id. Throws if tampered. */
export function accountIdFromState(state: string): string {
  return decrypt(state);
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

/** Exchange the one-time auth code for tokens + the account email. */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
  email: string | null;
}> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.refresh_token) {
    // Happens if the user previously consented and Google didn't re-issue
    // a refresh token. prompt=consent above should prevent this.
    throw new Error(
      "Google did not return a refresh token. Revoke the app's access in your Google account and reconnect.",
    );
  }

  const email = await fetchEmail(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scope: data.scope ?? GOOGLE_SCOPES,
    email,
  };
}

async function fetchEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}

/** Persist a freshly-obtained grant (encrypting both tokens). */
export async function saveConnection(
  db: SupabaseClient,
  accountId: string,
  grant: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scope: string;
    email: string | null;
  },
  connectedBy: string | null,
): Promise<void> {
  const { error } = await db.from("google_connections").upsert(
    {
      account_id: accountId,
      google_email: grant.email,
      access_token: encrypt(grant.accessToken),
      refresh_token: encrypt(grant.refreshToken),
      token_expiry: grant.expiresAt.toISOString(),
      scope: grant.scope,
      connected_by: connectedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );
  if (error) throw error;
}

/**
 * Return a valid access token for the account, refreshing (and
 * persisting the new token) when the stored one is expired/near expiry.
 * Returns null when the account has no Google connection.
 */
export async function getValidAccessToken(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data: conn } = await db
    .from("google_connections")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (!conn) return null;

  const expiry = new Date(conn.token_expiry).getTime();
  if (expiry - EXPIRY_SKEW_MS > Date.now()) {
    return decrypt(conn.access_token);
  }

  // Refresh.
  const refreshToken = decrypt(conn.refresh_token);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  const newAccess = data.access_token;
  const newExpiry = new Date(Date.now() + data.expires_in * 1000);

  await db
    .from("google_connections")
    .update({
      access_token: encrypt(newAccess),
      token_expiry: newExpiry.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId);

  return newAccess;
}
