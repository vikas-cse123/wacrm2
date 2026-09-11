// All Sheets — isolated types (collection/tab model).
//
// Reads/writes ONLY all_sheet_* tables:
//   all_sheet_collections, all_sheet_flow_tabs,
//   all_sheet_tab_run_state, all_sheet_tab_sync_failures.
// Never touches flow_sheet_configs, flow_incomplete_sheet_configs,
// google_sheets_sync_failures, or flow_runs.incomplete_synced_at.

export type AllSheetKind = "completed" | "incomplete";

/** One row per (account_id, kind). Owns the ONE spreadsheet for the kind. */
export interface AllSheetCollectionRow {
  id: string;
  account_id: string;
  kind: AllSheetKind;
  spreadsheet_id: string;
  spreadsheet_url: string | null;
  spreadsheet_name: string | null;
  created_at?: string;
  updated_at?: string;
}

/** One row per (collection_id, flow_id). One worksheet/tab per flow. */
export interface AllSheetFlowTabRow {
  id: string;
  collection_id: string;
  flow_id: string;
  /** Stable Google sheetId — the ONLY safe worksheet identity. */
  worksheet_id: number | null;
  /** Display title. May drift from the flow name; never identity. */
  worksheet_title: string;
  answer_columns: string[];
  answer_headers: string[];
  header_written: boolean;
  schema_version: number | null;
  name_column_key: string | null;
  name_column_header: string | null;
  display_order: number | null;
  created_at?: string;
  updated_at?: string;
}

export const ALL_SHEET_COMPLETED_SCHEMA_VERSION = 3;
export const ALL_SHEET_INCOMPLETE_SCHEMA_VERSION = 6;

/** Terminal statuses that count as incomplete (mirrors existing contract). */
export const ALL_SHEET_INCOMPLETE_STATUSES = [
  "timed_out",
  "failed",
  "handed_off",
] as const;

export function schemaVersionForKind(kind: AllSheetKind): number {
  return kind === "completed"
    ? ALL_SHEET_COMPLETED_SCHEMA_VERSION
    : ALL_SHEET_INCOMPLETE_SCHEMA_VERSION;
}
