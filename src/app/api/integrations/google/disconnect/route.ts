// POST /api/integrations/google/disconnect
//
// Removes the account's Google connection (admin+). Per-flow sheet links
// are left intact but will stop syncing until a Google account is
// reconnected.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function POST() {
  try {
    const ctx = await requireRole("admin");
    const { error } = await ctx.supabase
      .from("google_connections")
      .delete()
      .eq("account_id", ctx.accountId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
