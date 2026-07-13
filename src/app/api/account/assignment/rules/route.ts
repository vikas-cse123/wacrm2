import { NextResponse } from "next/server";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("chat_assignment_rules")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("position", { ascending: true });

    if (error) throw error;
    return NextResponse.json({ rules: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const VALID_CONDITIONS = ["is", "contains", "starts_with"];

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json();
    const { name, trait_field, condition, trait_values, agent_ids } = body;

    if (!name || !trait_field || !VALID_CONDITIONS.includes(condition)) {
      return NextResponse.json(
        { error: "Missing or invalid fields" },
        { status: 400 },
      );
    }

    const { count } = await ctx.supabase
      .from("chat_assignment_rules")
      .select("id", { count: "exact", head: true })
      .eq("account_id", ctx.accountId);

    const { data, error } = await ctx.supabase
      .from("chat_assignment_rules")
      .insert({
        account_id: ctx.accountId,
        name,
        trait_field,
        condition,
        trait_values: trait_values ?? [],
        agent_ids: agent_ids ?? [],
        position: (count ?? 0) + 1,
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ rule: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: "Missing rule id" }, { status: 400 });
    }

    const allowed = [
      "name",
      "trait_field",
      "condition",
      "trait_values",
      "agent_ids",
      "position",
      "is_active",
    ];
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (key in updates) patch[key] = updates[key];
    }

    const { data, error } = await ctx.supabase
      .from("chat_assignment_rules")
      .update(patch)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ rule: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Missing rule id" }, { status: 400 });
    }

    const { error } = await ctx.supabase
      .from("chat_assignment_rules")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
