// ============================================================
// /api/inbox/pins
//
//   GET  — list the caller's pinned chats + current count + limit.
//          Serves both "get my pinned chats" and "get my pin count"
//          (the count is returned alongside the list).
//   POST — pin a chat: { conversationId }.
//
// Pins are per-user. RLS on `conversation_pins` scopes reads to the
// caller's own rows; the write goes through the `pin_conversation`
// SECURITY DEFINER RPC (migration 054), which enforces tenant
// isolation, the 30-pin cap, duplicate-prevention and concurrency
// safety on the server — the client cannot bypass any of it.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { MAX_PINNED_CHATS } from "@/lib/inbox/pins";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Map a `pin_conversation` RPC error onto the right HTTP response.
 * The RPC raises with well-known SQLSTATEs (see migration 054):
 *   42501 -> forbidden, 22023 -> bad target, P0001 -> pin limit.
 */
function pinRpcErrorToResponse(err: PostgrestError): NextResponse {
  // Custom "PIN_LIMIT_REACHED" raise. The friendly copy lives here so
  // the client can show it verbatim.
  if (err.code === "P0001" || err.message.includes("PIN_LIMIT_REACHED")) {
    return NextResponse.json(
      {
        error: "Pin limit reached",
        message:
          "You can pin up to 30 chats at a time. Unpin an existing chat before pinning another one.",
        code: "PIN_LIMIT_REACHED",
        limit: MAX_PINNED_CHATS,
      },
      { status: 409 },
    );
  }
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  // Conversation missing or not in the caller's account — treat as a
  // not-found so we don't leak whether the id exists in another tenant.
  if (err.code === "22023") {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 },
    );
  }
  console.error("[POST /api/inbox/pins] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Unable to update pinned chat. Please try again." },
    { status: 500 },
  );
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // RLS restricts this to the caller's own pins within their account,
    // so no explicit user_id filter is required — but we add it anyway
    // as defence-in-depth and to hit idx_conversation_pins_user_account.
    const { data, error } = await ctx.supabase
      .from("conversation_pins")
      .select("conversation_id, pinned_at")
      .eq("user_id", ctx.userId)
      .order("pinned_at", { ascending: false });

    if (error) {
      console.error("[GET /api/inbox/pins] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load pinned chats" },
        { status: 500 },
      );
    }

    const pins = data ?? [];
    return NextResponse.json({
      pins,
      count: pins.length,
      limit: MAX_PINNED_CHATS,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(`inbox:pin:${ctx.userId}`, RATE_LIMITS.pin);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { conversationId?: unknown }
      | null;
    const conversationId = body?.conversationId;

    if (!looksLikeUuid(conversationId)) {
      return NextResponse.json(
        { error: "'conversationId' must be a valid UUID" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase.rpc("pin_conversation", {
      p_conversation_id: conversationId,
    });

    if (error) return pinRpcErrorToResponse(error);

    // RPC returns the caller's total pin count after the operation.
    const count = typeof data === "number" ? data : Number(data ?? 0);
    return NextResponse.json({ ok: true, count, limit: MAX_PINNED_CHATS });
  } catch (err) {
    return toErrorResponse(err);
  }
}
