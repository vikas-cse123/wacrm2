import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

/**
 * POST /api/followups/[id]/retry — Agent+. Re-arms a failed
 * follow-up for immediate send (scheduled_for = now). Only failed
 * rows; sent rows are never re-sent from here. The scheduler's
 * atomic claim still guards the actual send against duplicates.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("agent");
    const { data, error } = await supabase
      .from("whatsapp_followups")
      .update({
        status: "scheduled",
        scheduled_for: new Date().toISOString(),
        failure_reason: null,
        failed_at: null,
      })
      .eq("id", id)
      .eq("account_id", accountId)
      .eq("status", "failed")
      .select()
      .single();
    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { error: "Only failed follow-ups can be retried." },
        { status: 400 },
      );
    }
    return NextResponse.json({ followup: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
