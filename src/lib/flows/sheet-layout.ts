// ============================================================
// Versioned sheet layouts — pure header/row builders shared by every
// Google Sheets writer (live completed sync, backfill, import,
// dropped-off export, incomplete live sync).
//
// V1/V2 layouts are frozen byte-for-byte: existing sheets keep writing
// rows that align with the headers they were created with. V3 (new
// sheets only) omits the display-only "Flow Name" and "User ID" cells.
//
// Incomplete sheets always keep the hidden "Flow Run ID" column last —
// it is the stable cleanup key (see incomplete-sheet-cleanup.ts) and
// must never shift in front of answer columns.
// ============================================================

import {
  CURRENT_SHEET_SCHEMA_VERSION,
  standardColumnsForSchemaVersion,
} from "@/lib/google/sheets";
import { deriveFlowColumns, type FlowNodeLite } from "./sheet-columns";

/**
 * Hidden trailing column on incomplete sheets — the stable row key used
 * by incomplete-sheet-cleanup.ts to delete exactly the run that later
 * completed. Always last, always hidden. (Re-exported from
 * incomplete-sheet-sync.ts so existing importers keep working.)
 */
export const INCOMPLETE_RUN_ID_HEADER = "Flow Run ID";

/**
 * Current incomplete-sheet layout version. V6 keeps the V4/V5 slim
 * columns (no Flow Name / User ID) but rearranges the name cells: the
 * flow-collected Name answer is promoted first (mirroring completed
 * sheets) and the contact-profile name moves after the answers as
 * "WhatsApp Name". V2/V3/V4/V5 sheets keep their frozen layouts.
 */
export const CURRENT_INCOMPLETE_SCHEMA_VERSION = 6;

/** Fixed leading header for the contact-profile name cell (V5+ only). */
export const WHATSAPP_NAME_HEADER = "WhatsApp Name";

/** Flatten a stored var into a single cell value for a spreadsheet. */
export function stringifySheetCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Number of standard leading cells for a completed sheet (excludes the optional promoted Name cell). */
export function completedStandardLength(
  schemaVersion: number | null | undefined,
): number {
  return standardColumnsForSchemaVersion(schemaVersion).length;
}

/** 0-based offset where dynamic answer columns start on a completed sheet. */
export function completedAnswerOffset(
  schemaVersion: number | null | undefined,
  hasNameCell: boolean,
): number {
  return (hasNameCell ? 1 : 0) + completedStandardLength(schemaVersion);
}

/** 0-based offset where dynamic answer columns start on an incomplete sheet. V6 has a conditional promoted slot (flag); V4 has none; V5/V2/V3 (and any other version) always have exactly one fixed leading cell. The flag is ignored below V6. */
export function incompleteBaseOffset(
  schemaVersion: number | null | undefined,
  hasPromotedCell = false,
): number {
  const v = schemaVersion ?? 2;
  const leading = v >= 6 ? (hasPromotedCell ? 1 : 0) : v === 4 ? 0 : 1;
  return (
    leading + standardColumnsForSchemaVersion(schemaVersion).length
  );
}

/** Fixed leading header cell for an incomplete sheet: V5 "WhatsApp Name", V4 none, V2/V3 legacy "Name". V6+ has no fixed leading cell — its first slot is the dynamically promoted flow answer (or omitted). */
export function incompleteLeadingHeader(
  schemaVersion: number | null | undefined,
): string | null {
  const v = schemaVersion ?? 2;
  if (v >= 6) return null;
  if (v >= 5) return WHATSAPP_NAME_HEADER;
  if (v >= 4) return null;
  return "Name";
}

/** 0-based index of the hidden Flow Run ID column for a given answer-column list. Always last (V6 counts its trailing WhatsApp cell). The flag is ignored below V6. */
export function incompleteRunIdColumnIndex(
  schemaVersion: number | null | undefined,
  answerColumns: readonly string[],
  hasPromotedCell = false,
): number {
  return (
    incompleteBaseOffset(schemaVersion, hasPromotedCell) +
    answerColumns.length +
    ((schemaVersion ?? 2) >= 6 ? 1 : 0)
  );
}

export interface CompletedLayoutInput {
  schemaVersion: number | null | undefined;
  /** Resolved promoted-name header, or null when the flow captures no name. */
  nameHeader: string | null;
  /** Stringified promoted-name var value, or null when nameHeader is null. */
  nameValue: string | null;
  contactPhone: string;
  /** flows.name snapshot. Ignored for V3 (column removed). */
  flowName: string;
  /** Already IST-formatted submission timestamp. */
  submissionTime: string;
  /** contacts.id snapshot. Ignored for V3 (column removed). */
  contactId: string;
  answerKeys: readonly string[];
  answerHeaders: readonly string[];
  activeKeys: ReadonlySet<string>;
  vars: Record<string, unknown>;
}

/** Header row for a completed sheet — V3 omits Flow Name / User ID. */
export function buildCompletedHeader(input: CompletedLayoutInput): string[] {
  const nameCell = input.nameHeader ? [input.nameHeader] : [];
  return [
    ...nameCell,
    ...standardColumnsForSchemaVersion(input.schemaVersion),
    ...input.answerHeaders,
  ];
}

/** Data row matching buildCompletedHeader position-for-position. */
export function buildCompletedRow(
  input: CompletedLayoutInput,
): (string | number)[] {
  const nameCell = input.nameHeader ? [input.nameValue ?? ""] : [];
  const v = input.schemaVersion ?? 1;
  const standardValues =
    v >= 3
      ? [input.contactPhone, input.submissionTime]
      : v === 2
        ? [input.contactPhone, input.flowName, input.submissionTime, input.contactId]
        : ["", input.contactPhone, input.flowName, input.submissionTime, input.contactId];
  return [
    ...nameCell,
    ...standardValues,
    // Only write to active columns; leave inactive ones (sheet_include: false) empty.
    ...input.answerKeys.map((k) =>
      input.activeKeys.has(k) ? stringifySheetCell(input.vars[k]) : "",
    ),
  ];
}

export interface IncompleteLayoutInput {
  /**
   * Stored schema version. Incomplete configs predate versioning, so
   * nullish means v2 (the layout every existing incomplete sheet was
   * written with — frozen). 3 selects the slim V3 layout (no Flow Name /
   * User ID, leading contact Name kept); 4 additionally drops the fixed
   * leading contact-Name cell; 5 restores it as "WhatsApp Name"; 6
   * promotes the flow-collected Name answer first and moves the contact
   * name after the answers as "WhatsApp Name" (flow-collected Name
   * answers are unaffected in all versions).
   */
  schemaVersion?: number | null;
  contactName: string;
  contactPhone: string;
  /** flows.name snapshot. Ignored for V3+ (column removed). */
  flowName: string;
  /** Already IST-formatted submission timestamp. */
  submissionTime: string;
  /** contacts.id snapshot. Ignored for V3+ (column removed). */
  contactId: string;
  vars: Record<string, unknown>;
  answerColumns: readonly string[];
  runId: string;
  /**
   * V6 adopted promotion: the flow-collected Name answer rendered first.
   * Presence (non-null header) also drives row width, so it must match
   * the live sheet — the caller pins it via the header row, never by
   * re-deriving mid-life. Ignored below V6.
   */
  promotedHeader?: string | null;
  promotedValue?: string | null;
  /**
   * Answer keys whose nodes are switched off via sheet_include=false.
   * Their columns keep their frozen positions (existing sheets) but all
   * future rows write "" there — the completed-sheet activeKeys contract.
   * Unknown keys (deleted nodes, non-question vars) are NOT blanked.
   */
  inactiveKeys?: ReadonlySet<string>;
}

/**
 * Header row for an incomplete sheet — Run ID always last. Answer labels
 * come from `answerHeaders` (human-readable, resolved by the caller via
 * headerByKey); when omitted they default to the raw keys (legacy
 * behavior for already-frozen sheets). Leading slot: V6 promoted flow
 * answer (or omitted), V5 "WhatsApp Name", V4 none, V2/V3 legacy "Name".
 * V6 appends the fixed "WhatsApp Name" cell after the answers.
 */
export function buildIncompleteHeader(
  schemaVersion: number | null | undefined,
  answerColumns: readonly string[],
  answerHeaders: readonly string[] = answerColumns,
  promotedHeader: string | null = null,
): string[] {
  const v = schemaVersion ?? 2;
  const leading =
    v >= 6
      ? promotedHeader != null
        ? [promotedHeader]
        : []
      : (() => {
          const fixed = incompleteLeadingHeader(schemaVersion);
          return fixed ? [fixed] : [];
        })();
  const trailing = v >= 6 ? [WHATSAPP_NAME_HEADER] : [];
  return [
    ...leading,
    ...standardColumnsForSchemaVersion(schemaVersion ?? 2),
    ...answerHeaders,
    ...trailing,
    INCOMPLETE_RUN_ID_HEADER,
  ];
}

/** Data row matching buildIncompleteHeader position-for-position. */
export function buildIncompleteRow(
  input: IncompleteLayoutInput,
): (string | number)[] {
  const v = input.schemaVersion ?? 2;
  const leading =
    v >= 6
      ? input.promotedHeader != null
        ? [input.promotedValue ?? ""]
        : []
      : (() => {
          const fixed = incompleteLeadingHeader(input.schemaVersion);
          return fixed ? [input.contactName] : [];
        })();
  const standardValues =
    v >= 3
      ? [input.contactPhone, input.submissionTime]
      : [input.contactPhone, input.flowName, input.submissionTime, input.contactId];
  const trailing = v >= 6 ? [input.contactName] : [];
  return [
    ...leading,
    ...standardValues,
    ...input.answerColumns.map((k) =>
      input.inactiveKeys?.has(k) ? "" : stringifySheetCell(input.vars[k]),
    ),
    ...trailing,
    input.runId,
  ];
}

/**
 * Collect var keys across runs that are not in the stored header yet.
 * Pure helper so the healing merge is testable: existing positions never
 * move, newcomers append in first-seen order (callers insert them before
 * the trailing Flow Run ID column on incomplete sheets).
 */
export function collectNewAnswerKeys(
  storedKeys: readonly string[],
  runsVars: readonly (Record<string, unknown> | null | undefined)[],
): { answerColumns: string[]; newKeys: string[] } {
  const seen = new Set(storedKeys);
  const newKeys: string[] = [];
  for (const vars of runsVars) {
    for (const k of Object.keys(vars ?? {})) {
      if (!seen.has(k)) {
        seen.add(k);
        newKeys.push(k);
      }
    }
  }
  return { answerColumns: [...storedKeys, ...newKeys], newKeys };
}

/**
 * Split a flow's question-node keys into sheet-included vs explicitly
 * excluded, reusing the completed sheet's exact contract
 * (see deriveFlowColumns): sheet_include===false nodes are skipped, and
 * when several nodes share one key the first *included* occurrence in
 * flow order claims it. Unknown vars keys (deleted nodes, non-question
 * captures) appear in NEITHER set — callers preserve current behavior
 * for those rather than blanking data they cannot attribute.
 */
export function partitionSheetKeys(
  nodes: FlowNodeLite[],
): { includedKeys: Set<string>; disabledKeys: Set<string> } {
  const { rest } = deriveFlowColumns(nodes, false);
  const includedKeys = new Set(rest.map((c) => c.key));
  const disabledKeys = new Set<string>();
  for (const n of nodes) {
    if (
      n.node_type !== "collect_input" &&
      n.node_type !== "send_buttons" &&
      n.node_type !== "send_list"
    ) {
      continue;
    }
    const cfg = n.config as {
      var_key?: string;
      sheet_include?: boolean;
    };
    if (cfg.sheet_include !== false) continue;
    const key = n.node_type === "collect_input" ? cfg.var_key : n.node_key;
    if (!key || includedKeys.has(key)) continue;
    disabledKeys.add(key);
  }
  return { includedKeys, disabledKeys };
}

/**
 * Schema version for a (re)link operation. A genuinely fresh header (new
 * spreadsheet, or one never synced yet) adopts the current version;
 * relinking the SAME spreadsheet that already has a header preserves
 * whatever version it was written under — the on-sheet header text
 * can't be silently reflowed.
 */
export function resolveFreshLinkSchemaVersion(
  existing: {
    spreadsheet_id: string;
    header_written: boolean;
    schema_version?: number | null;
  } | null | undefined,
  newSpreadsheetId: string,
  currentVersion: number = CURRENT_SHEET_SCHEMA_VERSION,
): number {
  const sameSpreadsheet = existing?.spreadsheet_id === newSpreadsheetId;
  const headerWritten = sameSpreadsheet
    ? (existing?.header_written ?? false)
    : false;
  const isFreshHeader = !sameSpreadsheet || !headerWritten;
  return isFreshHeader ? currentVersion : (existing?.schema_version ?? 1);
}
