import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    // Get ALL incomplete/abandoned runs across all flows (not just sync node flows)
    const { data: droppedRuns } = await ctx.supabase
      .from("flow_runs")
      .select("contact_id")
      .neq("status", "completed");

    // Count unique contacts
    const uniqueContacts = new Set(
      (droppedRuns ?? [])
        .map((r: any) => r.contact_id)
        .filter(Boolean),
    );

    return NextResponse.json({ count: uniqueContacts.size });
  } catch (err) {
    return toErrorResponse(err);
  }
}
