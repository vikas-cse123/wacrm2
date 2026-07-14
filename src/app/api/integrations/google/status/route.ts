// GET /api/integrations/google/status
//
// Lightweight probe for the UI: is a Google account connected, which
// email, and is the server even configured for OAuth.

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { googleOAuthConfigured } from "@/lib/google/oauth";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data } = await ctx.supabase
      .from("google_connections")
      .select("google_email, updated_at")
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    return NextResponse.json({
      configured: googleOAuthConfigured(),
      connected: !!data,
      email: data?.google_email ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
