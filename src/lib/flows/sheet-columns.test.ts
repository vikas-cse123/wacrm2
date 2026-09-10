// ============================================================
// Canonical flow-order tests for sheet answer columns.
//
// The single contract under test: question keys follow DFS pre-order
// from entry_node_id (successors in config order), unreachable nodes
// append deterministically (created_at, node_key), and the same
// sheet_include / first-included-wins semantics as deriveFlowColumns
// apply. Input array order, created_at ties, canvas positions, and
// run.vars key order must NEVER leak into the result.
// ============================================================

import { describe, expect, it } from "vitest";

import {
  flowOrderedAnswerKeys,
  headerByKey,
  orderNodesForSheets,
  sortKeysByFlowOrder,
  type FlowNodeLite,
} from "./sheet-columns";

function node(
  node_key: string,
  node_type: string,
  config: Record<string, unknown> = {},
  created_at: string | null = "2026-07-14T10:00:00.000Z",
): FlowNodeLite {
  return { node_key, node_type, config, created_at };
}

function collect(
  node_key: string,
  var_key: string,
  next?: string,
  extra: Record<string, unknown> = {},
): FlowNodeLite {
  return node(node_key, "collect_input", {
    var_key,
    prompt_text: `${var_key}?`,
    ...(next ? { next_node_key: next } : {}),
    ...extra,
  });
}

/** Linear chain start → month → rooms → hotel, shuffled input order. */
function linearFlow(): { entry: string; nodes: FlowNodeLite[] } {
  return {
    entry: "start",
    nodes: [
      collect("hotel", "hotel"),
      node("start", "start", { next_node_key: "month" }),
      collect("rooms", "rooms", "hotel"),
      collect("month", "month", "rooms"),
    ],
  };
}

describe("orderNodesForSheets", () => {
  it("walks a linear flow in execution order regardless of input order", () => {
    const { entry, nodes } = linearFlow();
    expect(orderNodesForSheets(entry, nodes).map((n) => n.node_key)).toEqual([
      "start",
      "month",
      "rooms",
      "hotel",
    ]);
  });

  it("walks through non-question nodes to reach downstream questions", () => {
    const nodes: FlowNodeLite[] = [
      node("tag", "set_tag", { next_node_key: "q" }),
      node("start", "start", { next_node_key: "tag" }),
      collect("q", "q"),
    ];
    expect(orderNodesForSheets("start", nodes).map((n) => n.node_key)).toEqual(
      ["start", "tag", "q"],
    );
  });

  it("linearizes branches deterministically (successor config order)", () => {
    const nodes: FlowNodeLite[] = [
      node("start", "start", { next_node_key: "cond" }),
      node("cond", "condition", { true_next: "t", false_next: "f" }),
      collect("f", "f"),
      collect("t", "t"),
    ];
    const first = orderNodesForSheets("start", nodes).map((n) => n.node_key);
    const second = orderNodesForSheets("start", [...nodes].reverse()).map(
      (n) => n.node_key,
    );
    // true-branch before false-branch (config order), stable either way.
    expect(first).toEqual(["start", "cond", "t", "f"]);
    // Input shuffle must not change the walk.
    expect(second).toEqual(["start", "cond", "t", "f"]);
  });

  it("survives cycles and self-loops without hanging or duplicating", () => {
    const nodes: FlowNodeLite[] = [
      node("start", "start", { next_node_key: "a" }),
      collect("a", "a", "b"),
      collect("b", "b", "a"),
      collect("self", "self", "self"),
    ];
    const order = orderNodesForSheets("start", nodes).map((n) => n.node_key);
    expect(order.slice(0, 3)).toEqual(["start", "a", "b"]);
    // Unreachable self-loop still listed exactly once via the fallback.
    expect(order.filter((k) => k === "self")).toHaveLength(1);
  });

  it("skips missing targets", () => {
    const nodes: FlowNodeLite[] = [
      node("start", "start", { next_node_key: "ghost" }),
      collect("q", "q"),
    ];
    expect(orderNodesForSheets("start", nodes).map((n) => n.node_key)).toEqual(
      ["start", "q"],
    );
  });

  it("null entry falls back to deterministic created_at, node_key order", () => {
    const nodes: FlowNodeLite[] = [
      collect("b", "b", undefined, {}),
      collect("a", "a", undefined, {}),
    ];
    nodes[0]!.created_at = "2026-07-14T10:00:00.000Z";
    nodes[1]!.created_at = "2026-07-14T09:00:00.000Z";
    expect(orderNodesForSheets(null, nodes).map((n) => n.node_key)).toEqual([
      "a",
      "b",
    ]);
  });

  it("breaks created_at ties by node_key (bulk saves share timestamps)", () => {
    const same = "2026-07-14T10:00:00.000Z";
    const nodes: FlowNodeLite[] = [
      collect("rooms", "rooms"),
      collect("month", "month"),
      collect("hotel", "hotel"),
    ];
    for (const n of nodes) n.created_at = same;
    expect(orderNodesForSheets(null, nodes).map((n) => n.node_key)).toEqual([
      "hotel",
      "month",
      "rooms",
    ]);
  });

  it("appends unreachable nodes after reachable ones, deterministically", () => {
    const nodes: FlowNodeLite[] = [
      collect("orphan", "orphan"),
      node("start", "start", { next_node_key: "q" }),
      collect("q", "q"),
    ];
    expect(orderNodesForSheets("start", nodes).map((n) => n.node_key)).toEqual(
      ["start", "q", "orphan"],
    );
  });

  it("does not mutate the input array", () => {
    const { entry, nodes } = linearFlow();
    const snapshot = nodes.map((n) => n.node_key);
    orderNodesForSheets(entry, nodes);
    expect(nodes.map((n) => n.node_key)).toEqual(snapshot);
  });
});

describe("flowOrderedAnswerKeys", () => {
  it("returns eligible question keys in walk order", () => {
    const { entry, nodes } = linearFlow();
    expect(flowOrderedAnswerKeys(entry, nodes)).toEqual([
      "month",
      "rooms",
      "hotel",
    ]);
  });

  it("excludes sheet_include=false nodes", () => {
    const { entry, nodes } = linearFlow();
    nodes.push(
      node("skip", "send_buttons", { text: "x", sheet_include: false }),
    );
    expect(flowOrderedAnswerKeys(entry, nodes)).not.toContain("skip");
  });

  it("first-included-wins for duplicate keys", () => {
    const nodes: FlowNodeLite[] = [
      node("start", "start", { next_node_key: "a" }),
      collect("a", "pick", "b", { sheet_include: false }),
      collect("b", "pick"),
    ];
    // Disabled first occurrence is skipped, so the enabled one claims it.
    expect(flowOrderedAnswerKeys("start", nodes)).toEqual(["pick"]);
  });
});

describe("sortKeysByFlowOrder", () => {
  it("ranks known keys by flow order and keeps unknowns last, first-seen", () => {
    expect(
      sortKeysByFlowOrder(
        ["hotel", "ghost", "rooms", "month"],
        ["month", "rooms", "hotel"],
      ),
    ).toEqual(["month", "rooms", "hotel", "ghost"]);
  });

  it("dedupes while preserving first occurrence", () => {
    expect(sortKeysByFlowOrder(["b", "a", "b"], ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns unknowns untouched when flow order is empty", () => {
    expect(sortKeysByFlowOrder(["z", "a"], [])).toEqual(["z", "a"]);
  });
});

describe("headerByKey", () => {
  const nodes: FlowNodeLite[] = [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "month" },
    },
    {
      node_key: "month",
      node_type: "collect_input",
      config: { var_key: "month", prompt_text: "Travel month?" },
    },
    {
      node_key: "rooms",
      node_type: "collect_input",
      config: { var_key: "rooms", sheet_column_name: "No. of Rooms" },
    },
    {
      node_key: "send_button_3",
      node_type: "send_buttons",
      config: { text: "Pick a hotel?", next_node_key: "month" },
    },
    {
      node_key: "off",
      node_type: "send_buttons",
      config: { text: "Hidden?", sheet_include: false },
    },
  ];

  it("resolves custom names, prompts, and raw fallbacks per node type", () => {
    const map = headerByKey("start", nodes);
    expect(map.get("rooms")).toBe("No. of Rooms");
    expect(map.get("month")).toBe("Travel month?");
    expect(map.get("send_button_3")).toBe("Pick a hotel?");
  });

  it("omits disabled nodes and unknown keys", () => {
    const map = headerByKey("start", nodes);
    expect(map.has("off")).toBe(false);
    expect(map.has("ghost")).toBe(false);
  });

  it("insertion order follows the canonical walk", () => {
    const map = headerByKey("start", nodes);
    expect([...map.keys()]).toEqual(["month", "rooms", "send_button_3"]);
  });
});
