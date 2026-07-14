// ============================================================
// Self-healing column sync — reconciles a flow's linked Google Sheet
// against its CURRENT nodes on every send, so a question added (or
// newly marked "include in sheet") after the sheet was linked shows up
// on the very next completed run, with no manual relink required.
//
// Two kinds of healing:
//   - New columns are APPENDED at the end — existing column positions
//     are never reordered or removed, so already-written rows stay
//     aligned under whatever header they were written against.
//   - An EXISTING column's header text is rewritten in place (single
//     cell) when the node's custom column name changes — position and
//     data are untouched, only the label.
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
  /**
   * ALL trailing answer columns, in stable append order. Used for
   * positioning/alignment with the live sheet (so indices are stable).
   * Some may be inactive (sheet_include: false turned off after they were added).
   */
  keys: string[];
  headers: string[];
  /**
   * Only the ACTIVE columns (sheet_include !== false). Use this when
   * building row values — synced to `keys` by position for alignment,
   * but only `activeKeys` actually get non-empty values written.
   */
  activeKeys: Set<string>;
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

  // Append new trailing columns; detect renames on ones already stored.
  const newCols = restCandidates.filter((c) => !storedKeySet.has(c.key));
  const freshHeaderByKey = new Map(restCandidates.map((c) => [c.key, c.header]));

  // activeKeys: which columns should receive new data (sheet_include !== false).
  // Built from freshHeaderByKey because deriveFlowColumns skips sheet_include: false.
  const activeKeys = new Set(freshHeaderByKey.keys());

  const mergedHeaders = storedKeys.map((k, i) => freshHeaderByKey.get(k) ?? storedHeaders[i]);
  const renamedIndices: number[] = [];
  storedKeys.forEach((k, i) => {
    const fresh = freshHeaderByKey.get(k);
    if (fresh && fresh !== storedHeaders[i]) renamedIndices.push(i);
  });

  const mergedKeys = [...storedKeys, ...newCols.map((c) => c.key)];
  mergedHeaders.push(...newCols.map((c) => c.header));

  const nameSlotChanged =
    nameKey !== (sheet.name_column_key ?? null) ||
    nameHeader !== (sheet.name_column_header ?? null);
  const nameHeaderRenamed =
    !nameSlotChanged &&
    nameKey &&
    promoteName &&
    derived.name?.key === nameKey &&
    derived.name.header !== nameHeader;
  const effectiveNameHeader = nameHeaderRenamed ? derived.name!.header : nameHeader;

  const columnsChanged =
    newCols.length > 0 ||
    nameSlotChanged ||
    renamedIndices.length > 0 ||
    !!nameHeaderRenamed;

  if (!columnsChanged) {
    return {
      sheet,
      nameKey,
      nameHeader,
      keys: storedKeys,
      headers: storedHeaders,
      activeKeys,
    };
  }

  // Push header-cell writes for the live sheet: appended columns at the
  // end, renamed columns in place at their existing position.
  if (sheet.header_written && accessToken) {
    const standardLen = promoteName ? 4 : 5; // STANDARD_COLUMNS_V2 / V1
    const nameOffset = nameKey ? 1 : 0;
    const baseOffset = nameOffset + standardLen;

    const cellUpdates: Array<{ colIndex: number; value: string }> = [];
    for (const i of renamedIndices) {
      cellUpdates.push({ colIndex: baseOffset + i, value: mergedHeaders[i] });
    }
    newCols.forEach((c, i) => {
      cellUpdates.push({ colIndex: baseOffset + storedKeys.length + i, value: c.header });
    });
    if (nameHeaderRenamed) {
      cellUpdates.push({ colIndex: 0, value: effectiveNameHeader! });
    }

    if (cellUpdates.length > 0) {
      try {
        await updateHeaderCells(accessToken, sheet.spreadsheet_id, sheet.sheet_tab, cellUpdates);
      } catch (err) {
        // Non-fatal — persisted state below still gets updated so the next
        // sync retries the header write; only the label edit failed here.
        console.error("[sheet-sync] header update failed:", err);
      }
    }
  }

  const { data: updated } = await db
    .from("flow_sheet_configs")
    .update({
      answer_columns: mergedKeys,
      answer_headers: mergedHeaders,
      name_column_key: nameKey,
      name_column_header: effectiveNameHeader,
      updated_at: new Date().toISOString(),
    })
    .eq("flow_id", flowId)
    .select()
    .single<FlowSheetConfigRow>();

  return {
    sheet: updated ?? sheet,
    nameKey,
    nameHeader: effectiveNameHeader,
    keys: mergedKeys,
    headers: mergedHeaders,
    activeKeys,
  };
}
