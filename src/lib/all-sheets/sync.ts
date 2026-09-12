// All Sheets — isolated sync orchestration, tab model
// (V1: explicit Import/Refresh only. No cron. No engine hooks.)
//
// Owns ONLY: all_sheet_flow_tabs, all_sheet_tab_run_state,
// all_sheet_tab_sync_failures. Reads: flows, flow_nodes, flow_runs,
// contacts, all_sheet_collections (for cross-kind cleanup routing).
//
// Does NOT import or call:
//   resolveFlowSheetColumns, syncRunToGoogleSheet,
//   syncIncompleteRunsForFlow, syncAllIncompleteSheets,
//   cleanupCompletedIncompleteRows, or any /api/flows/*sheet* handler.
// Does NOT read/write: flow_sheet_configs, flow_incomplete_sheet_configs,
// flow_runs.incomplete_synced_at, google_sheets_sync_failures.
//
// Safe reuse: google/sheets.ts REST helpers, google/tabs.ts quoting,
// sheet-columns/layout pure builders.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  appendRows,
  deleteSheetRows,
  findExactValueRows,
  findHeaderColumn,
  formatSubmissionTimeIST,
  insertSheetColumns,
  setSheetColumnHidden,
} from "@/lib/google/sheets";
import { deleteWorksheetTab, deleteSpreadsheet, quoteSheetTitle, updateTabHeaderCells } from "@/lib/google/tabs";
import {
  buildCompletedHeader,
  buildCompletedRow,
  buildIncompleteHeader,
  buildIncompleteRow,
  completedAnswerOffset,
  INCOMPLETE_RUN_ID_HEADER,
  incompleteBaseOffset,
  incompleteRunIdColumnIndex,
  partitionSheetKeys,
  stringifySheetCell,
} from "@/lib/flows/sheet-layout";
import {
  ASSIGN_HEADER,
  ASSIGN_KEY,
  COMPLETED_RUN_ID_HEADER,
  COMPLETED_RUN_ID_KEY,
  getAssignsForFlowRuns,
} from "@/lib/automations/assignment";
import {
  deriveFlowColumns,
  headerByKey,
  orderNodesForSheets,
  sortKeysByFlowOrder,
  type FlowNodeLite,
} from "@/lib/flows/sheet-columns";
import { resolveAllTabColumns } from "./columns";
import {
  ALL_SHEET_INCOMPLETE_STATUSES,
  type AllSheetCollectionRow,
  type AllSheetFlowTabRow,
} from "./types";

export interface AllSheetWindow {
  from?: string;
  to?: string;
  /** Max runs per pass (oldest first). Omitted = unbounded (manual Import). */
  limit?: number;
  /** Restrict to these run ids (completion handler, reconciliation). */
  runIds?: string[];
}

interface RunRow {
  id: string;
  contact_id: string | null;
  vars: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
}

async function syncedRunIds(db: SupabaseClient, tabId: string): Promise<Set<string>> {
  const { data } = await db
    .from("all_sheet_tab_run_state")
    .select("flow_run_id")
    .eq("tab_id", tabId);
  return new Set((data ?? []).map((r) => r.flow_run_id as string));
}

async function markSynced(db: SupabaseClient, tabId: string, runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  const { error } = await db.from("all_sheet_tab_run_state").upsert(
    runIds.map((id) => ({ tab_id: tabId, flow_run_id: id })),
    { onConflict: "tab_id,flow_run_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

async function logFailure(
  db: SupabaseClient,
  tab: AllSheetFlowTabRow,
  accountId: string,
  flowId: string,
  runId: string | null,
  contactId: string | null,
  payload: unknown,
  error: unknown,
): Promise<void> {
  try {
    await db.from("all_sheet_tab_sync_failures").insert({
      account_id: accountId,
      tab_id: tab.id,
      flow_id: flowId,
      flow_run_id: runId,
      contact_id: contactId,
      payload: payload as Record<string, unknown>,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Failure log must never break the caller.
  }
}

/**
 * Import completed runs into a flow's tab inside the COMPLETED collection.
 * Appends ONLY to that tab (addressed by quoted title); already-synced
 * runs (own tab state) are skipped. Never imports on tab creation — this
 * function is the explicit Import operation.
 */
export async function importAllSheetCompleted(
  db: SupabaseClient,
  collection: AllSheetCollectionRow,
  tab: AllSheetFlowTabRow,
  accessToken: string,
  window?: AllSheetWindow,
): Promise<{ imported: number }> {
  if (collection.kind !== "completed") throw new Error("Collection is not for completed runs");

  let query = db
    .from("flow_runs")
    .select("id, contact_id, vars, started_at, ended_at")
    .eq("flow_id", tab.flow_id)
    .eq("status", "completed");
  if (window?.from) query = query.gte("started_at", window.from);
  if (window?.to) query = query.lt("started_at", window.to);
  if (window?.runIds) query = query.in("id", window.runIds);
  if (window?.limit) query = query.limit(window.limit);
  const { data: runs, error: runsError } = await query.order("started_at", { ascending: true });
  if (runsError) throw runsError;

  const already = await syncedRunIds(db, tab.id);
  const pending = ((runs ?? []) as RunRow[]).filter((r) => !already.has(r.id));
  if (pending.length === 0) return { imported: 0 };

  // Sheet-idempotent check: detect rows already physically present via hidden
  // Flow Run ID (same pattern as refreshAllSheetIncomplete). Handles crash
  // after appendRows but before markSynced, and concurrent writers.
  const presentCompleted = tab.header_written
    ? await findCompletedRowsPresent(accessToken, collection.spreadsheet_id, tab.worksheet_title, pending.map((r) => r.id))
    : new Set<string>();
  if (presentCompleted.size > 0) {
    await markSynced(db, tab.id, [...presentCompleted]);
  }
  const fresh = pending.filter((r) => !presentCompleted.has(r.id));
  if (fresh.length === 0) return { imported: 0 };

  // Exact-run Assign values (never contact/phone/latest). Conditional
  // healing keeps tabs without assignments byte-identical.
  const assignMap = await getAssignsForFlowRuns(
    db,
    fresh.map((r) => r.id),
  ).catch(() => new Map<string, string>());

  const resolved = await resolveAllTabColumns(db, tab, collection.spreadsheet_id, accessToken, {
    includeAssign: assignMap.size > 0,
  });
  const sheet = resolved.tab;
  const quotedTitle = quoteSheetTitle(sheet.worksheet_title);

  const contactIds = [...new Set(fresh.map((r) => r.contact_id).filter(Boolean))] as string[];
  const contactMap = new Map<string, { phone?: string | null }>();
  if (contactIds.length > 0) {
    const { data: contacts } = await db.from("contacts").select("id, phone").in("id", contactIds);
    for (const c of (contacts ?? []) as Array<{ id: string; phone?: string | null }>) {
      contactMap.set(c.id, { phone: c.phone });
    }
  }

  const nameHeader = resolved.nameKey ? (resolved.nameHeader ?? "Name") : null;
  const rows = fresh.map((run) => {
    const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
    const vars = (run.vars ?? {}) as Record<string, unknown>;
    const varsWithAssign: Record<string, unknown> = { ...vars };
    if (resolved.keys.includes(ASSIGN_KEY)) {
      varsWithAssign[ASSIGN_KEY] = assignMap.get(run.id) ?? "";
    }
    if (resolved.keys.includes(COMPLETED_RUN_ID_KEY)) {
      varsWithAssign[COMPLETED_RUN_ID_KEY] = run.id;
    }
    return buildCompletedRow({
      schemaVersion: sheet.schema_version ?? 3,
      nameHeader,
      nameValue: resolved.nameKey ? stringifySheetCell(vars[resolved.nameKey]) : null,
      contactPhone: contact?.phone ?? "",
      flowName: "",
      submissionTime: formatSubmissionTimeIST(run.ended_at ?? run.started_at),
      contactId: run.contact_id ?? "",
      answerKeys: resolved.keys,
      answerHeaders: resolved.headers,
      activeKeys: resolved.activeKeys,
      vars: varsWithAssign,
    });
  });

  const header = buildCompletedHeader({
    schemaVersion: sheet.schema_version ?? 3,
    nameHeader,
    nameValue: null,
    contactPhone: "",
    flowName: "",
    submissionTime: "",
    contactId: "",
    answerKeys: resolved.keys,
    answerHeaders: resolved.headers,
    activeKeys: resolved.activeKeys,
    vars: {},
  });

  // Two-phase write: header first (then flag), rows second. A crash
  // between phases retries cleanly instead of duplicating the header.
  // Completed rows carry no stable id, so the tab-state stamp after the
  // row append is the dedup key (same accepted trade-off as the existing
  // system: duplicates over silent data loss on narrow crash windows).
  // Assign-enabled tabs additionally carry a hidden Flow Run ID for
  // exact post-sync Assign updates.
  try {
    if (!sheet.header_written) {
      await appendRows(accessToken, collection.spreadsheet_id, quotedTitle, [header]);
      await db.from("all_sheet_flow_tabs").update({ header_written: true }).eq("id", tab.id);
    }
    await appendRows(accessToken, collection.spreadsheet_id, quotedTitle, rows);
    if (resolved.keys.includes(COMPLETED_RUN_ID_KEY)) {
      try {
        const runIdCol =
          completedAnswerOffset(sheet.schema_version ?? 3, !!nameHeader) +
          resolved.keys.indexOf(COMPLETED_RUN_ID_KEY);
        await setSheetColumnHidden(
          accessToken,
          collection.spreadsheet_id,
          sheet.worksheet_title,
          runIdCol,
          true,
        );
      } catch (err) {
        console.error("[all-sheets] could not hide Completed Run ID column:", err);
      }
    }
  } catch (err) {
    await logFailure(db, sheet, collection.account_id, tab.flow_id, null, null, { count: rows.length }, err);
    throw err;
  }

  await markSynced(db, tab.id, fresh.map((r) => r.id));

  // Own-spreadsheet-only cleanup: runs that completed are removed from
  // this flow's tab in the INCOMPLETE collection (never the existing
  // incomplete-sheet configs or watermarks).
  await cleanupAllSheetIncompleteForRuns(db, collection, fresh.map((r) => r.id), accessToken).catch(
    (err) => console.error("[all-sheets] own cleanup failed:", err),
  );

  return { imported: fresh.length };
}

/**
 * Refresh a flow's tab inside the INCOMPLETE collection with newly-dropped
 * runs. Own watermark (all_sheet_tab_run_state) — never
 * flow_runs.incomplete_synced_at.
 */
export async function refreshAllSheetIncomplete(
  db: SupabaseClient,
  collection: AllSheetCollectionRow,
  tab: AllSheetFlowTabRow,
  accessToken: string,
  window?: AllSheetWindow,
): Promise<{ imported: number }> {
  if (collection.kind !== "incomplete") throw new Error("Collection is not for incomplete runs");

  let query = db
    .from("flow_runs")
    .select("id, contact_id, vars, started_at, ended_at")
    .eq("flow_id", tab.flow_id)
    .in("status", [...ALL_SHEET_INCOMPLETE_STATUSES]);
  if (window?.from) query = query.gte("started_at", window.from);
  if (window?.to) query = query.lt("started_at", window.to);
  if (window?.runIds) query = query.in("id", window.runIds);
  if (window?.limit) query = query.limit(window.limit);
  const { data: runs, error: runsError } = await query.order("started_at", { ascending: true });
  if (runsError) throw runsError;

  const already = await syncedRunIds(db, tab.id);
  const pending = ((runs ?? []) as RunRow[]).filter((r) => !already.has(r.id));
  if (pending.length === 0) return { imported: 0 };

  const { data: flow } = await db
    .from("flows")
    .select("entry_node_id")
    .eq("id", tab.flow_id)
    .maybeSingle();
  const entryKey = (flow as { entry_node_id?: string | null } | null)?.entry_node_id ?? null;

  const { data: sheetNodes } = await db
    .from("flow_nodes")
    .select("node_key, node_type, config, created_at")
    .eq("flow_id", tab.flow_id)
    .order("created_at", { ascending: true });
  const orderedNodes = orderNodesForSheets(entryKey, (sheetNodes ?? []) as FlowNodeLite[]);
  const { disabledKeys } = partitionSheetKeys(orderedNodes);
  const headerMap = headerByKey(entryKey, orderedNodes);
  const headerFor = (k: string) => headerMap.get(k) ?? k;

  const storedKeys = tab.answer_columns ?? [];
  const seen = new Set(storedKeys);
  const rawNew: string[] = [];
  // The adopted promoted Name key renders in the leading slot, never as
  // an answer column — exclude it so it can't duplicate mid-life.
  const adoptedPromotedKey = tab.header_written ? (tab.name_column_key ?? null) : null;
  for (const run of pending) {
    for (const k of Object.keys(run.vars ?? {})) {
      if (!seen.has(k) && !disabledKeys.has(k) && k !== adoptedPromotedKey) {
        seen.add(k);
        rawNew.push(k);
      }
    }
  }
  const newKeys = sortKeysByFlowOrder(rawNew, [...headerMap.keys()]);
  const answerColumns = [...storedKeys, ...newKeys];
  // Assign enrichment (069): exact-run values before the hidden Run ID.
  // Conditional only so tabs without assignments keep identical layouts.
  const assignMapInc = await getAssignsForFlowRuns(
    db,
    pending.map((r) => r.id),
  ).catch(() => new Map<string, string>());
  const includeAssignInc =
    assignMapInc.size > 0 || storedKeys.includes(ASSIGN_KEY);
  if (includeAssignInc && !answerColumns.includes(ASSIGN_KEY)) {
    answerColumns.push(ASSIGN_KEY);
    newKeys.push(ASSIGN_KEY);
  }
  const headerForAssignInc = (k: string): string =>
    k === ASSIGN_KEY ? ASSIGN_HEADER : headerFor(k);
  const schemaVersion = tab.schema_version ?? 6;
  const quotedTitle = quoteSheetTitle(tab.worksheet_title);

  let promotedHeader: string | null = tab.name_column_header ?? null;
  let promotedKey: string | null = tab.name_column_key ?? null;
  if (!tab.header_written) {
    const derived = deriveFlowColumns(orderedNodes, true);
    if (derived.name) {
      promotedKey = derived.name.key;
      promotedHeader = derived.name.header;
    }
    await db
      .from("all_sheet_flow_tabs")
      .update({
        answer_columns: answerColumns.filter((k) => k !== promotedKey),
        answer_headers: answerColumns.filter((k) => k !== promotedKey).map(headerForAssignInc),
        name_column_key: promotedKey,
        name_column_header: promotedHeader,
      })
      .eq("id", tab.id);
  } else if (newKeys.length > 0) {
    const answerInsertCol = incompleteBaseOffset(schemaVersion, !!tab.name_column_key) + storedKeys.length;
    // Structural calls resolve the tab by exact raw title; the header
    // write below takes the raw title and quotes it for literal A1 in the
    // request body (never pre-quoted, never URL-encoded).
    await insertSheetColumns(
      accessToken,
      collection.spreadsheet_id,
      tab.worksheet_title,
      answerInsertCol,
      newKeys.length,
    );
    await updateTabHeaderCells(
      accessToken,
      collection.spreadsheet_id,
      tab.worksheet_title,
      newKeys.map((k, i) => ({ colIndex: answerInsertCol + i, value: headerForAssignInc(k) })),
    );
    await db
      .from("all_sheet_flow_tabs")
      .update({ answer_columns: answerColumns, answer_headers: answerColumns.map(headerForAssignInc) })
      .eq("id", tab.id);
  }

  const finalCols = !tab.header_written ? answerColumns.filter((k) => k !== promotedKey) : answerColumns;
  const finalHeaders = finalCols.map(headerForAssignInc);

  const contactIds = [...new Set(pending.map((r) => r.contact_id).filter(Boolean))] as string[];
  const contactMap = new Map<string, { name?: string | null; phone?: string | null }>();
  if (contactIds.length > 0) {
    const { data: contacts } = await db.from("contacts").select("id, name, phone").in("id", contactIds);
    for (const c of (contacts ?? []) as Array<{ id: string; name?: string | null; phone?: string | null }>) {
      contactMap.set(c.id, { name: c.name, phone: c.phone });
    }
  }

  const headers = buildIncompleteHeader(schemaVersion, finalCols, finalHeaders, promotedHeader);
  const runIdCol = incompleteRunIdColumnIndex(schemaVersion, finalCols, !!promotedHeader);

  const toWriteHeader = tab.header_written ? null : headers;
  // Retry reconciliation: the hidden Flow Run ID column lets us detect
  // rows a previous crashed pass already appended (state stamp comes
  // after the append). Present rows are skipped AND stamped, so a retry
  // never duplicates and never loses.
  const present = tab.header_written
    ? await findIncompleteRowsPresent(accessToken, collection.spreadsheet_id, tab.worksheet_title, pending.map((r) => r.id))
    : new Set<string>();
  if (present.size > 0) {
    await markSynced(db, tab.id, [...present]);
  }
  const fresh = pending.filter((r) => !present.has(r.id));
  if (fresh.length === 0) return { imported: 0 };

  const toWriteRows = fresh.map((run) => {
    const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
    const vars = (run.vars ?? {}) as Record<string, unknown>;
    const varsWithAssign: Record<string, unknown> =
      finalCols.includes(ASSIGN_KEY)
        ? { ...vars, [ASSIGN_KEY]: assignMapInc.get(run.id) ?? "" }
        : vars;
    return buildIncompleteRow({
      schemaVersion,
      contactName: contact?.name ?? "",
      contactPhone: contact?.phone ?? "",
      flowName: "",
      submissionTime: formatSubmissionTimeIST(run.ended_at ?? run.started_at),
      contactId: run.contact_id ?? "",
      vars: varsWithAssign,
      answerColumns: finalCols,
      runId: run.id,
      inactiveKeys: disabledKeys,
      promotedHeader,
      promotedValue:
        promotedHeader != null && promotedKey != null ? stringifySheetCell(vars[promotedKey]) : null,
    });
  });

  // Two-phase write: header first (then flag), rows second.
  try {
    if (toWriteHeader) {
      await appendRows(accessToken, collection.spreadsheet_id, quotedTitle, [toWriteHeader]);
      await db.from("all_sheet_flow_tabs").update({ header_written: true }).eq("id", tab.id);
    }
    await appendRows(accessToken, collection.spreadsheet_id, quotedTitle, toWriteRows);
  } catch (err) {
    await logFailure(db, tab, collection.account_id, tab.flow_id, null, null, { count: toWriteRows.length }, err);
    throw err;
  }
  try {
    await setSheetColumnHidden(accessToken, collection.spreadsheet_id, tab.worksheet_title, runIdCol, true);
  } catch (err) {
    console.error("[all-sheets] could not hide Run ID column:", err);
  }

  await db
    .from("all_sheet_flow_tabs")
    .update({ header_written: true, updated_at: new Date().toISOString() })
    .eq("id", tab.id);
  await markSynced(db, tab.id, fresh.map((r) => r.id));
  return { imported: fresh.length };
}

/**
 * Which of the given run ids already have a row in the tab (via the
 * hidden Flow Run ID column). Empty set when the header is absent —
 * nothing could have been written yet.
 */
export async function findIncompleteRowsPresent(
  accessToken: string,
  spreadsheetId: string,
  rawWorksheetTitle: string,
  runIds: string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const runIdCol = await findHeaderColumn(
    accessToken,
    spreadsheetId,
    quoteSheetTitle(rawWorksheetTitle),
    INCOMPLETE_RUN_ID_HEADER,
  ).catch(() => null);
  if (runIdCol === null) return new Set();
  const found = await findExactValueRows(
    accessToken,
    spreadsheetId,
    quoteSheetTitle(rawWorksheetTitle),
    runIdCol,
    runIds,
  ).catch(() => new Map<string, number>());
  return new Set(found.keys());
}

export async function findCompletedRowsPresent(
  accessToken: string,
  spreadsheetId: string,
  rawWorksheetTitle: string,
  runIds: string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const runIdCol = await findHeaderColumn(
    accessToken,
    spreadsheetId,
    quoteSheetTitle(rawWorksheetTitle),
    COMPLETED_RUN_ID_HEADER,
  ).catch(() => null);
  if (runIdCol === null) return new Set();
  const found = await findExactValueRows(
    accessToken,
    spreadsheetId,
    quoteSheetTitle(rawWorksheetTitle),
    runIdCol,
    runIds,
  ).catch(() => new Map<string, number>());
  return new Set(found.keys());
}

/**
 * Remove completed run rows from this flow's OWN tab in the INCOMPLETE
 * collection. Only reads/writes all_sheet_* + that tab's own spreadsheet.
 */
async function cleanupAllSheetIncompleteForRuns(
  db: SupabaseClient,
  completedCollection: AllSheetCollectionRow,
  completedRunIds: string[],
  accessToken: string,
): Promise<void> {
  if (completedRunIds.length === 0) return;

  // Find the same account's incomplete collection. Flow identity comes
  // from the runs themselves below, not from any shared watermark.
  const { data: incCollection } = await db
    .from("all_sheet_collections")
    .select("*")
    .eq("account_id", completedCollection.account_id)
    .eq("kind", "incomplete")
    .maybeSingle<AllSheetCollectionRow>();
  if (!incCollection) return;

  // Determine which completed flow(s) these runs belong to via the runs
  // themselves (not via any existing-system watermark).
  const { data: runs } = await db
    .from("flow_runs")
    .select("id, flow_id")
    .in("id", completedRunIds);
  const flowIds = [...new Set(((runs ?? []) as Array<{ flow_id: string }>).map((r) => r.flow_id))];
  if (flowIds.length === 0) return;

  const { data: incTabs } = await db
    .from("all_sheet_flow_tabs")
    .select("*")
    .eq("collection_id", incCollection.id)
    .in("flow_id", flowIds);
  if (!incTabs || incTabs.length === 0) return;

  for (const inc of incTabs as AllSheetFlowTabRow[]) {
    const { data: states } = await db
      .from("all_sheet_tab_run_state")
      .select("flow_run_id")
      .eq("tab_id", inc.id)
      .in("flow_run_id", completedRunIds);
    const keyed = (states ?? []).map((s) => s.flow_run_id as string);
    if (keyed.length === 0) continue;
    await removeRunsFromIncompleteTab(db, incCollection, inc, accessToken, keyed).catch((err) =>
      console.error("[all-sheets] own cleanup failed:", err),
    );
  }
}

/**
 * Remove specific run rows from one incomplete tab (located by the hidden
 * Flow Run ID column — the stable per-run identity, never name/phone/time)
 * and clear their tab state. Rows already absent are treated as removed
 * (state still cleared) so a missing row never blocks the completed append
 * and never retries forever. Never throws for missing rows; throws on
 * Google/DB failures so callers can log + retry.
 */
export async function removeRunsFromIncompleteTab(
  db: SupabaseClient,
  incCollection: AllSheetCollectionRow,
  inc: AllSheetFlowTabRow,
  accessToken: string,
  runIds: string[],
): Promise<{ removed: number }> {
  if (runIds.length === 0) return { removed: 0 };
  const runIdCol = await findHeaderColumn(
    accessToken,
    incCollection.spreadsheet_id,
    quoteSheetTitle(inc.worksheet_title),
    INCOMPLETE_RUN_ID_HEADER,
  );
  if (runIdCol === null) return { removed: 0 };
  const rowsByRun = await findExactValueRows(
    accessToken,
    incCollection.spreadsheet_id,
    quoteSheetTitle(inc.worksheet_title),
    runIdCol,
    runIds,
  );
  const rowNumbers = [...rowsByRun.values()];
  if (rowNumbers.length > 0) {
    await deleteSheetRows(accessToken, incCollection.spreadsheet_id, inc.worksheet_title, rowNumbers);
  }
  await db.from("all_sheet_tab_run_state").delete().eq("tab_id", inc.id).in("flow_run_id", runIds);
  return { removed: rowNumbers.length };
}

/**
 * Delete/unlink a flow tab. Lifecycle (per account × kind):
 *   1. Remove the tab's run-state rows + tab row (DB is source of truth).
 *   2. Count remaining tabs in the collection.
 *   3. Tabs remain → delete only this Drive worksheet tab by stable
 *      sheetId (best effort); the shared spreadsheet lives on.
 *   4. Zero remain → delete the Drive spreadsheet itself, then the
 *      collection row. Zero tabs = no spreadsheet; no Sheet1 or
 *      placeholder is ever left behind. The collection-row delete is
 *      authoritative: it happens even if the Drive call failed (a dead
 *      row would brick future Adds; getOrCreateCollection also heals
 *      Drive-deleted spreadsheets on 404).
 * Never touches existing Sheets.
 */
export async function deleteFlowTab(
  db: SupabaseClient,
  collection: AllSheetCollectionRow,
  tab: AllSheetFlowTabRow,
  accessToken: string,
): Promise<{ spreadsheetDeleted: boolean }> {
  await db.from("all_sheet_tab_run_state").delete().eq("tab_id", tab.id);
  const { error } = await db.from("all_sheet_flow_tabs").delete().eq("id", tab.id);
  if (error) throw error;

  const { data: remaining } = await db
    .from("all_sheet_flow_tabs")
    .select("id")
    .eq("collection_id", collection.id);

  if ((remaining ?? []).length > 0) {
    if (tab.worksheet_id != null) {
      try {
        await deleteWorksheetTab(accessToken, collection.spreadsheet_id, tab.worksheet_id);
      } catch (err) {
        // The tab may already be gone in Drive (deleted by hand). Log and
        // continue — the DB row is already gone so the UI stays correct.
        console.error("[all-sheets] Drive tab delete failed:", err);
      }
    }
    return { spreadsheetDeleted: false };
  }

  try {
    await deleteSpreadsheet(accessToken, collection.spreadsheet_id);
  } catch (err) {
    console.error(
      "[all-sheets] Drive spreadsheet delete failed, continuing with collection cleanup:",
      err,
    );
  }
  const { error: collectionError } = await db
    .from("all_sheet_collections")
    .delete()
    .eq("id", collection.id);
  if (collectionError) throw collectionError;
  return { spreadsheetDeleted: true };
}
