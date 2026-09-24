import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { canManageReminder } from "@/lib/followups/ownership";
import { validateFollowupInput } from "@/lib/followups/types";

async function loadFollowup(
  supabase: SupabaseClient,
  accountId: string,
  id: string,
) {
  const { data, error } = await supabase
    .from("whatsapp_followups")
    .select("*")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * PATCH /api/followups/[id] — Agent+, creator-owned (admin override).
 * - { action: "cancel" }: scheduled → cancelled (never sent after).
 * - { message_text?, scheduled_for?, template_name?, template_language? }:
 *   edit a scheduled (or failed) reminder. Sent rows are immutable.
 *   The recipient snapshot is never editable; the customer context
 *   is preserved as-is.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const row = await loadFollowup(supabase, accountId, id);
    if (!row) {
      return NextResponse.json({ error: "Reminder not found." }, { status: 404 });
    }
    // Ownership: only the creator (or an admin) may edit or cancel.
    if (!canManageReminder(role, row, userId)) {
      return NextResponse.json(
        { error: "Only the reminder creator or an admin can change it." },
        { status: 403 },
      );
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return bad("Invalid JSON body.");
    }

    if (body.action === "cancel") {
      if (row.status !== "scheduled" && row.status !== "processing") {
        return bad("Only scheduled reminders can be cancelled.");
      }
      const { error } = await supabase
        .from("whatsapp_followups")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("id", id)
        .eq("account_id", accountId)
        .in("status", ["scheduled", "processing"]);
      if (error) throw error;
      return NextResponse.json({ cancelled: true });
    }

    if (row.status !== "scheduled" && row.status !== "failed") {
      return bad("Only scheduled or failed reminders can be edited.");
    }
    let input;
    try {
      input = validateFollowupInput({
        contact_id: row.contact_id,
        scheduled_for: body.scheduled_for ?? row.scheduled_for,
        message_text: body.message_text ?? row.message_text,
        template_name:
          body.template_name !== undefined ? body.template_name : row.template_name,
        template_language:
          body.template_language !== undefined
            ? body.template_language
            : row.template_language,
      });
    } catch (err) {
      return bad(err instanceof Error ? err.message : "Invalid input.");
    }
    // Editing re-arms the row: failed edits reschedule cleanly.
    const { data, error } = await supabase
      .from("whatsapp_followups")
      .update({
        scheduled_for: input.scheduled_for,
        message_text: input.message_text,
        template_name: input.template_name,
        template_language: input.template_language,
        status: "scheduled",
        failure_reason: null,
        failed_at: null,
      })
      .eq("id", id)
      .eq("account_id", accountId)
      .in("status", ["scheduled", "failed"])
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ followup: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
