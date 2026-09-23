import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  validateWorkspaceValue,
  type WorkspaceField,
} from "@/lib/flows/workspace-fields";

/**
 * PUT /api/flows/[id]/workspace-values — set or clear ONE custom
 * cell. Agent+ (operational data). Empty/null clears the cell
 * (deletes the value row); defaults are read-time fallbacks and
 * are never written here, so history is never rewritten.
 * Flow vars/node config are never touched — only workspace_values.
 */

async function loadField(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
  fieldId: string,
): Promise<WorkspaceField | null> {
  const { data, error } = await supabase
    .from("workspace_fields")
    .select("*")
    .eq("id", fieldId)
    .eq("account_id", accountId)
    .eq("flow_id", flowId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    flow_id: row.flow_id as string,
    name: row.name as string,
    field_type: row.field_type as WorkspaceField["field_type"],
    position: row.position as number,
    options: (row.options as string[] | null) ?? null,
    default_value: (row.default_value as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { field_id: fieldId, flow_run_id: runId, value } = body;
    if (typeof fieldId !== "string" || !fieldId) {
      return NextResponse.json({ error: "field_id is required." }, { status: 400 });
    }
    if (typeof runId !== "string" || !runId) {
      return NextResponse.json({ error: "flow_run_id is required." }, { status: 400 });
    }

    const field = await loadField(supabase, accountId, id, fieldId);
    if (!field) {
      return NextResponse.json({ error: "Column not found." }, { status: 404 });
    }
    // The run must belong to this account (and this flow — a cell
    // cannot be attached across flows).
    const { data: run, error: runErr } = await supabase
      .from("flow_runs")
      .select("id, account_id, flow_id")
      .eq("id", runId)
      .maybeSingle();
    if (runErr) throw runErr;
    const typed = run as { account_id: string; flow_id: string } | null;
    if (!typed || typed.account_id !== accountId || typed.flow_id !== id) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }

    let stored: string | null;
    try {
      stored = validateWorkspaceValue(field.field_type, field.options, value);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid value." },
        { status: 400 },
      );
    }

    if (stored === null) {
      const { error } = await supabase
        .from("workspace_values")
        .delete()
        .eq("field_id", fieldId)
        .eq("flow_run_id", runId)
        .eq("account_id", accountId);
      if (error) throw error;
      return NextResponse.json({ value: null });
    }

    const { data, error } = await supabase
      .from("workspace_values")
      .upsert(
        {
          account_id: accountId,
          field_id: fieldId,
          flow_run_id: runId,
          value_text: stored,
        },
        { onConflict: "field_id,flow_run_id" },
      )
      .select("value_text")
      .single();
    if (error) throw error;
    return NextResponse.json({
      value: (data as { value_text: string | null }).value_text,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
