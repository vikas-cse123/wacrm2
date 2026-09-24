import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { canManageReminder } from "@/lib/followups/ownership";

/**
 * POST /api/followups/[id]/retry — Agent+, creator-owned (admin
 * override). Re-arms a failed reminder for immediate send
 * (scheduled_for = now). Only failed rows; sent rows are never
 * re-sent from here. The scheduler's atomic claim still guards
 * the actual send against duplicates. The recipient snapshot is
 * untouched — the retry goes to the same agent number.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const { data: existing } = await supabase
      .from("whatsapp_followups")
      .select("id, created_by")
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ error: "Reminder not found." }, { status: 404 });
    }
    // Ownership: only the creator (or an admin) may retry.
    if (!canManageReminder(role, existing as Record<string, unknown>, userId)) {
      return NextResponse.json(
        { error: "Only the reminder creator or an admin can retry it." },
        { status: 403 },
      );
    }
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
        { error: "Only failed reminders can be retried." },
        { status: 400 },
      );
    }
    return NextResponse.json({ followup: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
