// All Sheets — isolated column derivation + header healing (tab model).
//
// Intentionally does NOT import from:
//   @/lib/flows/sheet-sync (resolveFlowSheetColumns)
//   @/lib/flows/incomplete-sheet-sync
//   @/lib/flows/engine
// Those own the PROTECTED Google Sheets state. This module operates
// only on all_sheet_flow_tabs rows passed in by callers, inside the
// tab's OWN collection spreadsheet.
//
// Safe to reuse (stateless/pure):
//   sheet-columns.ts, sheet-layout.ts, google/sheets.ts, google/tabs.ts

import type { SupabaseClient } from "@supabase/supabase-js";
import { setSheetColumnHidden } from "@/lib/google/sheets";
import { updateTabHeaderCells } from "@/lib/google/tabs";
import {
  deriveFlowColumns,
  orderNodesForSheets,
  type FlowNodeLite,
} from "@/lib/flows/sheet-columns";
import { completedAnswerOffset } from "@/lib/flows/sheet-layout";
import {
  ASSIGN_HEADER,
  ASSIGN_KEY,
  COMPLETED_RUN_ID_HEADER,
  COMPLETED_RUN_ID_KEY,
} from "@/lib/automations/assignment";
import type { AllSheetFlowTabRow } from "./types";

export interface ResolvedAllTabColumns {
  tab: AllSheetFlowTabRow;
  nameKey: string | null;
  nameHeader: string | null;
  keys: string[];
  headers: string[];
  activeKeys: Set<string>;
}

/**
 * Reconcile an All Sheets flow tab against the flow's CURRENT question
 * nodes. Appends new columns at the end, renames in place. Persists to
 * all_sheet_flow_tabs only and patches the live tab header (addressed by
 * quoted tab title) inside the tab's OWN collection spreadsheet.
 */
export async function resolveAllTabColumns(
  db: SupabaseClient,
  tab: AllSheetFlowTabRow,
  spreadsheetId: string,
  accessToken: string | null,
  opts?: { includeAssign?: boolean },
): Promise<ResolvedAllTabColumns> {
  const [{ data: nodes }, { data: flow }] = await Promise.all([
    db
      .from("flow_nodes")
      .select("node_key, node_type, config, created_at")
      .eq("flow_id", tab.flow_id)
      .order("created_at", { ascending: true }),
    db.from("flows").select("entry_node_id").eq("id", tab.flow_id).maybeSingle(),
  ]);

  const orderedNodes = orderNodesForSheets(
    (flow as { entry_node_id?: string | null } | null)?.entry_node_id ?? null,
    (nodes ?? []) as FlowNodeLite[],
  );
  const derived = deriveFlowColumns(orderedNodes, true);

  const storedKeys = tab.answer_columns ?? [];
  const storedHeaders = tab.answer_headers ?? [];
  const storedKeySet = new Set(storedKeys);

  let nameKey = tab.name_column_key ?? null;
  let nameHeader = tab.name_column_header ?? null;
  let restCandidates = derived.rest;

  if (!nameKey && derived.name) {
    if (!tab.header_written) {
      nameKey = derived.name.key;
      nameHeader = derived.name.header;
    } else {
      restCandidates = [derived.name, ...restCandidates];
    }
  }

  const newCols = restCandidates.filter((c) => !storedKeySet.has(c.key));
  const freshHeaderByKey = new Map(restCandidates.map((c) => [c.key, c.header]));
  const activeKeys = new Set(freshHeaderByKey.keys());

  const mergedHeaders = storedKeys.map(
    (k, i) => freshHeaderByKey.get(k) ?? storedHeaders[i] ?? k,
  );
  const renamedIndices: number[] = [];
  storedKeys.forEach((k, i) => {
    const fresh = freshHeaderByKey.get(k);
    if (fresh && fresh !== storedHeaders[i]) renamedIndices.push(i);
  });

  const mergedKeys = [...storedKeys, ...newCols.map((c) => c.key)];
  mergedHeaders.push(...newCols.map((c) => c.header));

  // Assign enrichment (069): trailing Assign + hidden Flow Run ID for
  // already-synced Completed row updates. Conditional only — tabs
  // without assignments keep byte-identical layouts.
  const assignExtra: Array<{ key: string; header: string }> = [];
  if (
    opts?.includeAssign &&
    (!storedKeySet.has(ASSIGN_KEY) || !storedKeySet.has(COMPLETED_RUN_ID_KEY))
  ) {
    if (!storedKeySet.has(ASSIGN_KEY) && !mergedKeys.includes(ASSIGN_KEY)) {
      assignExtra.push({ key: ASSIGN_KEY, header: ASSIGN_HEADER });
    }
    if (!storedKeySet.has(COMPLETED_RUN_ID_KEY) && !mergedKeys.includes(COMPLETED_RUN_ID_KEY)) {
      assignExtra.push({ key: COMPLETED_RUN_ID_KEY, header: COMPLETED_RUN_ID_HEADER });
    }
    for (const c of assignExtra) {
      mergedKeys.push(c.key);
      mergedHeaders.push(c.header);
      activeKeys.add(c.key);
    }
  } else {
    if (storedKeySet.has(ASSIGN_KEY)) activeKeys.add(ASSIGN_KEY);
    if (storedKeySet.has(COMPLETED_RUN_ID_KEY)) activeKeys.add(COMPLETED_RUN_ID_KEY);
  }

  const nameSlotChanged =
    nameKey !== (tab.name_column_key ?? null) ||
    nameHeader !== (tab.name_column_header ?? null);
  const nameHeaderRenamed =
    !nameSlotChanged &&
    !!nameKey &&
    derived.name?.key === nameKey &&
    derived.name.header !== nameHeader;
  const effectiveNameHeader = nameHeaderRenamed ? derived.name!.header : nameHeader;

  const changed =
    newCols.length > 0 ||
    nameSlotChanged ||
    renamedIndices.length > 0 ||
    !!nameHeaderRenamed ||
    assignExtra.length > 0;

  if (!changed) {
    return {
      tab,
      nameKey,
      nameHeader,
      keys: storedKeys,
      headers: storedHeaders,
      activeKeys,
    };
  }

  if (tab.header_written && accessToken) {
    const baseOffset = completedAnswerOffset(tab.schema_version ?? 3, !!nameKey);
    const cellUpdates: Array<{ colIndex: number; value: string }> = [];
    for (const i of renamedIndices) {
      cellUpdates.push({ colIndex: baseOffset + i, value: mergedHeaders[i]! });
    }
    newCols.forEach((c, i) => {
      cellUpdates.push({
        colIndex: baseOffset + storedKeys.length + i,
        value: c.header,
      });
    });
    assignExtra.forEach((c, i) => {
      cellUpdates.push({
        colIndex: baseOffset + storedKeys.length + newCols.length + i,
        value: c.header,
      });
    });
    if (nameHeaderRenamed && effectiveNameHeader) {
      cellUpdates.push({ colIndex: 0, value: effectiveNameHeader });
    }
    if (cellUpdates.length > 0) {
      try {
        // Raw title: updateTabHeaderCells quotes it for literal A1 in the
        // request body (flow names may contain spaces, `+`, unicode,
        // punctuation). Never pre-quote or URL-encode here.
        await updateTabHeaderCells(
          accessToken,
          spreadsheetId,
          tab.worksheet_title,
          cellUpdates,
        );
      } catch (err) {
        console.error("[all-sheets] tab header update failed:", err);
      }
    }

    if (assignExtra.some((c) => c.key === COMPLETED_RUN_ID_KEY)) {
      try {
        const runIdCol = baseOffset + mergedKeys.length - 1;
        await setSheetColumnHidden(
          accessToken,
          spreadsheetId,
          tab.worksheet_title,
          runIdCol,
          true,
        );
      } catch (err) {
        console.error("[all-sheets] could not hide Completed Run ID column:", err);
      }
    }
  }

  const { data: updated } = await db
    .from("all_sheet_flow_tabs")
    .update({
      answer_columns: mergedKeys,
      answer_headers: mergedHeaders,
      name_column_key: nameKey,
      name_column_header: effectiveNameHeader,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tab.id)
    .select()
    .single<AllSheetFlowTabRow>();

  return {
    tab: updated ?? tab,
    nameKey,
    nameHeader: effectiveNameHeader,
    keys: mergedKeys,
    headers: mergedHeaders,
    activeKeys,
  };
}
