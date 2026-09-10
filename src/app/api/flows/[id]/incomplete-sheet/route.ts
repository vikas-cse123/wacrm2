// /api/flows/[id]/incomplete-sheet
//
// POST   — enable the live incomplete-runs sheet for this flow: creates
//          a spreadsheet, stores the config, and immediately backfills
//          every existing dropped run. From then on the flows cron
//          appends new dropped runs automatically.
// DELETE — disable it. The spreadsheet itself is left untouched in
//          Google Drive; the runs' sync watermark is reset so
//          re-enabling starts with a fresh full backfill.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getValidAccessToken } from "@/lib/google/oauth";
import { createSpreadsheet } from "@/lib/google/sheets";
import {
  syncIncompleteRunsForFlow,
  type IncompleteSheetConfigRow,
} from "@/lib/flows/incomplete-sheet-sync";
import { CURRENT_INCOMPLETE_SCHEMA_VERSION } from "@/lib/flows/sheet-layout";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: flowId } = await context.params;
    const ctx = await requireRole("admin");
    const body = await request.json().catch(() => ({}));
    const parseDate = (value: unknown) => {
      if (typeof value !== "string" || !value) return undefined;
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
    };
    const window = {
      from: parseDate((body as Record<string, unknown>).from),
      to: parseDate((body as Record<string, unknown>).to),
    };

    const { data: flow } = await ctx.supabase
      .from("flows")
      .select("id, name")
      .eq("id", flowId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!flow) {
      return NextResponse.json({ error: "Flow not found" }, { status: 404 });
    }

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "Connect a Google account first." },
        { status: 400 },
      );
    }

    // Already enabled: use this as a manual, date-filterable import of
    // unsynced historical incomplete runs. The cron handles future runs.
    const { data: existing } = await ctx.supabase
      .from("flow_incomplete_sheet_configs")
      .select("*")
      .eq("flow_id", flowId)
      .maybeSingle<IncompleteSheetConfigRow>();
    if (existing) {
      const imported = await syncIncompleteRunsForFlow(
        supabaseAdmin(), existing, token, window,
      );
      return NextResponse.json({ config: existing, imported });
    }

    const meta = await createSpreadsheet(
      token,
      `${flow.name} — Incomplete Runs (Live)`,
    );

    const { data: config, error: insertErr } = await ctx.supabase
      .from("flow_incomplete_sheet_configs")
      .insert({
        flow_id: flowId,
        account_id: ctx.accountId,
        spreadsheet_id: meta.spreadsheetId,
        spreadsheet_url: meta.url,
        spreadsheet_name: meta.title,
        sheet_tab: meta.firstSheetTitle,
      })
      .select()
      .single<IncompleteSheetConfigRow>();
    if (insertErr || !config) {
      throw new Error(insertErr?.message ?? "Failed to save sheet config");
    }

    // Stamp brand-new sheets with the current incomplete layout (V4:
    // slim columns without Flow Name / User ID and without the fixed
    // WhatsApp/contact-profile Name cell; flow-collected Name answers are
    // unaffected). Best-effort: DBs predating the schema_version column
    // reject the update, in which case the sheet stays on the frozen v2
    // layout — the first sync below is then explicitly told which version
    // was stamped so its header and rows stay consistent either way.
    // Existing sheets are never touched (the `existing` early-return above
    // reuses them).
    let incompleteSchemaVersion = 2;
    const { error: versionErr } = await ctx.supabase
      .from("flow_incomplete_sheet_configs")
      .update({ schema_version: CURRENT_INCOMPLETE_SCHEMA_VERSION })
      .eq("flow_id", flowId);
    if (!versionErr) {
      incompleteSchemaVersion = 3;
    } else {
      console.warn(
        `[incomplete-sheet] schema_version stamp skipped (pre-migration DB?) — new sheet stays v2: ${versionErr.message}`,
      );
    }

    // Initial backfill — same code path the cron uses, so historical
    // rows and future live rows share one format. Admin client: the
    // sweep stamps flow_runs.incomplete_synced_at, which end-user RLS
    // doesn't allow.
    const imported = await syncIncompleteRunsForFlow(
      supabaseAdmin(),
      { ...config, schema_version: incompleteSchemaVersion },
      token,
      window,
    );

    return NextResponse.json({ config, imported });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: flowId } = await context.params;
    const ctx = await requireRole("admin");

    const { data: config } = await ctx.supabase
      .from("flow_incomplete_sheet_configs")
      .select("flow_id, account_id")
      .eq("flow_id", flowId)
      .maybeSingle();
    if (!config || config.account_id !== ctx.accountId) {
      return NextResponse.json({ error: "Not enabled" }, { status: 404 });
    }

    await ctx.supabase
      .from("flow_incomplete_sheet_configs")
      .delete()
      .eq("flow_id", flowId);

    // Reset the watermark so a later re-enable backfills from scratch
    // into its fresh spreadsheet.
    await supabaseAdmin()
      .from("flow_runs")
      .update({ incomplete_synced_at: null })
      .eq("flow_id", flowId)
      .not("incomplete_synced_at", "is", null);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
