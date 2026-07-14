import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { NextResponse } from "next/server";

function getDateRange(filter: string): [Date, Date] {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  switch (filter) {
    case "yesterday":
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      break;
    case "2days":
      start.setDate(start.getDate() - 2);
      break;
    case "3days":
      start.setDate(start.getDate() - 3);
      break;
    case "4days":
      start.setDate(start.getDate() - 4);
      break;
    case "week":
      start.setDate(start.getDate() - 7);
      break;
    case "month":
      start.setMonth(start.getMonth() - 1);
      break;
    case "all":
      start.setFullYear(1970);
      break;
  }

  return [new Date(start.toISOString().split("T")[0]), new Date(end.toISOString().split("T")[0] + "T23:59:59Z")];
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const dateFilter = url.searchParams.get("dateFilter") || "week";

    // Get all flows with google_sheets_sync node
    const { data: syncNodeFlows } = await ctx.supabase
      .from("flow_nodes")
      .select("flow_id")
      .eq("node_type", "google_sheets_sync")
      .eq("account_id", ctx.accountId);

    if (!syncNodeFlows || syncNodeFlows.length === 0) {
      return NextResponse.json({ count: 0 });
    }

    const flowIds = [...new Set(syncNodeFlows.map((n) => n.flow_id))];
    const [dateStart, dateEnd] = getDateRange(dateFilter);

    // Get runs from those flows that are NOT completed (dropped off/abandoned)
    const { data: droppedRuns } = await ctx.supabase
      .from("flow_runs")
      .select("contact_id")
      .in("flow_id", flowIds)
      .neq("status", "completed")
      .gte("started_at", dateStart.toISOString())
      .lte("started_at", dateEnd.toISOString());

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
