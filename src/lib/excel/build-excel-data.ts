import "server-only";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  HAS_TRACKED_FLOWS,
  matchTrackedFlow,
  type TrackedFlow,
} from "./tracked-flows";
import {
  completionTime,
  findNodeKeyByQuestion,
  isRunComplete,
  reconstructRunQA,
  type FlowNodeLite,
  type FlowRunEventLite,
  type FlowRunLite,
} from "./reconstruct";

/**
 * Server-side assembly of the /excel table. Uses the service-role client
 * and scopes every query to the caller's `accountId` (the page and the
 * token export both resolve one), so there's no cross-account leakage.
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
  /** Flow name — lets the client filter/select by flow. */
  flow: string;
  cells: Record<string, string>;
}

export interface ExcelData {
  columns: ExcelColumn[];
  rows: ExcelRow[];
  /** Distinct flow names present, for a flow selector. */
  flows: string[];
}

// Exploratory (no config) meta columns.
const FULL_META: ExcelColumn[] = [
  { key: "name", label: "Name", kind: "meta" },
  { key: "phone", label: "Phone", kind: "meta" },
  { key: "flow", label: "Flow", kind: "meta" },
  { key: "status", label: "Status", kind: "meta" },
  { key: "completed_at", label: "Completed at", kind: "meta", format: "datetime" },
  { key: "started_at", label: "Started at", kind: "meta", format: "datetime" },
];

// Curated (config present) meta columns: a contact key + a timestamp —
// the minimum a downstream CRM needs to match a record and dedupe.
const CURATED_META: ExcelColumn[] = [
  { key: "phone", label: "Phone", kind: "meta" },
  { key: "completed_at", label: "Completed at", kind: "meta", format: "datetime" },
];

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function questionColumnKey(flowId: string, suffix: string): string {
  return `q:${flowId}:${suffix}`;
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

/** One resolved question column: a config label bound to a node_key. */
interface ResolvedColumn {
  key: string;
  label: string;
  nodeKey: string | null;
}

interface ResolvedFlow {
  flowId: string;
  name: string;
  /** Config with completionNodeKey resolved from completeWhenReached. */
  tracked: TrackedFlow;
  nodesByKey: Map<string, FlowNodeLite>;
  /** Fixed curated columns, or null to auto-derive per run. */
  columns: ResolvedColumn[] | null;
}

export async function buildExcelData(accountId: string): Promise<ExcelData> {
  const db = supabaseAdmin();

  // 1) All flows in the account (small set). We match to the config in JS
  //    so a flow can be named OR id'd.
  const { data: flowRows, error: flowErr } = await db
    .from("flows")
    .select("id, name")
    .eq("account_id", accountId);
  if (flowErr) throw new Error(`[excel] flows query failed: ${flowErr.message}`);

  const allFlows = (flowRows ?? []) as { id: string; name: string | null }[];

  // Which flows to include + their config. Empty config → every flow with
  // a default (ended-run) completion.
  const included: { id: string; name: string; tracked: TrackedFlow }[] = [];
  for (const f of allFlows) {
    const tracked = matchTrackedFlow(f);
    if (HAS_TRACKED_FLOWS) {
      if (tracked) included.push({ id: f.id, name: f.name ?? "", tracked });
    } else {
      included.push({ id: f.id, name: f.name ?? "", tracked: { flowId: f.id } });
    }
  }

  const curatedMeta = HAS_TRACKED_FLOWS;
  const metaColumns = curatedMeta ? CURATED_META : FULL_META;

  if (included.length === 0) {
    return { columns: [...metaColumns], rows: [], flows: [] };
  }

  const includedIds = included.map((f) => f.id);

  // 2) Nodes for the included flows → Map<flowId, Map<nodeKey, node>>.
  const { data: nodeRows, error: nodeErr } = await db
    .from("flow_nodes")
    .select("flow_id, node_key, node_type, config")
    .in("flow_id", includedIds);
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

  // 3) Resolve, per flow: the completion node_key and (if configured) the
  //    fixed column list — both from the question texts in the config.
  const resolvedByFlow = new Map<string, ResolvedFlow>();
  for (const f of included) {
    const nodesByKey = nodesByFlow.get(f.id) ?? new Map<string, FlowNodeLite>();
    const nodeList = [...nodesByKey.values()];

    let completionNodeKey = f.tracked.completionNodeKey;
    if (!completionNodeKey && f.tracked.completeWhenReached) {
      completionNodeKey =
        findNodeKeyByQuestion(nodeList, f.tracked.completeWhenReached) ?? undefined;
    }

    let columns: ResolvedColumn[] | null = null;
    if (f.tracked.columns && f.tracked.columns.length > 0) {
      columns = f.tracked.columns.map((label, i) => {
        const nodeKey = findNodeKeyByQuestion(nodeList, label);
        return {
          key: questionColumnKey(f.id, nodeKey ?? `col${i}`),
          label,
          nodeKey,
        };
      });
    }

    resolvedByFlow.set(f.id, {
      flowId: f.id,
      name: f.name,
      tracked: { ...f.tracked, completionNodeKey },
      nodesByKey,
      columns,
    });
  }

  // 4) Runs for the included flows (account-scoped) + embedded contact.
  const { data: runData, error: runErr } = await db
    .from("flow_runs")
    .select(
      "id, flow_id, status, vars, started_at, ended_at, current_node_key, contact:contacts(name, phone)",
    )
    .eq("account_id", accountId)
    .in("flow_id", includedIds)
    .order("started_at", { ascending: false });
  if (runErr) throw new Error(`[excel] runs query failed: ${runErr.message}`);

  const runs = (runData ?? []) as unknown as RunRow[];

  // 5) Events for those runs, grouped by run id (chunked `.in()`).
  const runIds = runs.map((r) => r.id);
  const eventsByRun = new Map<string, FlowRunEventLite[]>();
  for (const ids of chunk(runIds, 200)) {
    if (ids.length === 0) continue;
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

  // 6) Fixed question columns for curated flows (always present, in order).
  const questionColumns: ExcelColumn[] = [];
  const autoColumnSeen = new Set<string>();
  for (const f of included) {
    const resolved = resolvedByFlow.get(f.id)!;
    if (resolved.columns) {
      for (const c of resolved.columns) {
        questionColumns.push({ key: c.key, label: c.label, kind: "question" });
      }
    }
  }

  // 7) Build rows: keep only runs that satisfy completion.
  const rows: ExcelRow[] = [];
  const flowNames = new Set<string>();

  for (const run of runs) {
    const resolved = resolvedByFlow.get(run.flow_id);
    if (!resolved) continue;

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

    if (!isRunComplete(runLite, events, resolved.tracked)) continue;

    const qa = reconstructRunQA(runLite, resolved.nodesByKey, events);
    const flowLabel = resolved.tracked.label || resolved.name;
    flowNames.add(flowLabel);

    const cells: Record<string, string> = {
      name: run.contact?.name ?? "",
      phone: run.contact?.phone ?? "",
      flow: flowLabel,
      status: run.status,
      completed_at: completionTime(runLite, events, resolved.tracked) ?? "",
      started_at: run.started_at ?? "",
    };

    if (resolved.columns) {
      // Curated: fill exactly the configured columns.
      for (const c of resolved.columns) {
        cells[c.key] = (c.nodeKey && qa.byNode[c.nodeKey]?.answer) || "";
      }
    } else {
      // Auto: one column per answered question, first-seen order.
      for (const nodeKey of qa.order) {
        const colKey = questionColumnKey(run.flow_id, nodeKey);
        if (!autoColumnSeen.has(colKey)) {
          autoColumnSeen.add(colKey);
          questionColumns.push({
            key: colKey,
            label: qa.byNode[nodeKey].question,
            kind: "question",
          });
        }
        cells[colKey] = qa.byNode[nodeKey].answer ?? "";
      }
    }

    rows.push({ id: run.id, flow: flowLabel, cells });
  }

  return {
    columns: [...metaColumns, ...questionColumns],
    rows,
    flows: [...flowNames].sort(),
  };
}
