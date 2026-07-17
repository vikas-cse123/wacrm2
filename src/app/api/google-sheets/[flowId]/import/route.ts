import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import {
  appendRows,
  STANDARD_COLUMNS_V1,
  STANDARD_COLUMNS_V2,
  formatSubmissionTimeIST,
} from "@/lib/google/sheets";
import { resolveFlowSheetColumns } from "@/lib/flows/sheet-sync";
import { NextResponse } from "next/server";

function stringifyVar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export async function POST(
  request: Request,
  context: { params: Promise<{ flowId: string }> },
) {
  try {
    const { flowId } = await context.params;
    const ctx = await getCurrentAccount();

    // Optional date-range filter on started_at (from inclusive, to
    // exclusive). Absent/empty body imports everything.
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

    const resolved = await resolveFlowSheetColumns(ctx.supabase, flowId, token);
    if (!resolved || resolved.sheet.account_id !== ctx.accountId) {
      return NextResponse.json(
        { error: "Sheet not linked for this flow." },
        { status: 400 },
      );
    }

    const { sheet, nameKey, nameHeader, keys: answerColumns, headers: answerHeaders, activeKeys } = resolved;

    let runsQuery = ctx.supabase
      .from("flow_runs")
      .select("id, contact_id, vars, started_at, ended_at")
      .eq("flow_id", flowId)
      .eq("status", "completed");
    if (from) runsQuery = runsQuery.gte("started_at", from);
    if (to) runsQuery = runsQuery.lt("started_at", to);
    const { data: runs } = await runsQuery.order("started_at", {
      ascending: true,
    });

    if (!runs || runs.length === 0) {
      return NextResponse.json({ imported: 0 });
    }

    const contactIds = [...new Set(runs.map((r) => r.contact_id).filter(Boolean))];
    const contactMap = new Map<string, { phone?: string }>();
    if (contactIds.length > 0) {
      const { data: contacts } = await ctx.supabase
        .from("contacts")
        .select("id, phone")
        .in("id", contactIds as string[]);
      for (const c of contacts ?? []) {
        contactMap.set(c.id, { phone: c.phone });
      }
    }

    const { data: flow } = await ctx.supabase
      .from("flows")
      .select("name")
      .eq("id", flowId)
      .maybeSingle();

    const promoteName = (sheet.schema_version ?? 1) >= 2;
    const standardColumns = promoteName ? STANDARD_COLUMNS_V2 : STANDARD_COLUMNS_V1;
    const nameHeaderCell = nameKey ? [nameHeader ?? "Name"] : [];

    const rows: (string | number)[][] = runs.map((run: any) => {
      const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
      const vars = (run.vars ?? {}) as Record<string, unknown>;
      const nameValueCell = nameKey ? [stringifyVar(vars[nameKey])] : [];
      const standardValues = promoteName
        ? [contact?.phone ?? "", flow?.name ?? "", formatSubmissionTimeIST(run.ended_at ?? run.started_at), run.contact_id ?? ""]
        : ["", contact?.phone ?? "", flow?.name ?? "", formatSubmissionTimeIST(run.ended_at ?? run.started_at), run.contact_id ?? ""];
      return [
        ...nameValueCell,
        ...standardValues,
        ...answerColumns.map((k) => activeKeys.has(k) ? stringifyVar(vars[k]) : ""),
      ];
    });

    const toWrite = sheet.header_written
      ? rows
      : [[...nameHeaderCell, ...standardColumns, ...answerHeaders], ...rows];

    await appendRows(token, sheet.spreadsheet_id, sheet.sheet_tab, toWrite);

    if (!sheet.header_written) {
      await ctx.supabase
        .from("flow_sheet_configs")
        .update({ header_written: true })
        .eq("flow_id", flowId);
    }

    return NextResponse.json({ imported: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
