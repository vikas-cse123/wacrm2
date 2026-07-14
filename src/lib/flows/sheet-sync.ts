// ============================================================
// Self-healing column sync — reconciles a flow's linked Google Sheet
// against its CURRENT nodes on every send, so a question added (or
// newly marked "include in sheet") after the sheet was linked shows up
// on the very next completed run, with no manual relink required.
//
// Only ever APPENDS new trailing columns — existing column positions
// are never reordered or removed, so already-written rows stay aligned
// under whatever header they were written against.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveFlowColumns, type FlowNodeLite } from "./sheet-columns";
import { updateHeaderCells } from "@/lib/google/sheets";

export interface FlowSheetConfigRow {
  flow_id: string;
  account_id: string;
  spreadsheet_id: string;
  spreadsheet_url: string | null;
  spreadsheet_name: string | null;
  sheet_tab: string;
  answer_columns: string[];
  answer_headers: string[];
  header_written: boolean;
  schema_version?: number | null;
  name_column_key?: string | null;
  name_column_header?: string | null;
}

export interface ResolvedFlowSheetColumns {
  sheet: FlowSheetConfigRow;
  /** Var key promoted to the leading Name slot, or null if there isn't one. */
  nameKey: string | null;
  nameHeader: string | null;
  /** Trailing answer columns, in stable append order. */
  keys: string[];
  headers: string[];
}

/**
 * Load the flow's sheet config, reconcile its stored column list against
 * the flow's current nodes, persist + (if the header row already exists)
 * extend the live sheet's header with any newly-found columns, and
 * return the authoritative column set to build the row from.
 *
 * `accessToken` is required only to extend an ALREADY-written header;
 * pass null to skip that (the merge is still persisted — the new
 * column's data will land correctly positioned, just without a header
 * label until a token is available on a later sync).
 */
export async function resolveFlowSheetColumns(
  db: SupabaseClient,
  flowId: string,
  accessToken: string | null,
): Promise<ResolvedFlowSheetColumns | null> {
  const { data: sheet } = await db
    .from("flow_sheet_configs")
    .select("*")
    .eq("flow_id", flowId)
    .maybeSingle<FlowSheetConfigRow>();
  if (!sheet) return null;

  const { data: nodes } = await db
    .from("flow_nodes")
    .select("node_key, node_type, config")
    .eq("flow_id", flowId)
    .order("created_at", { ascending: true });

  const schemaVersion = sheet.schema_version ?? 1;
  const promoteName = schemaVersion >= 2;
  const derived = deriveFlowColumns((nodes ?? []) as FlowNodeLite[], promoteName);

  const storedKeys = sheet.answer_columns ?? [];
  const storedHeaders = sheet.answer_headers ?? [];
  const storedKeySet = new Set(storedKeys);

  // Resolve the name slot.
  let nameKey = sheet.name_column_key ?? null;
  let nameHeader = sheet.name_column_header ?? null;
  let restCandidates = derived.rest;

  if (promoteName && !nameKey && derived.name) {
    if (!sheet.header_written) {
      // Header hasn't been written yet — safe to adopt the name slot.
      nameKey = derived.name.key;
      nameHeader = derived.name.header;
    } else {
      // Header already exists without a name slot; promoting now would
      // reflow every column. Fold it in as a normal trailing column
      // instead so it's still visible.
      restCandidates = [derived.name, ...restCandidates];
    }
  }

  // Append-only merge for the trailing columns.
  const newCols = restCandidates.filter((c) => !storedKeySet.has(c.key));
  const mergedKeys = [...storedKeys, ...newCols.map((c) => c.key)];
  const mergedHeaders = [...storedHeaders, ...newCols.map((c) => c.header)];

  const nameSlotChanged =
    nameKey !== (sheet.name_column_key ?? null) ||
    nameHeader !== (sheet.name_column_header ?? null);
  const columnsChanged = newCols.length > 0 || nameSlotChanged;

  if (!columnsChanged) {
    return {
      sheet,
      nameKey,
      nameHeader,
      keys: storedKeys,
      headers: storedHeaders,
    };
  }

  // Extend the live header row if it's already been written.
  if (sheet.header_written && accessToken && newCols.length > 0) {
    const standardLen = promoteName ? 4 : 5; // STANDARD_COLUMNS_V2 / V1
    const nameOffset = nameKey ? 1 : 0;
    const baseOffset = nameOffset + standardLen + storedKeys.length;
    try {
      await updateHeaderCells(
        accessToken,
        sheet.spreadsheet_id,
        sheet.sheet_tab,
        newCols.map((c, i) => ({ colIndex: baseOffset + i, value: c.header })),
      );
    } catch (err) {
      // Non-fatal — the column still gets persisted below and its data
      // still lands in the right position; only the header label write
      // failed. Logged for visibility, not thrown.
      console.error("[sheet-sync] header extend failed:", err);
    }
  }

  const { data: updated } = await db
    .from("flow_sheet_configs")
    .update({
      answer_columns: mergedKeys,
      answer_headers: mergedHeaders,
      name_column_key: nameKey,
      name_column_header: nameHeader,
      updated_at: new Date().toISOString(),
    })
    .eq("flow_id", flowId)
    .select()
    .single<FlowSheetConfigRow>();

  return {
    sheet: updated ?? sheet,
    nameKey,
    nameHeader,
    keys: mergedKeys,
    headers: mergedHeaders,
  };
}
