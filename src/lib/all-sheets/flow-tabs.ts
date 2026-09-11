// All Sheets — isolated flow-tab orchestration (collection/tab model).
//
// A flow NEVER causes a spreadsheet to be created: adding a flow ensures
// the ONE collection spreadsheet for (account, kind) exists, then creates
// (or adopts/renames) exactly one worksheet/tab inside it.
//
// Owns ONLY: all_sheet_flow_tabs (+ collections via ./collections).
// Tab creation writes the header row only — historical runs are imported
// exclusively through the explicit Import operation, never on tab create.

import type { SupabaseClient } from "@supabase/supabase-js";
import { appendRows } from "@/lib/google/sheets";
import {
  ensureWorksheetTab,
  quoteSheetTitle,
  sanitizeWorksheetTitle,
} from "@/lib/google/tabs";
import {
  deriveFlowColumns,
  orderNodesForSheets,
  type FlowNodeLite,
} from "@/lib/flows/sheet-columns";
import {
  buildCompletedHeader,
  buildIncompleteHeader,
} from "@/lib/flows/sheet-layout";
import type {
  AllSheetCollectionRow,
  AllSheetFlowTabRow,
  AllSheetKind,
} from "./types";
import { schemaVersionForKind } from "./types";

/** Fetch the tab for (collection, flow), or null when never added. */export async function getFlowTab(
  db: SupabaseClient,
  collectionId: string,
  flowId: string,
): Promise<AllSheetFlowTabRow | null> {
  const { data, error } = await db
    .from("all_sheet_flow_tabs")
    .select("*")
    .eq("collection_id", collectionId)
    .eq("flow_id", flowId)
    .maybeSingle<AllSheetFlowTabRow>();
  if (error) throw error;
  return data ?? null;
}

/**
 * Ensure the flow's worksheet/tab inside an EXISTING collection.
 * Reuses the stored tab (by worksheet_id), adopts a same-titled tab,
 * renames a lone default Sheet1, or adds a fresh tab — then persists the
 * tab row and writes the header row (runs are NOT imported here).
 */
export async function ensureFlowTab(
  db: SupabaseClient,
  collection: AllSheetCollectionRow,
  kind: AllSheetKind,
  flowId: string,
  flowName: string,
  accessToken: string,
): Promise<{ tab: AllSheetFlowTabRow; created: boolean }> {
  const existing = await getFlowTab(db, collection.id, flowId);
  if (existing?.worksheet_id != null) {
    // Re-resolve against the live spreadsheet so a Drive-side deletion is
    // healed instead of silently appending into the void.
    const ensured = await ensureWorksheetTab(
      accessToken,
      collection.spreadsheet_id,
      existing.worksheet_title,
      { storedWorksheetId: existing.worksheet_id, renameDefaultSheet: false },
    );
    if (ensured.worksheetId !== existing.worksheet_id || ensured.title !== existing.worksheet_title) {
      const { data: updated } = await db
        .from("all_sheet_flow_tabs")
        .update({
          worksheet_id: ensured.worksheetId,
          worksheet_title: ensured.title,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single<AllSheetFlowTabRow>();
      return { tab: updated ?? existing, created: false };
    }
    return { tab: existing, created: false };
  }

  const { data: nodes } = await db
    .from("flow_nodes")
    .select("node_key, node_type, config, created_at")
    .eq("flow_id", flowId)
    .order("created_at", { ascending: true });
  const { data: flow } = await db
    .from("flows")
    .select("entry_node_id")
    .eq("id", flowId)
    .maybeSingle();
  const ordered = orderNodesForSheets(
    (flow as { entry_node_id?: string | null } | null)?.entry_node_id ?? null,
    (nodes ?? []) as FlowNodeLite[],
  );
  const derived = deriveFlowColumns(ordered, true);

  const desiredTitle = sanitizeWorksheetTitle(flowName, `Flow ${flowId.slice(0, 8)}`);
  const ensured = await ensureWorksheetTab(
    accessToken,
    collection.spreadsheet_id,
    desiredTitle,
    { storedWorksheetId: null, renameDefaultSheet: true },
  );

  const schemaVersion = schemaVersionForKind(kind);
  const answerColumns = derived.rest.map((c) => c.key);
  const answerHeaders = derived.rest.map((c) => c.header);
  const nameKey = derived.name?.key ?? null;
  const nameHeader = derived.name?.header ?? null;

  const headerRow =
    kind === "completed"
      ? buildCompletedHeader({
          schemaVersion,
          nameHeader,
          nameValue: null,
          contactPhone: "",
          flowName: "",
          submissionTime: "",
          contactId: "",
          answerKeys: answerColumns,
          answerHeaders,
          activeKeys: new Set(answerColumns),
          vars: {},
        })
      : buildIncompleteHeader(schemaVersion, answerColumns, answerHeaders, nameHeader);

  // Header only — never historical runs. Import is explicit.
  await appendRows(
    accessToken,
    collection.spreadsheet_id,
    quoteSheetTitle(ensured.title),
    [headerRow],
  );

  const { data: tab, error } = await db
    .from("all_sheet_flow_tabs")
    .insert({
      collection_id: collection.id,
      flow_id: flowId,
      worksheet_id: ensured.worksheetId,
      worksheet_title: ensured.title,
      answer_columns: answerColumns,
      answer_headers: answerHeaders,
      header_written: true,
      schema_version: schemaVersion,
      name_column_key: nameKey,
      name_column_header: nameHeader,
    })
    .select()
    .single<AllSheetFlowTabRow>();
  if (error) {
    // Lost an add-tab race for the same flow (UNIQUE collection/flow):
    // re-read the winner. The extra Drive tab is harmless leftover.
    if ((error as { code?: string } | null)?.code === "23505") {
      const winner = await getFlowTab(db, collection.id, flowId);
      if (winner) return { tab: winner, created: false };
    }
    throw error;
  }
  if (!tab) throw new Error("Failed to save All Sheets flow tab");
  return { tab, created: true };
}

/**
 * Re-resolve an existing tab row against the live spreadsheet (by stored
 * worksheet_id, falling back to title adoption), persisting observed
 * drift. Used by the background worker and completion handler so a
 * Drive-side tab deletion is healed instead of appending into the void.
 * Never renames the default Sheet1 here (creation-time concern only);
 * a wholly absent tab is re-created with the stored title.
 */
export async function resolveAllTabWorksheet(
  db: SupabaseClient,
  collection: AllSheetCollectionRow,
  tab: AllSheetFlowTabRow,
  accessToken: string,
): Promise<AllSheetFlowTabRow> {
  const ensured = await ensureWorksheetTab(
    accessToken,
    collection.spreadsheet_id,
    tab.worksheet_title,
    { storedWorksheetId: tab.worksheet_id, renameDefaultSheet: false },
  );
  if (ensured.worksheetId === tab.worksheet_id && ensured.title === tab.worksheet_title) {
    return tab;
  }
  const { data: updated } = await db
    .from("all_sheet_flow_tabs")
    .update({
      worksheet_id: ensured.worksheetId,
      worksheet_title: ensured.title,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tab.id)
    .select()
    .single<AllSheetFlowTabRow>();
  return updated ?? tab;
}
