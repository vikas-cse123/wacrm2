// POST /api/all-sheets/tabs/:id/refresh
//
// All Sheets Incomplete refresh: append newly-dropped runs into this
// flow's tab inside the shared INCOMPLETE collection spreadsheet. Own
// watermark (all_sheet_tab_run_state) — never
// flow_runs.incomplete_synced_at.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import { refreshAllSheetIncomplete } from "@/lib/all-sheets/sync";
import type {
  AllSheetCollectionRow,
  AllSheetFlowTabRow,
} from "@/lib/all-sheets/types";

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");
    const body = await request.json().catch(() => ({}));

    const { data: tab } = await ctx.supabase
      .from("all_sheet_flow_tabs")
      .select("*")
      .eq("id", id)
      .maybeSingle<AllSheetFlowTabRow>();
    if (!tab) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { data: collection } = await ctx.supabase
      .from("all_sheet_collections")
      .select("*")
      .eq("id", tab.collection_id)
      .eq("account_id", ctx.accountId)
      .maybeSingle<AllSheetCollectionRow>();
    if (!collection) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (collection.kind !== "incomplete") {
      return NextResponse.json({ error: "Use import for completed tabs" }, { status: 400 });
    }

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json({ error: "Connect a Google account first." }, { status: 400 });
    }

    const result = await refreshAllSheetIncomplete(ctx.supabase, collection, tab, token, {
      from: parseIsoDate((body as Record<string, unknown>)?.from),
      to: parseIsoDate((body as Record<string, unknown>)?.to),
    });
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
