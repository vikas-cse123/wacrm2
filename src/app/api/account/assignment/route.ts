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
      .from("chat_assignment_config")
      .select("*")
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    if (error) throw error;
    return NextResponse.json({ config: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const VALID_MODES = ["round_robin", "equal_load", null];

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json();
    const { default_mode, online_only, reassign_offline } = body;

    if (!VALID_MODES.includes(default_mode)) {
      return NextResponse.json(
        { error: "Invalid mode" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase
      .from("chat_assignment_config")
      .upsert(
        {
          account_id: ctx.accountId,
          default_mode: default_mode ?? null,
          online_only: online_only ?? true,
          reassign_offline: reassign_offline ?? false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      )
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ config: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
