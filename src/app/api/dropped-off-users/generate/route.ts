import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import { createSpreadsheet, appendRows, formatSubmissionTimeIST, STANDARD_COLUMNS_V2 } from "@/lib/google/sheets";
import { NextResponse } from "next/server";

function stringifyVar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "Connect a Google account first." },
        { status: 400 },
      );
    }

    // Get ALL incomplete/abandoned runs from any flow
    const { data: droppedRuns } = await ctx.supabase
      .from("flow_runs")
      .select("id, contact_id, vars, started_at, ended_at, flow_id")
      .neq("status", "completed")
      .order("started_at", { ascending: true });

    if (!droppedRuns || droppedRuns.length === 0) {
      return NextResponse.json({ rowCount: 0, sheetUrl: "" });
    }

    // Get unique contacts
    const contactIds = [...new Set(droppedRuns.map((r: any) => r.contact_id).filter(Boolean))];
    const contactMap = new Map<string, { name?: string; phone?: string }>();
    if (contactIds.length > 0) {
      const { data: contacts } = await ctx.supabase
        .from("contacts")
        .select("id, name, phone")
        .in("id", contactIds as string[]);
      for (const c of contacts ?? []) {
        contactMap.set(c.id, { name: c.name, phone: c.phone });
      }
    }

    // Create a new spreadsheet
    const title = `Dropped Off Users — ${new Date().toISOString().split("T")[0]}`;
    const meta = await createSpreadsheet(token, title);

    // Build rows with standard columns + all vars
    const standardColumns = STANDARD_COLUMNS_V2;
    const allVarKeys = new Set<string>();
    droppedRuns.forEach((run: any) => {
      Object.keys(run.vars ?? {}).forEach((k) => allVarKeys.add(k));
    });

    const headers = ["Name", ...standardColumns, ...Array.from(allVarKeys)];
    const rows = droppedRuns.map((run: any) => {
      const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
      const vars = (run.vars ?? {}) as Record<string, unknown>;
      return [
        contact?.name ?? "",
        contact?.phone ?? "",
        "", // flow name would require lookup
        formatSubmissionTimeIST(run.ended_at ?? run.started_at),
        run.contact_id ?? "",
        ...Array.from(allVarKeys).map((k) => stringifyVar(vars[k])),
      ];
    });

    // Append header + rows
    const toWrite = [[...headers], ...rows];
    await appendRows(token, meta.spreadsheetId, meta.firstSheetTitle, toWrite);

    return NextResponse.json({ rowCount: rows.length, sheetUrl: meta.url });
  } catch (err) {
    return toErrorResponse(err);
  }
}
