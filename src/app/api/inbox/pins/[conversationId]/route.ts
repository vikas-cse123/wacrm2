// ============================================================
// DELETE /api/inbox/pins/[conversationId]
//
// Unpins a chat for the calling user. Idempotent — unpinning a chat
// that isn't pinned is a success (the end state is the same). Only
// ever removes the caller's own pin row via the `unpin_conversation`
// SECURITY DEFINER RPC (migration 054), so there's no way to affect
// another user's or another tenant's pins.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { MAX_PINNED_CHATS } from "@/lib/inbox/pins";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unpinRpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  console.error("[DELETE /api/inbox/pins/:id] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Unable to update pinned chat. Please try again." },
    { status: 500 },
  );
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(`inbox:pin:${ctx.userId}`, RATE_LIMITS.pin);
    if (!limit.success) return rateLimitResponse(limit);

    const { conversationId } = await params;
    if (!UUID_RE.test(conversationId)) {
      return NextResponse.json(
        { error: "'conversationId' must be a valid UUID" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase.rpc("unpin_conversation", {
      p_conversation_id: conversationId,
    });

    if (error) return unpinRpcErrorToResponse(error);

    const count = typeof data === "number" ? data : Number(data ?? 0);
    return NextResponse.json({ ok: true, count, limit: MAX_PINNED_CHATS });
  } catch (err) {
    return toErrorResponse(err);
  }
}
