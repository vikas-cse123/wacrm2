// ============================================================
// Shared column-derivation logic for a flow's Google Sheet — used by
// the link/relink API route, the live sync engine, and the backfill
// route, so all three agree on what a flow's sheet columns should be.
// ============================================================

import { headerFromPrompt } from "@/lib/google/sheets";
import { outgoingEdges } from "./validate";

export interface FlowNodeLite {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  /** Present on DB rows; used only as a deterministic fallback ordering. */
  created_at?: string | null;
}

export interface DerivedColumn {
  key: string;
  header: string;
}

export interface DerivedFlowColumns {
  /** The question promoted to the leading "Name" slot (v2 schema only). */
  name: DerivedColumn | null;
  /** Every other question, in flow order, excluding `name` when set. */
  rest: DerivedColumn[];
}

function isNameLike(varKeyOrNodeKey: string, customHeader?: string): boolean {
  const a = varKeyOrNodeKey.trim().toLowerCase();
  const b = (customHeader ?? "").trim().toLowerCase();
  return a === "name" || b === "name";
}

/**
 * Walk a flow's question-asking nodes (collect_input, send_buttons,
 * send_list) in stored order and derive the columns they'd produce.
 *
 * `promoteName`: when true (v2 schema), the first question that looks
 * like a name field (var_key/custom header === "Name", case-insensitive)
 * is pulled out into `.name` instead of `.rest`, so callers can place it
 * first. When false (v1 / legacy sheets), every question stays in
 * `.rest` in flow order — matches the original behavior so already
 * linked sheets don't have their column layout reshuffled.
 */
export function deriveFlowColumns(
  nodes: FlowNodeLite[],
  promoteName: boolean,
): DerivedFlowColumns {
  const seen = new Set<string>();
  const rest: DerivedColumn[] = [];
  let name: DerivedColumn | null = null;

  for (const n of nodes) {
    if (!["collect_input", "send_buttons", "send_list"].includes(n.node_type)) {
      continue;
    }
    const cfg = n.config as {
      var_key?: string;
      prompt_text?: string;
      text?: string;
      sheet_include?: boolean;
      sheet_column_name?: string;
    };
    if (cfg.sheet_include === false) continue;

    const isCollect = n.node_type === "collect_input";
    const key = isCollect ? cfg.var_key : n.node_key;
    const prompt = isCollect ? cfg.prompt_text : cfg.text;
    if (!key || seen.has(key)) continue;

    const custom = (cfg.sheet_column_name ?? "").trim();
    const header = custom || headerFromPrompt(prompt, key);

    if (promoteName && !name && isNameLike(key, custom)) {
      name = { key, header };
      seen.add(key);
      continue;
    }

    seen.add(key);
    rest.push({ key, header });
  }

  return { name, rest };
}

/**
 * Canonical node order for sheet answer columns: iterative DFS pre-order
 * from the entry node (successors in deterministic config order, so
 * branches linearize predictably), walking THROUGH non-question nodes so
 * downstream questions are reached. Nodes unreachable from the entry
 * (disconnected draft nodes, or everything when entry is null) append in
 * deterministic `created_at`, `node_key` order — the `node_key` tiebreak
 * matters because bulk-saved rows can share identical `created_at`
 * timestamps. Cycles/self-loops/missing targets are safe via visited-set
 * + lookup guards. Pure: input array is never mutated.
 */
export function orderNodesForSheets(
  entryKey: string | null | undefined,
  nodes: FlowNodeLite[],
): FlowNodeLite[] {
  const byKey = new Map<string, FlowNodeLite>();
  for (const n of nodes) {
    if (!byKey.has(n.node_key)) byKey.set(n.node_key, n);
  }

  const visited = new Set<string>();
  const ordered: FlowNodeLite[] = [];
  const visitFrom = (startKey: string) => {
    const stack: string[] = [startKey];
    while (stack.length > 0) {
      const key = stack.pop() as string;
      if (visited.has(key)) continue;
      const node = byKey.get(key);
      if (!node) continue;
      visited.add(key);
      ordered.push(node);
      const nexts = outgoingEdges(node);
      for (let i = nexts.length - 1; i >= 0; i--) {
        if (!visited.has(nexts[i] as string)) stack.push(nexts[i] as string);
      }
    }
  };
  if (entryKey) visitFrom(entryKey);

  const unreachable = nodes.filter((n) => !visited.has(n.node_key));
  unreachable.sort(
    (a, b) =>
      (a.created_at ?? "").localeCompare(b.created_at ?? "") ||
      (a.node_key < b.node_key ? -1 : a.node_key > b.node_key ? 1 : 0),
  );
  return [...ordered, ...unreachable];
}

/**
 * Sheet-eligible question keys in canonical flow order (same
 * sheet_include / first-included-wins contract as deriveFlowColumns,
 * without name promotion — callers place the promoted slot themselves).
 */
export function flowOrderedAnswerKeys(
  entryKey: string | null | undefined,
  nodes: FlowNodeLite[],
): string[] {
  return deriveFlowColumns(orderNodesForSheets(entryKey, nodes), false).rest.map(
    (c) => c.key,
  );
}

/**
 * Human-readable header per eligible answer key, in canonical flow
 * order — the SAME resolution completed sheets use (custom
 * sheet_column_name → question text → raw key, with sanitization and
 * first-included-wins). Map insertion order matches flow order, so
 * `[...map.keys()]` doubles as the flow ranking. Unknown keys (deleted
 * nodes) are absent: callers fall back to the raw key.
 */
export function headerByKey(
  entryKey: string | null | undefined,
  nodes: FlowNodeLite[],
): Map<string, string> {
  const { rest } = deriveFlowColumns(orderNodesForSheets(entryKey, nodes), false);
  return new Map(rest.map((c) => [c.key, c.header] as const));
}

/**
 * Order candidate answer keys by canonical flow rank; keys with no rank
 * (deleted nodes, non-question captures) keep first-seen order at the
 * end. Never reorders relative to anything except the flow ranking —
 * callers splice the result onto frozen stored order, never rewrite it.
 */
export function sortKeysByFlowOrder(
  keys: readonly string[],
  flowOrder: readonly string[],
): string[] {
  const rank = new Map<string, number>();
  flowOrder.forEach((k, i) => {
    if (!rank.has(k)) rank.set(k, i);
  });
  const ranked: Array<{ key: string; rank: number }> = [];
  const unranked: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    const r = rank.get(k);
    if (r === undefined) unranked.push(k);
    else ranked.push({ key: k, rank: r });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return [...ranked.map((x) => x.key), ...unranked];
}
