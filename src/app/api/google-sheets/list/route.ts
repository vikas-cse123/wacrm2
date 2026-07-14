import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data: configs } = await ctx.supabase
      .from("flow_sheet_configs")
      .select("flow_id, spreadsheet_id, spreadsheet_name, spreadsheet_url, sheet_tab")
      .eq("account_id", ctx.accountId);

    if (!configs || configs.length === 0) {
      return NextResponse.json({ sheets: [] });
    }

    // Fetch flow names for each config
    const flowIds = configs.map((c) => c.flow_id);
    const { data: flows } = await ctx.supabase
      .from("flows")
      .select("id, name")
      .in("id", flowIds);

    const flowNameMap = new Map((flows ?? []).map((f) => [f.id, f.name]));

    const sheets = configs.map((c) => ({
      flow_id: c.flow_id,
      flow_name: flowNameMap.get(c.flow_id) || "Unknown Flow",
      spreadsheet_name: c.spreadsheet_name,
      spreadsheet_url: c.spreadsheet_url,
      sheet_tab: c.sheet_tab,
    }));

    return NextResponse.json({ sheets });
  } catch (err) {
    return toErrorResponse(err);
  }
}
