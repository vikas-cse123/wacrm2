// ============================================================
// /api/account/invitations
//
//   GET  — list outstanding (un-redeemed, non-expired) invites.
//   POST — retired (410): invitation-link creation is replaced by
//          owner direct user creation (POST /api/account/members).
//          Outstanding links stay redeemable via the join flow and
//          revocable via DELETE below.
//
// Both admin+. The list endpoint is what the Members tab uses to
// populate the "Pending invitations" section.
//
// IMPORTANT: the plaintext token was returned exactly ONCE — in
// the (now retired) POST response. We store only the SHA-256
// hash on the row, so neither GET nor a future PATCH can ever
// resurface the link.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await requireRole("admin");

    const { data, error } = await ctx.supabase
      .from("account_invitations")
      .select(
        "id, role, label, created_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id",
      )
      .eq("account_id", ctx.accountId)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[GET /api/account/invitations] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load invitations" },
        { status: 500 },
      );
    }

    return NextResponse.json({ invitations: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(_request: Request) {
  // Invitation-link creation is retired: owners now create users
  // directly via POST /api/account/members. Outstanding links
  // remain redeemable (peek/redeem routes untouched) and
  // revocable (DELETE below) — only minting new ones is gone.
  void _request;
  return NextResponse.json(
    { error: "Invitation links are disabled. Owners add users directly from Team Members." },
    { status: 410 }
  );
}
