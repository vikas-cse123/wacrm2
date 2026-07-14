// GET /api/integrations/google/connect
//
// Starts the Google OAuth flow for the caller's account (admin+). Builds
// the consent URL and 302s the browser to Google.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  buildAuthUrl,
  googleOAuthConfigured,
  redirectUriFromRequest,
} from "@/lib/google/oauth";

export async function GET(request: Request) {
  try {
    const ctx = await requireRole("admin");

    if (!googleOAuthConfigured()) {
      return NextResponse.json(
        { error: "Google integration is not configured on this server." },
        { status: 501 },
      );
    }

    const redirectUri = redirectUriFromRequest(request);
    const authUrl = buildAuthUrl(ctx.accountId, redirectUri);
    return NextResponse.redirect(authUrl);
  } catch (err) {
    return toErrorResponse(err);
  }
}
