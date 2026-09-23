import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
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
 * PATCH /api/followups/[id] — Agent+.
 * - { action: "cancel" }: scheduled → cancelled (never sent after).
 * - { message_text?, scheduled_for?, template_name?, template_language? }:
 *   edit a scheduled (or failed) follow-up. Sent rows are immutable.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("agent");
    const row = await loadFollowup(supabase, accountId, id);
    if (!row) {
      return NextResponse.json({ error: "Follow-up not found." }, { status: 404 });
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
        return bad("Only scheduled follow-ups can be cancelled.");
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
      return bad("Only scheduled or failed follow-ups can be edited.");
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
