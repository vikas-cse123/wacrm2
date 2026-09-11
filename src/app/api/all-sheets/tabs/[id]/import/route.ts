// POST /api/all-sheets/tabs/:id/import
//
// All Sheets Completed import: append this flow's completed runs into its
// tab inside the shared COMPLETED collection spreadsheet. Own route, own
// tab config, own tab state. Never calls existing backfill/import routes.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import { importAllSheetCompleted } from "@/lib/all-sheets/sync";
import type {
  AllSheetCollectionRow,
  AllSheetFlowTabRow,
} from "@/lib/all-sheets/types";

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

async function loadTab(
  ctx: Awaited<ReturnType<typeof requireRole>>,
  id: string,
): Promise<{ collection: AllSheetCollectionRow; tab: AllSheetFlowTabRow } | { error: NextResponse }> {
  const { data: tab } = await ctx.supabase
    .from("all_sheet_flow_tabs")
    .select("*")
    .eq("id", id)
    .maybeSingle<AllSheetFlowTabRow>();
  if (!tab) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const { data: collection } = await ctx.supabase
    .from("all_sheet_collections")
    .select("*")
    .eq("id", tab.collection_id)
    .eq("account_id", ctx.accountId)
    .maybeSingle<AllSheetCollectionRow>();
  if (!collection) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (collection.kind !== "completed") {
    return { error: NextResponse.json({ error: "Use refresh for incomplete tabs" }, { status: 400 }) };
  }
  return { collection, tab };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");
    const body = await request.json().catch(() => ({}));
    const loaded = await loadTab(ctx, id);
    if ("error" in loaded) return loaded.error;

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json({ error: "Connect a Google account first." }, { status: 400 });
    }

    const result = await importAllSheetCompleted(ctx.supabase, loaded.collection, loaded.tab, token, {
      from: parseIsoDate((body as Record<string, unknown>)?.from),
      to: parseIsoDate((body as Record<string, unknown>)?.to),
    });
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
