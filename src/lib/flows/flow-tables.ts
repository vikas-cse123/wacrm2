// ============================================================
// Workspace (Flow Tables) foundation — shared row/column model.
//
// One row = ONE flow_runs row (flow_run_id is the identity; the
// same contact may legitimately own several rows). Columns are
// derived from the selected flow's own nodes (never hardcoded),
// plus a small fixed set of system columns. Completion is a pure
// classification over execution reach — it never terminates runs
// and never duplicates data: the table is a view over the
// existing flow_runs / contacts / flow_run_events.
// ============================================================

import {
  deriveFlowColumns,
  orderNodesForSheets,
  type FlowNodeLite,
} from "./sheet-columns";
import type {
  WorkspaceField,
  WorkspaceValuesByRun,
} from "./workspace-fields";

export type FlowTableView = "all" | "completed" | "incomplete";

export type FlowTableStatus = "completed" | "incomplete";

export interface FlowTableColumn {
  /** Stable identity: system id or the flow variable/node key. */
  key: string;
  /** Display label. Answer labels come from the flow, not prompt text identity. */
  label: string;
  system: boolean;
}

export interface FlowTableMeta {
  flowId: string;
  flowName: string;
  /** Nullable: NULL = END node decides (backwards compatible). */
  completionNodeId: string | null;
  view: FlowTableView;
  total: number;
  page: number;
  pageSize: number;
}

export interface FlowTableRow {
  runId: string;
  contactId: string | null;
  conversationId: string | null;
  name: string | null;
  phone: string | null;
  startedAt: string;
  lastAdvancedAt: string | null;
  /** Classification timestamp: reach time (custom point) or ended_at. */
  completedAt: string | null;
  status: FlowTableStatus;
  /** Raw runtime status, preserved for future expansion. */
  runStatus: string;
  /** Vars projected onto the flow's answer columns (missing → null). */
  answers: Record<string, string | null>;
  /**
   * First-touch CTWA ad URL for the Ad Source column. NOT part of
   * the RPC projection — attached per page by the table route from
   * contacts.source_url (batched, never N+1).
   */
  sourceUrl?: string | null;
}

export interface FlowTablePayload {
  meta: FlowTableMeta;
  columns: FlowTableColumn[];
  rows: FlowTableRow[];
  /**
   * Workspace custom columns for this flow (phase 2). Absent on
   * older responses — always treated as []. Rendered AFTER all
   * flow columns; never sent to Google Sheets.
   */
  customFields?: WorkspaceField[];
  /** Custom cell values by run id, then field id. */
  customValues?: WorkspaceValuesByRun;
}

export const FLOW_TABLE_PAGE_SIZE = 25;

/** Shape of one row as returned by get_flow_table_rows(). */
export interface FlowTableRpcRow {
  run_id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  conversation_id: string | null;
  status: string;
  started_at: string;
  last_advanced_at: string | null;
  ended_at: string | null;
  /** Set only when a custom point is configured AND reached. */
  reached_at: string | null;
  is_completed: boolean;
  vars: Record<string, unknown>;
}

/**
 * Table classification for one run. Source of truth = execution
 * reach of the configured node (custom point → reached_at; no
 * custom point → runtime status 'completed', i.e. the END-node
 * behavior every existing flow already has). Never column
 * fill-rate, message counts, or inactivity.
 */
export function classifyFlowRun(args: {
  status: string;
  reachedAt: string | null;
  completionNodeId: string | null;
}): FlowTableStatus {
  if (args.completionNodeId) return args.reachedAt ? "completed" : "incomplete";
  return args.status === "completed" ? "completed" : "incomplete";
}

/** When the run completed, if it did (reach time wins over ended_at). */
export function completedAtFor(args: {
  status: FlowTableStatus;
  reachedAt: string | null;
  endedAt: string | null;
}): string | null {
  if (args.status !== "completed") return null;
  return args.reachedAt ?? args.endedAt;
}

function answerText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(Number(value)) ? String(value) : null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Build the column list for a flow: fixed system columns plus one
 * column per question node (collect_input var_key, buttons/list
 * node_key), in flow order. Mirrors the Sheets column derivation
 * so the table and the sheets agree on what "the flow's fields"
 * are — but stored nowhere: pure view, recomputed per request.
 *
 * Column order invariant (Workspace requirement): Submission Time
 * is ALWAYS index 0, followed by Name, Phone Number, the dynamic
 * flow columns, and Status last — for every flow, both views.
 */
export function buildFlowTableColumns(
  nodes: FlowNodeLite[],
  entryNodeKey: string | null,
): { columns: FlowTableColumn[]; nameKey: string | null; answerKeys: string[] } {
  const ordered = orderNodesForSheets(entryNodeKey, nodes);
  const derived = deriveFlowColumns(ordered, true);
  const answerKeys: string[] = [];
  const columns: FlowTableColumn[] = [
    { key: "submission_time", label: "Submission Time", system: true },
    { key: "name", label: "Name", system: true },
    { key: "phone", label: "Phone Number", system: true },
  ];
  if (derived.name) {
    answerKeys.push(derived.name.key);
    columns.push({ key: derived.name.key, label: derived.name.header, system: false });
  }
  for (const col of derived.rest) {
    answerKeys.push(col.key);
    columns.push({ key: col.key, label: col.header, system: false });
  }
  columns.push({ key: "status", label: "Status", system: true });
  return { columns, nameKey: derived.name?.key ?? null, answerKeys };
}

/** Display label for the Workspace flow selector. The UUID stays
 *  the internal value; a missing name must never surface as one. */
export function flowDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  return trimmed ? trimmed : "Untitled Flow";
}

/** Shape one RPC row into a table row (identity = flow_run_id). */
export function toFlowTableRow(
  rpc: FlowTableRpcRow,
  completionNodeId: string | null,
  nameKey: string | null,
  answerKeys: string[],
): FlowTableRow {
  const status = classifyFlowRun({
    status: rpc.status,
    reachedAt: rpc.reached_at,
    completionNodeId,
  });
  const vars = rpc.vars ?? {};
  const collectedName =
    nameKey && vars[nameKey] !== undefined
      ? answerText(vars[nameKey])
      : null;
  const answers: Record<string, string | null> = {};
  for (const key of answerKeys) {
    answers[key] = key in vars ? answerText(vars[key]) : null;
  }
  return {
    runId: rpc.run_id,
    contactId: rpc.contact_id,
    conversationId: rpc.conversation_id,
    name: collectedName ?? rpc.contact_name,
    phone: rpc.contact_phone,
    startedAt: rpc.started_at,
    lastAdvancedAt: rpc.last_advanced_at,
    completedAt: completedAtFor({
      status,
      reachedAt: rpc.reached_at,
      endedAt: rpc.ended_at,
    }),
    status,
    runStatus: rpc.status,
    answers,
  };
}
