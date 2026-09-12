import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  ASSIGN_HEADER,
  ASSIGN_KEY,
  COMPLETED_RUN_ID_HEADER,
  getAssignForFlowRun,
} from "@/lib/automations/assignment";
import { getValidAccessToken } from "@/lib/google/oauth";
import {
  findExactValueRow,
  findExactValueRows,
  findHeaderColumn,
  insertSheetColumns,
  updateDataCell,
  updateHeaderCells,
} from "@/lib/google/sheets";
import { quoteSheetTitle, updateTabDataCell, updateTabHeaderCells } from "@/lib/google/tabs";
import {
  INCOMPLETE_RUN_ID_HEADER,
  incompleteBaseOffset,
  incompleteRunIdColumnIndex,
} from "@/lib/flows/sheet-layout";
import { resolveFlowSheetColumns } from "@/lib/flows/sheet-sync";
import { resolveAllTabColumns } from "@/lib/all-sheets/columns";

/**
 * Best-effort enrichment of ALREADY-SYNCED rows after an automation
 * assignment pick. Exact flow_run_id identity only — never phone,
 * contact_id, or latest-pick fallback.
 *
 * Called fire-and-forget from the assignment step (never fails the
 * step): not-yet-synced rows are covered by the sync-time resolver
 * (vars injection), so this only patches rows the sync already wrote.
 * Independent automations (NULL flow_run_id) are ignored — there is no
 * exact Flow row to enrich.
 *
 * Never throws.
 */
export async function enrichAssignmentSheets(
  accountId: string,
  flowRunId: string | null | undefined,
): Promise<void> {
  if (!flowRunId) return;
  try {
    const db = supabaseAdmin();

    const { data: run } = await db
      .from("flow_runs")
      .select("id, flow_id, account_id, status")
      .eq("id", flowRunId)
      .maybeSingle();
    const row = run as {
      id?: string;
      flow_id?: string;
      account_id?: string;
      status?: string;
    } | null;
    if (!row?.id || !row.flow_id || row.account_id !== accountId) return;

    const assignName = await getAssignForFlowRun(db, row.id).catch(() => null);
    if (!assignName) return;

    const token = await getValidAccessToken(db, accountId).catch(() => null);
    if (!token) return;

    // Each destination is independent — one failing must not block others.
    await enrichDedicatedCompleted(db, row.flow_id, row.id, assignName, token).catch(() => {});
    await enrichDedicatedIncomplete(db, row.flow_id, row.id, row.status ?? "", assignName, token).catch(
      () => {},
    );
    await enrichAllSheets(db, accountId, row.flow_id, row.id, assignName, token).catch(() => {});
  } catch {
    // Never break the automation step.
  }
}

async function enrichDedicatedCompleted(
  db: ReturnType<typeof supabaseAdmin>,
  flowId: string,
  flowRunId: string,
  assignName: string,
  token: string,
): Promise<void> {
  const { data: cfg } = await db
    .from("flow_sheet_configs")
    .select("spreadsheet_id, sheet_tab, answer_columns, header_written, schema_version, name_column_key")
    .eq("flow_id", flowId)
    .maybeSingle();
  const config = cfg as {
    spreadsheet_id?: string;
    sheet_tab?: string;
    answer_columns?: string[];
    header_written?: boolean;
    schema_version?: number | null;
    name_column_key?: string | null;
  } | null;
  if (!config?.spreadsheet_id || !config.sheet_tab) return;

  // Heal Assign (+ hidden Run ID) if this flow just adopted them.
  await resolveFlowSheetColumns(db, flowId, token, { includeAssign: true }).catch(() => null);

  // Locate the EXACT row via the hidden Run ID. Old sheets without the
  // column (or rows written before adoption) have no safe identity —
  // skip rather than guess.
  const runIdCol = await findHeaderColumn(
    token,
    config.spreadsheet_id,
    config.sheet_tab,
    COMPLETED_RUN_ID_HEADER,
  ).catch(() => null);
  if (runIdCol === null) return;
  const rowNumber = await findExactValueRow(
    token,
    config.spreadsheet_id,
    config.sheet_tab,
    runIdCol,
    flowRunId,
  ).catch(() => null);
  if (!rowNumber) return;
  const assignCol = await findHeaderColumn(
    token,
    config.spreadsheet_id,
    config.sheet_tab,
    ASSIGN_HEADER,
  ).catch(() => null);
  if (assignCol === null) return;
  await updateDataCell(token, config.spreadsheet_id, config.sheet_tab, assignCol, rowNumber, assignName);
}

async function enrichDedicatedIncomplete(
  db: ReturnType<typeof supabaseAdmin>,
  flowId: string,
  flowRunId: string,
  status: string,
  assignName: string,
  token: string,
): Promise<void> {
  // Only runs that already landed in the incomplete sheet can need a
  // patch; not-yet-synced rows are covered at sync time.
  if (!["timed_out", "failed", "handed_off"].includes(status)) return;
  const { data: runRow } = await db
    .from("flow_runs")
    .select("incomplete_synced_at")
    .eq("id", flowRunId)
    .maybeSingle();
  if (!(runRow as { incomplete_synced_at?: string | null } | null)?.incomplete_synced_at) return;

  const { data: cfg } = await db
    .from("flow_incomplete_sheet_configs")
    .select("spreadsheet_id, sheet_tab, answer_columns, answer_headers, header_written, schema_version")
    .eq("flow_id", flowId)
    .maybeSingle();
  const config = cfg as {
    spreadsheet_id?: string;
    sheet_tab?: string;
    answer_columns?: string[];
    answer_headers?: string[];
    header_written?: boolean;
    schema_version?: number | null;
  } | null;
  if (!config?.spreadsheet_id || !config.sheet_tab || !config.header_written) return;

  // Heal the Assign column before the hidden Run ID when missing.
  const storedKeys: string[] = config.answer_columns ?? [];
  if (!storedKeys.includes(ASSIGN_KEY)) {
    const schemaVersion = config.schema_version ?? 2;
    // V6 promotion flag affects the base offset; derive conservatively
    // (false) — insert position only shifts by the leading cell, and a
    // wrong guess would misplace the column. Read the live header to
    // decide: if A1 is a standard column, no promoted cell exists.
    const answerInsertCol = incompleteBaseOffset(schemaVersion, false) + storedKeys.length;
    // Verify against the live Run ID position instead of trusting the
    // guess: the Run ID header must sit exactly at the computed index
    // for the insert to be safe; otherwise re-derive with promotion.
    let insertCol = answerInsertCol;
    let hasPromoted = false;
    const liveRunIdCol = await findHeaderColumn(
      token,
      config.spreadsheet_id,
      config.sheet_tab,
      INCOMPLETE_RUN_ID_HEADER,
    ).catch(() => null);
    const expectedPlain = incompleteRunIdColumnIndex(schemaVersion, storedKeys, false);
    if (liveRunIdCol !== null && liveRunIdCol !== expectedPlain) {
      const expectedPromoted = incompleteRunIdColumnIndex(schemaVersion, storedKeys, true);
      if (liveRunIdCol === expectedPromoted) {
        hasPromoted = true;
        insertCol = incompleteBaseOffset(schemaVersion, true) + storedKeys.length;
      } else {
        // Layout drift we cannot explain — refuse to insert rather than
        // risk shifting the Run ID away from its rows.
        return;
      }
    }
    await insertSheetColumns(token, config.spreadsheet_id, config.sheet_tab, insertCol, 1);
    await updateHeaderCells(token, config.spreadsheet_id, config.sheet_tab, [
      { colIndex: insertCol, value: ASSIGN_HEADER },
    ]);
    const nextKeys = [...storedKeys, ASSIGN_KEY];
    // Keep stored order consistent with the physical insert (append at
    // end = before Run ID). The insert above placed the column at
    // insertCol which equals base+stored.length, i.e. exactly the append
    // position, so appending to the array matches the sheet.
    void hasPromoted;
    const nextHeaders = [...(config.answer_headers ?? storedKeys), ASSIGN_HEADER];
    await db
      .from("flow_incomplete_sheet_configs")
      .update({ answer_columns: nextKeys, answer_headers: nextHeaders, updated_at: new Date().toISOString() })
      .eq("flow_id", flowId);
  }

  const runIdCol = await findHeaderColumn(
    token,
    config.spreadsheet_id,
    config.sheet_tab,
    INCOMPLETE_RUN_ID_HEADER,
  ).catch(() => null);
  if (runIdCol === null) return;
  const rowNumber = await findExactValueRow(
    token,
    config.spreadsheet_id,
    config.sheet_tab,
    runIdCol,
    flowRunId,
  ).catch(() => null);
  if (!rowNumber) return;
  const assignCol = await findHeaderColumn(
    token,
    config.spreadsheet_id,
    config.sheet_tab,
    ASSIGN_HEADER,
  ).catch(() => null);
  if (assignCol === null) return;
  await updateDataCell(token, config.spreadsheet_id, config.sheet_tab, assignCol, rowNumber, assignName);
}

async function enrichAllSheets(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  flowId: string,
  flowRunId: string,
  assignName: string,
  token: string,
): Promise<void> {
  const { data: collections } = await db
    .from("all_sheet_collections")
    .select("*")
    .eq("account_id", accountId);
  const cols = ((collections ?? []) as Array<{ id: string; kind: string }>);
  if (cols.length === 0) return;
  const { data: tabs } = await db
    .from("all_sheet_flow_tabs")
    .select("*")
    .eq("flow_id", flowId)
    .in(
      "collection_id",
      cols.map((c) => c.id),
    );
  const tabRows = ((tabs ?? []) as Array<{
    id: string;
    collection_id: string;
    worksheet_title: string;
    answer_columns: string[];
    header_written: boolean;
    schema_version: number | null;
    name_column_key: string | null;
  }>);
  for (const tab of tabRows) {
    const collection = cols.find((c) => c.id === tab.collection_id);
    if (!collection) continue;
    // Only rows already recorded in this tab's watermark can need a
    // patch; pending rows are covered at import/refresh time.
    const { data: states } = await db
      .from("all_sheet_tab_run_state")
      .select("flow_run_id")
      .eq("tab_id", tab.id)
      .eq("flow_run_id", flowRunId);
    if (!((states ?? []) as unknown[]).length) continue;
    try {
      if (collection.kind === "completed") {
        await enrichAllSheetsCompletedTab(db, collection.id, tab, flowRunId, assignName, token);
      } else {
        await enrichAllSheetsIncompleteTab(db, collection.id, tab, flowRunId, assignName, token);
      }
    } catch {
      // Per-tab isolation: one tab failing never blocks siblings.
    }
  }
}

async function enrichAllSheetsCompletedTab(
  db: ReturnType<typeof supabaseAdmin>,
  collectionId: string,
  tab: {
    id: string;
    worksheet_title: string;
    answer_columns: string[];
    header_written: boolean;
    schema_version: number | null;
    name_column_key: string | null;
  },
  flowRunId: string,
  assignName: string,
  token: string,
): Promise<void> {
  const { data: collection } = await db
    .from("all_sheet_collections")
    .select("spreadsheet_id")
    .eq("id", collectionId)
    .maybeSingle();
  const spreadsheetId = (collection as { spreadsheet_id?: string } | null)?.spreadsheet_id;
  if (!spreadsheetId) return;
  // Heal Assign (+ hidden Run ID) when missing.
  const { data: fullTab } = await db
    .from("all_sheet_flow_tabs")
    .select("*")
    .eq("id", tab.id)
    .maybeSingle();
  if (!fullTab) return;
  await resolveAllTabColumns(db, fullTab as never, spreadsheetId, token, {
    includeAssign: true,
  }).catch(() => null);

  const quoted = quoteSheetTitle(tab.worksheet_title);
  const runIdCol = await findHeaderColumn(token, spreadsheetId, quoted, COMPLETED_RUN_ID_HEADER).catch(
    () => null,
  );
  if (runIdCol === null) return;
  const found = await findExactValueRows(token, spreadsheetId, quoted, runIdCol, [flowRunId]).catch(
    () => new Map<string, number>(),
  );
  const rowNumber = found.get(flowRunId);
  if (!rowNumber) return;
  const assignCol = await findHeaderColumn(token, spreadsheetId, quoted, ASSIGN_HEADER).catch(
    () => null,
  );
  if (assignCol === null) return;
  await updateTabDataCell(token, spreadsheetId, tab.worksheet_title, assignCol, rowNumber, assignName);
}

async function enrichAllSheetsIncompleteTab(
  db: ReturnType<typeof supabaseAdmin>,
  collectionId: string,
  tab: {
    id: string;
    worksheet_title: string;
    answer_columns: string[];
    header_written: boolean;
    schema_version: number | null;
    name_column_key: string | null;
  },
  flowRunId: string,
  assignName: string,
  token: string,
): Promise<void> {
  const { data: collection } = await db
    .from("all_sheet_collections")
    .select("spreadsheet_id")
    .eq("id", collectionId)
    .maybeSingle();
  const spreadsheetId = (collection as { spreadsheet_id?: string } | null)?.spreadsheet_id;
  if (!spreadsheetId || !tab.header_written) return;

  // Heal Assign before the hidden Run ID when missing (same mechanism
  // as refreshAllSheetIncomplete mid-life path). Existing headers are
  // preserved; only Assign is appended.
  if (!(tab.answer_columns ?? []).includes(ASSIGN_KEY)) {
    const schemaVersion = tab.schema_version ?? 6;
    const storedKeys: string[] = tab.answer_columns ?? [];
    const { data: fullTab } = await db
      .from("all_sheet_flow_tabs")
      .select("answer_headers")
      .eq("id", tab.id)
      .maybeSingle();
    const storedHeaders: string[] =
      (fullTab as { answer_headers?: string[] } | null)?.answer_headers ?? storedKeys;
    const answerInsertCol =
      incompleteBaseOffset(schemaVersion, !!tab.name_column_key) + storedKeys.length;
    await insertSheetColumns(token, spreadsheetId, tab.worksheet_title, answerInsertCol, 1);
    await updateTabHeaderCells(token, spreadsheetId, tab.worksheet_title, [
      { colIndex: answerInsertCol, value: ASSIGN_HEADER },
    ]);
    await db
      .from("all_sheet_flow_tabs")
      .update({
        answer_columns: [...storedKeys, ASSIGN_KEY],
        answer_headers: [...storedHeaders, ASSIGN_HEADER],
      })
      .eq("id", tab.id);
  }

  const quoted = quoteSheetTitle(tab.worksheet_title);
  const runIdCol = await findHeaderColumn(token, spreadsheetId, quoted, INCOMPLETE_RUN_ID_HEADER).catch(
    () => null,
  );
  if (runIdCol === null) return;
  const found = await findExactValueRows(token, spreadsheetId, quoted, runIdCol, [flowRunId]).catch(
    () => new Map<string, number>(),
  );
  const rowNumber = found.get(flowRunId);
  if (!rowNumber) return;
  const assignCol = await findHeaderColumn(token, spreadsheetId, quoted, ASSIGN_HEADER).catch(
    () => null,
  );
  if (assignCol === null) return;
  await updateTabDataCell(token, spreadsheetId, tab.worksheet_title, assignCol, rowNumber, assignName);
}
