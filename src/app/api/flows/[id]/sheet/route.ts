// Per-flow Google Sheet link.
//
//   GET    — current sheet config for this flow + Google connection state
//   PUT    — link an existing spreadsheet (pasted URL/id)
//   POST   — create a new spreadsheet and link it
//   DELETE — unlink (stops syncing; the sheet itself is untouched)
//
// One row per flow ⇒ one sheet per flow. Mutations require admin+.

import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { getValidAccessToken, googleOAuthConfigured } from "@/lib/google/oauth";
import {
  createSpreadsheet,
  getSpreadsheet,
  parseSpreadsheetId,
} from "@/lib/google/sheets";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Ordered var_keys captured by this flow's collect_input nodes. */
async function answerColumnsForFlow(
  db: SupabaseClient,
  flowId: string,
): Promise<string[]> {
  const { data: nodes } = await db
    .from("flow_nodes")
    .select("node_type, config, created_at")
    .eq("flow_id", flowId)
    .eq("node_type", "collect_input")
    .order("created_at", { ascending: true });

  const seen = new Set<string>();
  const cols: string[] = [];
  for (const n of nodes ?? []) {
    const key = (n.config as { var_key?: string })?.var_key;
    if (key && !seen.has(key)) {
      seen.add(key);
      cols.push(key);
    }
  }
  return cols;
}

async function assertOwnedFlow(
  db: SupabaseClient,
  flowId: string,
  accountId: string,
): Promise<boolean> {
  const { data } = await db
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("account_id", accountId)
    .maybeSingle();
  return !!data;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await getCurrentAccount();
    if (!(await assertOwnedFlow(ctx.supabase, id, ctx.accountId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [{ data: config }, { data: conn }] = await Promise.all([
      ctx.supabase
        .from("flow_sheet_configs")
        .select("*")
        .eq("flow_id", id)
        .maybeSingle(),
      ctx.supabase
        .from("google_connections")
        .select("google_email")
        .eq("account_id", ctx.accountId)
        .maybeSingle(),
    ]);

    return NextResponse.json({
      config: config ?? null,
      connected: !!conn,
      email: conn?.google_email ?? null,
      configured: googleOAuthConfigured(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function linkSheet(
  ctx: Awaited<ReturnType<typeof requireRole>>,
  flowId: string,
  meta: { spreadsheetId: string; url: string; title: string; tab: string },
) {
  const answerColumns = await answerColumnsForFlow(ctx.supabase, flowId);
  const { data, error } = await ctx.supabase
    .from("flow_sheet_configs")
    .upsert(
      {
        flow_id: flowId,
        account_id: ctx.accountId,
        spreadsheet_id: meta.spreadsheetId,
        spreadsheet_url: meta.url,
        spreadsheet_name: meta.title,
        sheet_tab: meta.tab,
        answer_columns: answerColumns,
        header_written: false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "flow_id" },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// PUT — link an existing spreadsheet by pasted URL or id.
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");
    if (!(await assertOwnedFlow(ctx.supabase, id, ctx.accountId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const spreadsheetId = parseSpreadsheetId(String(body.url ?? ""));
    if (!spreadsheetId) {
      return NextResponse.json(
        { error: "Couldn't read a spreadsheet ID from that link." },
        { status: 400 },
      );
    }

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "Connect a Google account first." },
        { status: 400 },
      );
    }

    // Validate access + resolve the first tab.
    let meta;
    try {
      meta = await getSpreadsheet(token, spreadsheetId);
    } catch {
      return NextResponse.json(
        {
          error:
            "Couldn't open that spreadsheet. Make sure it's owned by (or shared with) the connected Google account.",
        },
        { status: 400 },
      );
    }

    const config = await linkSheet(ctx, id, {
      spreadsheetId: meta.spreadsheetId,
      url: meta.url,
      title: meta.title,
      tab: meta.firstSheetTitle,
    });
    return NextResponse.json({ config });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// POST — create a new spreadsheet and link it.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");
    if (!(await assertOwnedFlow(ctx.supabase, id, ctx.accountId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const title = String(body.title ?? "").trim() || "Flow responses";

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "Connect a Google account first." },
        { status: 400 },
      );
    }

    const meta = await createSpreadsheet(token, title);
    const config = await linkSheet(ctx, id, {
      spreadsheetId: meta.spreadsheetId,
      url: meta.url,
      title: meta.title,
      tab: meta.firstSheetTitle,
    });
    return NextResponse.json({ config });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// DELETE — unlink.
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");
    const { error } = await ctx.supabase
      .from("flow_sheet_configs")
      .delete()
      .eq("flow_id", id)
      .eq("account_id", ctx.accountId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
