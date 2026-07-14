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
  headerFromPrompt,
  parseSpreadsheetId,
} from "@/lib/google/sheets";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Answer columns captured by this flow's collect_input nodes, in order:
 * `keys` are the var_keys (used to look up each answer), `headers` are the
 * question prompts (used for the sheet's header row). Same length/order.
 */
async function answerColumnsForFlow(
  db: SupabaseClient,
  flowId: string,
): Promise<{ keys: string[]; headers: string[] }> {
  // Every question-asking node maps to a column:
  //   - collect_input → keyed by its var_key, value from the typed reply.
  //   - send_buttons / send_list → keyed by node_key, value from the tapped
  //     option's label (the engine records it into vars on tap).
  const { data: nodes } = await db
    .from("flow_nodes")
    .select("node_type, node_key, config, created_at")
    .eq("flow_id", flowId)
    .in("node_type", ["collect_input", "send_buttons", "send_list"])
    .order("created_at", { ascending: true });

  const seen = new Set<string>();
  const keys: string[] = [];
  const headers: string[] = [];
  for (const n of nodes ?? []) {
    const cfg = n.config as {
      var_key?: string;
      prompt_text?: string;
      text?: string;
      sheet_include?: boolean;
      sheet_column_name?: string;
    };
    // Opt-out: skip questions the author excluded from the sheet.
    if (cfg.sheet_include === false) continue;

    const isCollect = n.node_type === "collect_input";
    const key = isCollect ? cfg.var_key : n.node_key;
    const prompt = isCollect ? cfg.prompt_text : cfg.text;
    if (!key || seen.has(key)) continue;

    seen.add(key);
    keys.push(key);
    const custom = (cfg.sheet_column_name ?? "").trim();
    headers.push(custom || headerFromPrompt(prompt, key));
  }
  return { keys, headers };
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
  const { keys, headers } = await answerColumnsForFlow(ctx.supabase, flowId);

  // Re-linking the SAME spreadsheet (e.g. just to pick up a renamed
  // column or a newly-included question) must not re-trigger the header
  // write — the header row is already there. Only a genuinely different
  // spreadsheet_id (or first-ever link) should reset header_written, so
  // the next sync writes a fresh header into the new sheet.
  const { data: existing } = await ctx.supabase
    .from("flow_sheet_configs")
    .select("spreadsheet_id, header_written")
    .eq("flow_id", flowId)
    .maybeSingle();
  const headerWritten =
    existing?.spreadsheet_id === meta.spreadsheetId
      ? (existing?.header_written ?? false)
      : false;

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
        answer_columns: keys,
        answer_headers: headers,
        header_written: headerWritten,
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
