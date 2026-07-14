// ============================================================
// Shared column-derivation logic for a flow's Google Sheet — used by
// the link/relink API route, the live sync engine, and the backfill
// route, so all three agree on what a flow's sheet columns should be.
// ============================================================

import { headerFromPrompt } from "@/lib/google/sheets";

export interface FlowNodeLite {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
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
