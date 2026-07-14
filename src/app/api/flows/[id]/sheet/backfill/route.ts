// POST /api/flows/[id]/sheet/backfill
//
// One-shot import of this flow's already-completed runs into its linked
// Google Sheet. Appends one row per completed run (oldest first) in the
// same column layout as the live sync. Append-only — running it twice
// adds the rows again, so the UI confirms first.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import {
  appendRows,
  STANDARD_COLUMNS_V1,
  STANDARD_COLUMNS_V2,
  formatSubmissionTimeIST,
} from "@/lib/google/sheets";
import { resolveFlowSheetColumns } from "@/lib/flows/sheet-sync";

function stringifyVar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "Connect a Google account first." },
        { status: 400 },
      );
    }

    // Ownership + sheet link, reconciled against the flow's current nodes
    // (picks up any question added/renamed since the sheet was linked).
    const resolved = await resolveFlowSheetColumns(ctx.supabase, id, token);
    if (!resolved || resolved.sheet.account_id !== ctx.accountId) {
      return NextResponse.json(
        { error: "Link a spreadsheet first." },
        { status: 400 },
      );
    }
    const { sheet, nameKey, nameHeader, keys: answerColumns, headers: answerHeaders } = resolved;

    // All completed runs for this flow, oldest first.
    const { data: runs } = await ctx.supabase
      .from("flow_runs")
      .select("id, contact_id, vars, started_at, ended_at")
      .eq("flow_id", id)
      .eq("status", "completed")
      .order("started_at", { ascending: true });

    if (!runs || runs.length === 0) {
      return NextResponse.json({ imported: 0 });
    }

    // Batch-load the contacts referenced by those runs (phone only — the
    // WhatsApp profile name is no longer synced; see the "remove
    // WhatsApp name" change).
    const contactIds = [
      ...new Set(
        runs.map((r) => r.contact_id).filter((x): x is string => !!x),
      ),
    ];
    const contactMap = new Map<string, { phone?: string }>();
    if (contactIds.length > 0) {
      const { data: contacts } = await ctx.supabase
        .from("contacts")
        .select("id, phone")
        .in("id", contactIds);
      for (const c of contacts ?? []) {
        contactMap.set(c.id, { phone: c.phone });
      }
    }

    const { data: flow } = await ctx.supabase
      .from("flows")
      .select("name")
      .eq("id", id)
      .maybeSingle();

    const promoteName = (sheet.schema_version ?? 1) >= 2;
    const standardColumns = promoteName ? STANDARD_COLUMNS_V2 : STANDARD_COLUMNS_V1;
    const nameHeaderCell = nameKey ? [nameHeader ?? "Name"] : [];

    const rows: (string | number)[][] = runs.map((run) => {
      const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
      const vars = (run.vars ?? {}) as Record<string, unknown>;
      const nameValueCell = nameKey ? [stringifyVar(vars[nameKey])] : [];
      const standardValues = promoteName
        ? [contact?.phone ?? "", flow?.name ?? "", formatSubmissionTimeIST(run.ended_at ?? run.started_at), run.contact_id ?? ""]
        : ["", contact?.phone ?? "", flow?.name ?? "", formatSubmissionTimeIST(run.ended_at ?? run.started_at), run.contact_id ?? ""];
      return [
        ...nameValueCell,
        ...standardValues,
        ...answerColumns.map((k) => stringifyVar(vars[k])),
      ];
    });

    // Write the header row first if the sheet has never been synced.
    const toWrite = sheet.header_written
      ? rows
      : [[...nameHeaderCell, ...standardColumns, ...answerHeaders], ...rows];

    await appendRows(token, sheet.spreadsheet_id, sheet.sheet_tab, toWrite);

    if (!sheet.header_written) {
      await ctx.supabase
        .from("flow_sheet_configs")
        .update({ header_written: true })
        .eq("flow_id", id);
    }

    return NextResponse.json({ imported: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
