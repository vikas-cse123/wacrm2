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
import { updateTabHeaderCells } from "@/lib/google/tabs";
import {
  deriveFlowColumns,
  orderNodesForSheets,
  type FlowNodeLite,
} from "@/lib/flows/sheet-columns";
import { completedAnswerOffset } from "@/lib/flows/sheet-layout";
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
    !!nameHeaderRenamed;

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
