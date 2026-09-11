// DELETE /api/all-sheets/tabs/:id
//
// Delete/unlink ONE flow worksheet/tab: remove the Drive tab (by stable
// sheetId), then its run-state rows + tab row. The collection spreadsheet
// and every sibling tab are untouched. The Drive spreadsheet is never
// deleted. Never touches flow_sheet_configs /
// flow_incomplete_sheet_configs / flow_runs.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import { deleteFlowTab } from "@/lib/all-sheets/sync";
import type {
  AllSheetCollectionRow,
  AllSheetFlowTabRow,
} from "@/lib/all-sheets/types";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");

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

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json({ error: "Connect a Google account first." }, { status: 400 });
    }

    await deleteFlowTab(ctx.supabase, collection, tab, token);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
