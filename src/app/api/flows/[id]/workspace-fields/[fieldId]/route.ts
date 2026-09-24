import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  validateWorkspaceFieldDef,
  type WorkspaceField,
} from "@/lib/flows/workspace-fields";

/**
 * Edit / delete ONE custom column. Admin+ only. Type changes are
 * rejected (stored values would orphan); renames re-validate
 * uniqueness per flow. Deletes cascade to the column's values via
 * the FK — flow-generated fields can never reach this route.
 */

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

async function loadField(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
  fieldId: string,
) {
  const { data, error } = await supabase
    .from("workspace_fields")
    .select("*")
    .eq("id", fieldId)
    .eq("account_id", accountId)
    .eq("flow_id", flowId)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; fieldId: string }> },
) {
  try {
    const { id, fieldId } = await params;
    const { supabase, accountId } = await requireRole("admin");
    const existing = await loadField(supabase, accountId, id, fieldId);
    if (!existing) {
      return NextResponse.json({ error: "Column not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (
      body.field_type !== undefined &&
      body.field_type !== existing.field_type
    ) {
      return NextResponse.json(
        { error: "Column type cannot be changed. Delete and recreate it instead." },
        { status: 400 },
      );
    }
    let def;
    try {
      def = validateWorkspaceFieldDef({
        name: body.name ?? existing.name,
        field_type: existing.field_type,
        options: body.options ?? existing.options,
        default_value:
          body.default_value ?? existing.default_value ?? undefined,
        currency_code:
          body.currency_code ?? existing.currency_code ?? undefined,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid column." },
        { status: 400 },
      );
    }
    // Changing the default never rewrites history — only future
    // reads fall back to it. Existing value rows are untouched.
    // Changing the currency only re-labels display formatting;
    // stored numerics are never converted.
    const { data, error } = await supabase
      .from("workspace_fields")
      .update({
        name: def.name,
        options: def.options,
        default_value: def.default_value,
        currency_code: def.currency_code,
      })
      .eq("id", fieldId)
      .eq("account_id", accountId)
      .eq("flow_id", id)
      .select()
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json(
          { error: `A column named "${def.name}" already exists.` },
          { status: 409 },
        );
      }
      throw error;
    }
    return NextResponse.json({ field: toField(data as Record<string, unknown>) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; fieldId: string }> },
) {
  try {
    const { id, fieldId } = await params;
    const { supabase, accountId } = await requireRole("admin");
    const existing = await loadField(supabase, accountId, id, fieldId);
    if (!existing) {
      return NextResponse.json({ error: "Column not found." }, { status: 404 });
    }
    const { error } = await supabase
      .from("workspace_values")
      .delete()
      .eq("field_id", fieldId)
      .eq("account_id", accountId);
    if (error) throw error;
    const { error: fieldErr } = await supabase
      .from("workspace_fields")
      .delete()
      .eq("id", fieldId)
      .eq("account_id", accountId)
      .eq("flow_id", id);
    if (fieldErr) throw fieldErr;
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
