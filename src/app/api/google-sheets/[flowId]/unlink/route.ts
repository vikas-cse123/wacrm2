import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  context: { params: Promise<{ flowId: string }> },
) {
  try {
    const { flowId } = await context.params;
    const ctx = await getCurrentAccount();

    // Verify ownership
    const { data: flow } = await ctx.supabase
      .from("flows")
      .select("id")
      .eq("id", flowId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    if (!flow) {
      return NextResponse.json({ error: "Flow not found" }, { status: 404 });
    }

    const { error } = await ctx.supabase
      .from("flow_sheet_configs")
      .delete()
      .eq("flow_id", flowId);

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
