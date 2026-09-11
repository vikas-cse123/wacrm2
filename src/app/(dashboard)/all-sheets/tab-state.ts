// All Sheets flow-tab UI state (pure helpers, no React).
//
// Two different levels of sheet links exist and must never be confused:
//
//   1. COLLECTION-LEVEL: the shared spreadsheet for (account, kind).
//      Shown as "View Sheet" on the shared-spreadsheet card. It may remain
//      visible with ZERO flow tabs — deleting the final tab must not
//      delete the collection spreadsheet.
//
//   2. FLOW-LEVEL: one worksheet/tab per flow. Shown as "Open Sheet" inside
//      the selected flow card, ONLY when that flow has an actual
//      all_sheet_flow_tabs record.
//
// Source of truth for "flow is added" = existence of the tab record.
// collection exists ≠ flow is added.

export interface FlowTabRef {
  id: string;
  worksheet_id: number | null;
  worksheet_title: string;
}

export type FlowTabUiState = "not-added" | "added";

/** A flow is added to All Sheets iff its tab record exists. */
export function flowTabUiState(tab: FlowTabRef | null | undefined): FlowTabUiState {
  return tab ? "added" : "not-added";
}

/**
 * Flow-level "Open Sheet" href. Returns null unless the flow has a tab
 * record — callers render "Add to All Sheets" instead in that case.
 * When the stable worksheet id is known, deep-links straight to the tab
 * (`#gid=`); otherwise falls back to the shared spreadsheet URL.
 */
export function flowTabSheetHref(
  spreadsheetUrl: string | null | undefined,
  tab: FlowTabRef | null | undefined,
): string | null {
  if (!tab || !spreadsheetUrl) return null;
  const base = spreadsheetUrl.split("#")[0] ?? spreadsheetUrl;
  if (tab.worksheet_id == null) return base;
  return `${base}#gid=${tab.worksheet_id}`;
}
