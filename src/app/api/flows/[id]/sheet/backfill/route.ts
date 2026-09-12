// POST /api/flows/[id]/sheet/backfill
//
// One-shot import of this flow's already-completed runs into its linked
// Google Sheet. Appends one row per completed run (oldest first) in the
// same column layout as the live sync. Append-only — running it twice
// adds the rows again, so the UI confirms first.
//
// Body (optional): { from?: string, to?: string } — ISO timestamps
// bounding `started_at` (inclusive from, exclusive to). Omit both to
// import everything.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import {
  appendRows,
  formatSubmissionTimeIST,
} from "@/lib/google/sheets";
import { resolveFlowSheetColumns } from "@/lib/flows/sheet-sync";
import {
  buildCompletedHeader,
  buildCompletedRow,
  stringifySheetCell,
} from "@/lib/flows/sheet-layout";
import {
  ASSIGN_KEY,
  COMPLETED_RUN_ID_KEY,
  getAssignsForFlowRuns,
} from "@/lib/automations/assignment";
import { completedAnswerOffset } from "@/lib/flows/sheet-layout";
import { setSheetColumnHidden } from "@/lib/google/sheets";

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");

    // Optional date-range filter. Absent/empty body → import everything.
    const body = await request.json().catch(() => ({}));
    const from = parseIsoDate((body as Record<string, unknown>)?.from);
    const to = parseIsoDate((body as Record<string, unknown>)?.to);

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "Connect a Google account first." },
        { status: 400 },
      );
    }

    // All completed runs for this flow, oldest first, optionally
    // bounded by the requested started_at window. Loaded BEFORE column
    // resolution so Assign healing knows whether any run carries a pick.
    let runsQuery = ctx.supabase
      .from("flow_runs")
      .select("id, contact_id, vars, started_at, ended_at")
      .eq("flow_id", id)
      .eq("status", "completed");
    if (from) runsQuery = runsQuery.gte("started_at", from);
    if (to) runsQuery = runsQuery.lt("started_at", to);
    const { data: runs } = await runsQuery.order("started_at", {
      ascending: true,
    });

    if (!runs || runs.length === 0) {
      return NextResponse.json({ imported: 0 });
    }

    // Exact-run Assign values (never contact/phone/latest). Healing is
    // conditional so flows without assignments keep identical layouts.
    const assignMap = await getAssignsForFlowRuns(
      ctx.supabase,
      (runs as Array<{ id: string }>).map((r) => r.id),
    ).catch(() => new Map<string, string>());

    // Ownership + sheet link, reconciled against the flow's current nodes
    // (picks up any question added/renamed since the sheet was linked).
    const resolved = await resolveFlowSheetColumns(ctx.supabase, id, token, {
      includeAssign: assignMap.size > 0,
    });
    if (!resolved || resolved.sheet.account_id !== ctx.accountId) {
      return NextResponse.json(
        { error: "Link a spreadsheet first." },
        { status: 400 },
      );
    }
    const { sheet, nameKey, nameHeader, keys: answerColumns, headers: answerHeaders, activeKeys } = resolved;

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

    // Versioned layout (see sheet-layout.ts): V1/V2 sheets keep their
    // frozen Flow Name / User ID columns; V3 sheets omit them. Header and
    // rows share one builder so positions always align. V3 needs no
    // flows.name lookup (no Flow Name cell); contact_id is still read for
    // row identity, only its exported User ID cell is gone.
    const isV3 = (sheet.schema_version ?? 1) >= 3;
    const { data: flow } = isV3
      ? { data: null as { name?: string } | null }
      : await ctx.supabase
        .from("flows")
        .select("name")
        .eq("id", id)
        .maybeSingle();

    const resolvedNameHeader = nameKey ? (nameHeader ?? "Name") : null;

    const rows: (string | number)[][] = runs.map((run) => {
      const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
      const vars = (run.vars ?? {}) as Record<string, unknown>;
      const varsWithAssign: Record<string, unknown> = { ...vars };
      if (answerColumns.includes(ASSIGN_KEY)) {
        varsWithAssign[ASSIGN_KEY] = assignMap.get(run.id) ?? "";
      }
      if (answerColumns.includes(COMPLETED_RUN_ID_KEY)) {
        varsWithAssign[COMPLETED_RUN_ID_KEY] = run.id;
      }
      return buildCompletedRow({
        schemaVersion: sheet.schema_version ?? 1,
        nameHeader: resolvedNameHeader,
        nameValue: nameKey ? stringifySheetCell(vars[nameKey]) : null,
        contactPhone: contact?.phone ?? "",
        flowName: flow?.name ?? "",
        submissionTime: formatSubmissionTimeIST(run.ended_at ?? run.started_at),
        contactId: run.contact_id ?? "",
        answerKeys: answerColumns,
        answerHeaders,
        activeKeys,
        vars: varsWithAssign,
      });
    });

    // Write the header row first if the sheet has never been synced.
    const toWrite = sheet.header_written
      ? rows
      : [buildCompletedHeader({
        schemaVersion: sheet.schema_version ?? 1,
        nameHeader: resolvedNameHeader,
        nameValue: null,
        contactPhone: "",
        flowName: "",
        submissionTime: "",
        contactId: "",
        answerKeys: answerColumns,
        answerHeaders,
        activeKeys,
        vars: {},
      }), ...rows];

    await appendRows(token, sheet.spreadsheet_id, sheet.sheet_tab, toWrite);

    if (!sheet.header_written) {
      await ctx.supabase
        .from("flow_sheet_configs")
        .update({ header_written: true })
        .eq("flow_id", id);
    }

    if (answerColumns.includes(COMPLETED_RUN_ID_KEY)) {
      try {
        const runIdCol =
          completedAnswerOffset(sheet.schema_version ?? 1, !!resolvedNameHeader) +
          answerColumns.indexOf(COMPLETED_RUN_ID_KEY);
        await setSheetColumnHidden(
          token,
          sheet.spreadsheet_id,
          sheet.sheet_tab,
          runIdCol,
          true,
        );
      } catch (err) {
        console.error("[backfill] could not hide Completed Run ID column:", err);
      }
    }

    return NextResponse.json({ imported: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
