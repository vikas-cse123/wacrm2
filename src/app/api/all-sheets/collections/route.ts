// All Sheets collections — isolated from existing Google Sheets routes.
//
//   GET  /api/all-sheets/collections[?kind=completed|incomplete]
//        → collections with their flow tabs + flow names.
//   POST /api/all-sheets/collections {kind}
//        → ensure the ONE collection spreadsheet for (account, kind).
//        Never creates a second spreadsheet for the kind.
//
// Reads/writes ONLY all_sheet_collections (+ tabs for the GET view).
// Never touches flow_sheet_configs, flow_incomplete_sheet_configs,
// or flow_runs watermarks.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import { getOrCreateCollection } from "@/lib/all-sheets/collections";
import type {
  AllSheetCollectionRow,
  AllSheetFlowTabRow,
  AllSheetKind,
} from "@/lib/all-sheets/types";

function parseKind(value: unknown): AllSheetKind | null {
  if (value === "completed" || value === "incomplete") return value;
  return null;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const kindParam = url.searchParams.get("kind");

    let query = ctx.supabase
      .from("all_sheet_collections")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("kind", { ascending: true });
    if (kindParam) {
      const k = parseKind(kindParam);
      if (!k) return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
      query = query.eq("kind", k);
    }
    const { data: collections, error } = await query;
    if (error) throw error;

    const ids = (collections ?? []).map((c) => (c as AllSheetCollectionRow).id);
    let tabs: AllSheetFlowTabRow[] = [];
    let nameMap = new Map<string, string>();
    if (ids.length > 0) {
      const { data: tabRows } = await ctx.supabase
        .from("all_sheet_flow_tabs")
        .select("*")
        .in("collection_id", ids)
        .order("display_order", { ascending: true });
      tabs = (tabRows ?? []) as AllSheetFlowTabRow[];
      const flowIds = [...new Set(tabs.map((t) => t.flow_id))];
      if (flowIds.length > 0) {
        const { data: flows } = await ctx.supabase.from("flows").select("id, name").in("id", flowIds);
        nameMap = new Map(((flows ?? []) as Array<{ id: string; name: string }>).map((f) => [f.id, f.name]));
      }
    }

    return NextResponse.json({
      collections: (collections ?? []).map((c) => {
        const col = c as AllSheetCollectionRow;
        return {
          ...col,
          tabs: tabs
            .filter((t) => t.collection_id === col.id)
            .map((t) => ({ ...t, flow_name: nameMap.get(t.flow_id) ?? "Unknown Flow" })),
        };
      }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json().catch(() => ({}));
    const kind = parseKind((body as Record<string, unknown>)?.kind);
    if (!kind) {
      return NextResponse.json({ error: "kind must be completed|incomplete" }, { status: 400 });
    }

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json({ error: "Connect a Google account first." }, { status: 400 });
    }

    const { collection, created } = await getOrCreateCollection(ctx.supabase, ctx.accountId, kind, token);
    return NextResponse.json({ collection, created });
  } catch (err) {
    return toErrorResponse(err);
  }
}
