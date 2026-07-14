import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // Get all flows for this account
    const { data: flows } = await ctx.supabase
      .from("flows")
      .select("id, name")
      .eq("account_id", ctx.accountId);

    if (!flows || flows.length === 0) {
      return NextResponse.json({ flows: [] });
    }

    // For each flow, count incomplete runs
    const flowsWithCounts = await Promise.all(
      flows.map(async (flow) => {
        const { count } = await ctx.supabase
          .from("flow_runs")
          .select("id", { count: "exact", head: true })
          .eq("flow_id", flow.id)
          .neq("status", "completed");

        return {
          flow_id: flow.id,
          flow_name: flow.name,
          droppedCount: count || 0,
        };
      }),
    );

    return NextResponse.json({ flows: flowsWithCounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
