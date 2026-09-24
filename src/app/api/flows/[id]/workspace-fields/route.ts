import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  validateWorkspaceFieldDef,
  type WorkspaceField,
} from "@/lib/flows/workspace-fields";

/**
 * Workspace custom columns for one flow. Reads are account members;
 * schema writes are admin+ (same bar as tags/templates/settings).
 * The flow must belong to the caller's account — ids from the
 * browser are never trusted as authority.
 */

async function loadFlowAccount(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
) {
  const { data: flow, error } = await supabase
    .from("flows")
    .select("id, account_id")
    .eq("id", flowId)
    .maybeSingle();
  if (error) throw error;
  if (!flow || (flow as { account_id: string }).account_id !== accountId) {
    return null;
  }
  return flow;
}

function toField(row: Record<string, unknown>): WorkspaceField {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    flow_id: row.flow_id as string,
    name: row.name as string,
    field_type: row.field_type as WorkspaceField["field_type"],
    position: row.position as number,
    options: (row.options as string[] | null) ?? null,
    default_value: (row.default_value as string | null) ?? null,
    currency_code: (row.currency_code as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await getCurrentAccount();
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const { data, error } = await supabase
      .from("workspace_fields")
      .select("*")
      .eq("account_id", accountId)
      .eq("flow_id", id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({
      fields: ((data ?? []) as Record<string, unknown>[]).map(toField),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("admin");
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    let def;
    try {
      def = validateWorkspaceFieldDef({
        name: body.name,
        field_type: body.field_type,
        options: body.options,
        default_value: body.default_value,
        currency_code: body.currency_code,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid column." },
        { status: 400 },
      );
    }
    const { data: maxRow } = await supabase
      .from("workspace_fields")
      .select("position")
      .eq("account_id", accountId)
      .eq("flow_id", id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const position =
      maxRow && typeof (maxRow as { position: number }).position === "number"
        ? (maxRow as { position: number }).position + 1
        : 0;

    const { data, error } = await supabase
      .from("workspace_fields")
      .insert({
        account_id: accountId,
        flow_id: id,
        name: def.name,
        field_type: def.field_type,
        position,
        options: def.options,
        default_value: def.default_value,
        currency_code: def.currency_code,
      })
      .select()
      .single();
    if (error) {
      // Unique (account, flow, lower(name)) violation → friendly 409.
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json(
          { error: `A column named "${def.name}" already exists.` },
          { status: 409 },
        );
      }
      throw error;
    }
    return NextResponse.json(
      { field: toField(data as Record<string, unknown>) },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
