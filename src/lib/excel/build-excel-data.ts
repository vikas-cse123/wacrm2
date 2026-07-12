import "server-only";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  TRACKED_FLOW_IDS,
  getTrackedFlow,
} from "./tracked-flows";
import {
  completionTime,
  isRunComplete,
  reconstructRunQA,
  type FlowNodeLite,
  type FlowRunEventLite,
  type FlowRunLite,
} from "./reconstruct";

/**
 * Server-side assembly of the /excel table. Uses the service-role client
 * and scopes every query to the caller's `accountId` (the page is
 * owner-gated), so there's no cross-account leakage even though the
 * tracked-flow config is global.
 *
 * Reuses existing flow data end-to-end — no schema changes.
 */

export type ColumnFormat = "text" | "datetime";

export interface ExcelColumn {
  key: string;
  label: string;
  kind: "meta" | "question";
  format?: ColumnFormat;
}

export interface ExcelRow {
  id: string;
  cells: Record<string, string>;
}

export interface ExcelData {
  columns: ExcelColumn[];
  rows: ExcelRow[];
}

// Fixed metadata columns shown before the dynamic per-question columns.
const META_COLUMNS: ExcelColumn[] = [
  { key: "name", label: "Name", kind: "meta" },
  { key: "phone", label: "Phone", kind: "meta" },
  { key: "flow", label: "Flow", kind: "meta" },
  { key: "status", label: "Status", kind: "meta" },
  { key: "completed_at", label: "Completed at", kind: "meta", format: "datetime" },
  { key: "started_at", label: "Started at", kind: "meta", format: "datetime" },
];

/** Split a list into fixed-size chunks (keeps `.in()` filters URL-safe). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Stable column key for a flow's question node. */
function questionColumnKey(flowId: string, nodeKey: string): string {
  return `q:${flowId}:${nodeKey}`;
}

interface RunRow {
  id: string;
  flow_id: string;
  status: string;
  vars: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
  current_node_key: string | null;
  contact: { name: string | null; phone: string | null } | null;
}

export async function buildExcelData(accountId: string): Promise<ExcelData> {
  const db = supabaseAdmin();

  // When no flows are configured, default to showing EVERY flow in the
  // account (with default "run has ended" completion). Configuring
  // TRACKED_FLOWS narrows to those flows and enables custom completion
  // nodes. Either way the query is scoped to the caller's account.
  const trackAll = TRACKED_FLOW_IDS.length === 0;

  // 1) Flows in THIS account (optionally narrowed to the tracked ids).
  //    Filtering on account_id scopes the whole page to the caller's tenant.
  let flowQuery = db.from("flows").select("id, name").eq("account_id", accountId);
  if (!trackAll) flowQuery = flowQuery.in("id", TRACKED_FLOW_IDS);
  const { data: flowRows, error: flowErr } = await flowQuery;
  if (flowErr) throw new Error(`[excel] flows query failed: ${flowErr.message}`);

  const flows = flowRows ?? [];
  if (flows.length === 0) return { columns: [...META_COLUMNS], rows: [] };

  const flowNameById = new Map<string, string>(
    flows.map((f) => [f.id as string, (f.name as string) ?? ""]),
  );
  const validFlowIds = flows.map((f) => f.id as string);

  // 2) Nodes for those flows → Map<flowId, Map<nodeKey, node>>.
  const { data: nodeRows, error: nodeErr } = await db
    .from("flow_nodes")
    .select("flow_id, node_key, node_type, config")
    .in("flow_id", validFlowIds);
  if (nodeErr) throw new Error(`[excel] nodes query failed: ${nodeErr.message}`);

  const nodesByFlow = new Map<string, Map<string, FlowNodeLite>>();
  for (const n of nodeRows ?? []) {
    const flowId = n.flow_id as string;
    if (!nodesByFlow.has(flowId)) nodesByFlow.set(flowId, new Map());
    nodesByFlow.get(flowId)!.set(n.node_key as string, {
      node_key: n.node_key as string,
      node_type: n.node_type as string,
      config: (n.config as Record<string, unknown>) ?? {},
    });
  }

  // 3) Runs for those flows (account-scoped) with the contact embedded.
  const { data: runData, error: runErr } = await db
    .from("flow_runs")
    .select(
      "id, flow_id, status, vars, started_at, ended_at, current_node_key, contact:contacts(name, phone)",
    )
    .eq("account_id", accountId)
    .in("flow_id", validFlowIds)
    .order("started_at", { ascending: false });
  if (runErr) throw new Error(`[excel] runs query failed: ${runErr.message}`);

  const runs = (runData ?? []) as unknown as RunRow[];
  if (runs.length === 0) {
    return { columns: [...META_COLUMNS], rows: [] };
  }

  // 4) Events for those runs, grouped by run id (chunked `.in()`).
  const runIds = runs.map((r) => r.id);
  const eventsByRun = new Map<string, FlowRunEventLite[]>();
  for (const ids of chunk(runIds, 200)) {
    const { data: evData, error: evErr } = await db
      .from("flow_run_events")
      .select("flow_run_id, event_type, node_key, payload, created_at")
      .in("flow_run_id", ids);
    if (evErr) throw new Error(`[excel] events query failed: ${evErr.message}`);
    for (const e of evData ?? []) {
      const rid = e.flow_run_id as string;
      if (!eventsByRun.has(rid)) eventsByRun.set(rid, []);
      eventsByRun.get(rid)!.push({
        event_type: e.event_type as string,
        node_key: (e.node_key as string) ?? null,
        payload: (e.payload as Record<string, unknown>) ?? null,
        created_at: e.created_at as string,
      });
    }
  }

  // 5) Filter to completed runs and build rows + dynamic question columns.
  const questionColumns: ExcelColumn[] = [];
  const questionColumnSeen = new Set<string>();
  const rows: ExcelRow[] = [];

  for (const run of runs) {
    // Explicit config when present; otherwise a default entry (no custom
    // completion node) so track-all mode still works.
    const tracked = getTrackedFlow(run.flow_id) ?? { flowId: run.flow_id };

    const events = eventsByRun.get(run.id) ?? [];
    const runLite: FlowRunLite = {
      id: run.id,
      flow_id: run.flow_id,
      status: run.status,
      vars: run.vars,
      started_at: run.started_at,
      ended_at: run.ended_at,
      current_node_key: run.current_node_key,
    };

    if (!isRunComplete(runLite, events, tracked)) continue;

    const nodesByKey = nodesByFlow.get(run.flow_id) ?? new Map();
    const qa = reconstructRunQA(runLite, nodesByKey, events);

    const cells: Record<string, string> = {
      name: run.contact?.name ?? "",
      phone: run.contact?.phone ?? "",
      flow: tracked.label ?? flowNameById.get(run.flow_id) ?? "",
      status: run.status,
      completed_at: completionTime(runLite, events, tracked) ?? "",
      started_at: run.started_at ?? "",
    };

    for (const nodeKey of qa.order) {
      const colKey = questionColumnKey(run.flow_id, nodeKey);
      if (!questionColumnSeen.has(colKey)) {
        questionColumnSeen.add(colKey);
        questionColumns.push({
          key: colKey,
          label: qa.byNode[nodeKey].question,
          kind: "question",
        });
      }
      cells[colKey] = qa.byNode[nodeKey].answer ?? "";
    }

    rows.push({ id: run.id, cells });
  }

  return { columns: [...META_COLUMNS, ...questionColumns], rows };
}
