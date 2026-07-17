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

    // Initial backfill — same code path the cron uses, so historical
    // rows and future live rows share one format. Admin client: the
    // sweep stamps flow_runs.incomplete_synced_at, which end-user RLS
    // doesn't allow.
    const imported = await syncIncompleteRunsForFlow(
      supabaseAdmin(),
      config,
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
