// GET /api/all-sheets/tabs/:id/rows
//
// DB preview for the All Sheets UI: reads flow_runs + contacts directly
// for this tab's flow. Does not call the Google Sheets API (no quota)
// and never touches existing Google Sheets config.

import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { ALL_SHEET_INCOMPLETE_STATUSES, type AllSheetFlowTabRow } from "@/lib/all-sheets/types";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 25) || 25, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);

    const { data: tab } = await ctx.supabase
      .from("all_sheet_flow_tabs")
      .select("*")
      .eq("id", id)
      .maybeSingle<AllSheetFlowTabRow>();
    if (!tab) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { data: collection } = await ctx.supabase
      .from("all_sheet_collections")
      .select("id, kind, account_id, spreadsheet_url, spreadsheet_name")
      .eq("id", tab.collection_id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!collection) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const kind = (collection as { kind: string }).kind;

    let query = ctx.supabase
      .from("flow_runs")
      .select("id, status, vars, started_at, ended_at, contact_id", { count: "exact" })
      .eq("flow_id", tab.flow_id)
      .order("started_at", { ascending: false })
      .range(offset, offset + limit - 1);
    query =
      kind === "completed"
        ? query.eq("status", "completed")
        : query.in("status", [...ALL_SHEET_INCOMPLETE_STATUSES]);

    const { data: runs, count, error } = await query;
    if (error) throw error;

    const contactIds = [...new Set(((runs ?? []).map((r) => r.contact_id).filter(Boolean)) as string[])];
    const contactMap = new Map<string, { phone?: string | null; name?: string | null }>();
    if (contactIds.length > 0) {
      const { data: contacts } = await ctx.supabase.from("contacts").select("id, phone, name").in("id", contactIds);
      for (const c of (contacts ?? []) as Array<{ id: string; phone?: string | null; name?: string | null }>) {
        contactMap.set(c.id, { phone: c.phone, name: c.name });
      }
    }

    const runIds = ((runs ?? []).map((r) => r.id) as string[]);
    let synced = new Set<string>();
    if (runIds.length > 0) {
      const { data: states } = await ctx.supabase
        .from("all_sheet_tab_run_state")
        .select("flow_run_id")
        .eq("tab_id", id)
        .in("flow_run_id", runIds);
      synced = new Set((states ?? []).map((s) => s.flow_run_id as string));
    }

    return NextResponse.json({
      tab,
      collection,
      total: count ?? 0,
      runs: (runs ?? []).map((r) => ({
        id: r.id,
        status: r.status,
        vars: r.vars ?? {},
        started_at: r.started_at,
        ended_at: r.ended_at,
        contact: r.contact_id ? (contactMap.get(r.contact_id as string) ?? null) : null,
        synced: synced.has(r.id as string),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
