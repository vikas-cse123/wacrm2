import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { getOrCreateConversation } from "@/lib/conversations/get-or-create";
import {
  isFollowupStatus,
  validateFollowupInput,
  type Followup,
} from "@/lib/followups/types";

function toFollowup(row: Record<string, unknown>): Followup {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    scheduled_for: row.scheduled_for as string,
    message_text: row.message_text as string,
    template_name: (row.template_name as string | null) ?? null,
    template_language: (row.template_language as string | null) ?? null,
    status: row.status as Followup["status"],
    attempts: (row.attempts as number) ?? 0,
    whatsapp_message_id: (row.whatsapp_message_id as string | null) ?? null,
    message_id: (row.message_id as string | null) ?? null,
    sent_at: (row.sent_at as string | null) ?? null,
    cancelled_at: (row.cancelled_at as string | null) ?? null,
    failed_at: (row.failed_at as string | null) ?? null,
    failure_reason: (row.failure_reason as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function loadContact(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
) {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, account_id, phone, name")
    .eq("id", contactId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; account_id: string; phone: string; name: string | null } | null;
}

/**
 * GET /api/followups?status=scheduled|sent|failed|cancelled —
 * account-scoped list for the Follow-up page. Any member may read.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const status = new URL(request.url).searchParams.get("status");
    let query = supabase
      .from("whatsapp_followups")
      .select("*")
      .eq("account_id", accountId);
    if (status) {
      if (!isFollowupStatus(status)) {
        return NextResponse.json({ error: "Invalid status filter." }, { status: 400 });
      }
      query = query.eq("status", status);
    }
    const ascending = !status || status === "scheduled";
    const { data, error } = await query
      .order("scheduled_for", { ascending })
      .limit(100);
    if (error) throw error;
    // Recipient context in the same round trip (no N+1): contact
    // names/phones for the listed rows only.
    const rows = (data ?? []) as Record<string, unknown>[];
    const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))] as string[];
    const contactsById: Record<string, { name: string | null; phone: string }> = {};
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, name, phone")
        .eq("account_id", accountId)
        .in("id", contactIds);
      for (const c of (contacts ?? []) as Array<{
        id: string;
        name: string | null;
        phone: string;
      }>) {
        contactsById[c.id] = { name: c.name, phone: c.phone };
      }
    }
    return NextResponse.json({
      followups: rows.map((r) => ({
        ...toFollowup(r),
        contact_name: contactsById[r.contact_id as string]?.name ?? null,
        contact_phone: contactsById[r.contact_id as string]?.phone ?? null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/followups — schedule a follow-up. Agent+.
 * Contact must belong to the caller's account (no duplicates
 * created — selection only). Conversation is linked when one
 * exists; the scheduler resolves it otherwise.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    let input;
    try {
      input = validateFollowupInput({
        contact_id: body.contact_id,
        scheduled_for: body.scheduled_for,
        message_text: body.message_text,
        template_name: body.template_name,
        template_language: body.template_language,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid input." },
        { status: 400 },
      );
    }
    const contact = await loadContact(supabase, accountId, input.contact_id);
    if (!contact) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }
    // Link the existing thread when there is one; the scheduler
    // get-or-creates otherwise (never forks duplicates).
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("id")
      .eq("account_id", accountId)
      .eq("contact_id", contact.id)
      .maybeSingle();

    const { data, error } = await supabase
      .from("whatsapp_followups")
      .insert({
        account_id: accountId,
        contact_id: contact.id,
        conversation_id:
          (existingConv as { id: string } | null)?.id ??
          (await getOrCreateConversation(supabase, accountId, contact.id, userId))?.conversation.id ??
          null,
        scheduled_for: input.scheduled_for,
        message_text: input.message_text,
        template_name: input.template_name,
        template_language: input.template_language,
        status: "scheduled",
        created_by: userId,
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json(
      { followup: toFollowup(data as Record<string, unknown>) },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
