// Per-flow Google Sheet link.
//
//   GET    — current sheet config for this flow + Google connection state
//   POST   — create a new spreadsheet and link it
//   DELETE — unlink (stops syncing; the sheet itself is untouched)
//
// Sheets are always app-created (drive.file scope) — there is no
// link-an-existing-sheet path, since that would require the sensitive
// `spreadsheets` scope and force Google verification.
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
  CURRENT_SHEET_SCHEMA_VERSION,
} from "@/lib/google/sheets";
import { deriveFlowColumns, orderNodesForSheets, type FlowNodeLite } from "@/lib/flows/sheet-columns";
import { resolveFreshLinkSchemaVersion } from "@/lib/flows/sheet-layout";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Every question node this flow currently has, split into the promoted
 * "Name" slot (if any) and the rest, in canonical flow (graph-walk)
 * order. Used both to seed a brand-new link and to recompute after a
 * relink — so NEW sheets list answers in flow order. Existing sheets
 * keep their stored order; this only seeds fresh configs.
 */
async function deriveColumnsForFlow(
  db: SupabaseClient,
  flowId: string,
): Promise<ReturnType<typeof deriveFlowColumns>> {
  const [{ data: nodes }, { data: flow }] = await Promise.all([
    db
      .from("flow_nodes")
      .select("node_key, node_type, config, created_at")
      .eq("flow_id", flowId)
      .order("created_at", { ascending: true }),
    db.from("flows").select("entry_node_id").eq("id", flowId).maybeSingle(),
  ]);
  const ordered = orderNodesForSheets(
    (flow as { entry_node_id?: string | null } | null)?.entry_node_id ?? null,
    (nodes ?? []) as FlowNodeLite[],
  );
  return deriveFlowColumns(ordered, true);
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
  // Re-linking the SAME spreadsheet (e.g. just to pick up a renamed
  // column or a newly-included question) must not re-trigger the header
  // write — the header row is already there. Only a genuinely different
  // spreadsheet_id (or first-ever link) should reset header_written, so
  // the next sync writes a fresh header into the new sheet.
  const { data: existing } = await ctx.supabase
    .from("flow_sheet_configs")
    .select(
      "spreadsheet_id, header_written, schema_version, answer_columns, answer_headers, name_column_key, name_column_header",
    )
    .eq("flow_id", flowId)
    .maybeSingle();

  const sameSpreadsheet = existing?.spreadsheet_id === meta.spreadsheetId;
  const headerWritten = sameSpreadsheet ? (existing?.header_written ?? false) : false;
  // A genuinely fresh header (new spreadsheet, or one never synced yet)
  // adopts the current schema (v3: Phone Number + Submission Time only,
  // flow-captured name promoted first when present). Relinking the SAME
  // spreadsheet that already has a header keeps whatever version it was
  // written under (v1/v2 frozen with their Flow Name / User ID columns) —
  // the on-sheet header text can't be silently reflowed.
  const schemaVersion = resolveFreshLinkSchemaVersion(
    existing,
    meta.spreadsheetId,
    CURRENT_SHEET_SCHEMA_VERSION,
  );

  const derived = await deriveColumnsForFlow(ctx.supabase, flowId);
  const promoteName = schemaVersion >= 2;
  // Relinking the SAME spreadsheet whose header is already written must
  // not touch the stored column order: the on-sheet header and all
  // existing rows are aligned to it, and a fresh derivation (now in
  // canonical flow order) could otherwise reorder it and misalign future
  // appends. Renames and newly-included questions are still picked up by
  // the self-healing sync on the next run — no manual relink needed.
  const reuseStoredColumns = sameSpreadsheet && headerWritten;
  const nameKey = reuseStoredColumns
    ? ((existing as { name_column_key?: string | null } | null)?.name_column_key ?? null)
    : promoteName
      ? (derived.name?.key ?? null)
      : null;
  const nameHeader = reuseStoredColumns
    ? ((existing as { name_column_header?: string | null } | null)?.name_column_header ?? null)
    : promoteName
      ? (derived.name?.header ?? null)
      : null;
  const restKeys = reuseStoredColumns
    ? (((existing as { answer_columns?: string[] } | null)?.answer_columns ?? []) as string[])
    : promoteName
      ? derived.rest.map((c) => c.key)
      : [...(derived.name ? [derived.name] : []), ...derived.rest].map((c) => c.key);
  const restHeaders = reuseStoredColumns
    ? (((existing as { answer_headers?: string[] } | null)?.answer_headers ?? []) as string[])
    : promoteName
      ? derived.rest.map((c) => c.header)
      : [...(derived.name ? [derived.name] : []), ...derived.rest].map((c) => c.header);

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
        answer_columns: restKeys,
        answer_headers: restHeaders,
        name_column_key: nameKey,
        name_column_header: nameHeader,
        schema_version: schemaVersion,
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
