// GET /api/integrations/google/callback
//
// Google redirects here with ?code=&state=. We verify the state binds to
// the caller's account, exchange the code for tokens, store them
// encrypted, then bounce back to the flows UI with a status flag.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import {
  accountIdFromState,
  exchangeCodeForTokens,
  redirectUriFromRequest,
  saveConnection,
} from "@/lib/google/oauth";

function backTo(request: Request, status: "connected" | "error", detail?: string) {
  const url = new URL("/flows", new URL(request.url).origin);
  url.searchParams.set("google", status);
  if (detail) url.searchParams.set("reason", detail);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  if (oauthError) return backTo(request, "error", oauthError);
  if (!code || !state) return backTo(request, "error", "missing_code");

  try {
    const ctx = await requireRole("admin");

    // The state carries the encrypted account id from `connect`. It must
    // match the signed-in admin's account, or someone is replaying a grant.
    let stateAccountId: string;
    try {
      stateAccountId = accountIdFromState(state);
    } catch {
      return backTo(request, "error", "bad_state");
    }
    if (stateAccountId !== ctx.accountId) {
      return backTo(request, "error", "account_mismatch");
    }

    const redirectUri = redirectUriFromRequest(request);
    const grant = await exchangeCodeForTokens(code, redirectUri);
    await saveConnection(ctx.supabase, ctx.accountId, grant, ctx.userId);

    return backTo(request, "connected");
  } catch (err) {
    console.error("[google-oauth] callback failed:", err);
    return backTo(request, "error", "exchange_failed");
  }
}
