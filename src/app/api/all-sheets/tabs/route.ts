// POST /api/all-sheets/tabs {flow_id, kind}
//
// Add a flow to All Sheets: ensure the ONE collection spreadsheet for
// (account, kind) exists, then create (or adopt) exactly one worksheet
// tab for the flow inside it. Tab creation writes the header row only —
// historical runs are imported exclusively via the explicit Import route.
//
// A flow NEVER causes another spreadsheet to be created.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import { getOrCreateCollection } from "@/lib/all-sheets/collections";
import { ensureFlowTab } from "@/lib/all-sheets/flow-tabs";
import type { AllSheetKind } from "@/lib/all-sheets/types";

function parseKind(value: unknown): AllSheetKind | null {
  if (value === "completed" || value === "incomplete") return value;
  return null;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json().catch(() => ({}));
    const flowId = String((body as Record<string, unknown>)?.flow_id ?? "");
    const kind = parseKind((body as Record<string, unknown>)?.kind);
    if (!flowId) return NextResponse.json({ error: "flow_id required" }, { status: 400 });
    if (!kind) return NextResponse.json({ error: "kind must be completed|incomplete" }, { status: 400 });

    const { data: flow } = await ctx.supabase
      .from("flows")
      .select("id, name")
      .eq("id", flowId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json({ error: "Connect a Google account first." }, { status: 400 });
    }

    const { collection } = await getOrCreateCollection(ctx.supabase, ctx.accountId, kind, token);
    const { tab, created } = await ensureFlowTab(
      ctx.supabase,
      collection,
      kind,
      flowId,
      (flow as { name?: string } | null)?.name ?? "Flow",
      token,
    );
    return NextResponse.json({ collection, tab, created });
  } catch (err) {
    return toErrorResponse(err);
  }
}
