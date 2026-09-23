import { describe, expect, it } from "vitest";
import {
  buildFlowTableColumns,
  classifyFlowRun,
  completedAtFor,
  toFlowTableRow,
  type FlowTableRpcRow,
} from "./flow-tables";
import type { FlowNodeLite } from "./sheet-columns";

function nodesFor(keys: Array<{ key: string; header?: string }>): FlowNodeLite[] {
  return [
    { node_key: "start", node_type: "start", config: { next_node_key: keys[0]?.key ?? "" } },
    ...keys.map((k, i) => ({
      node_key: `q${i}`,
      node_type: "collect_input",
      config: {
        prompt_text: `What is your ${k.key}?`,
        var_key: k.key,
        ...(k.header ? { sheet_column_name: k.header } : {}),
        next_node_key: keys[i + 1] ? `q${i + 1}` : "end",
      },
    })),
    { node_key: "end", node_type: "end", config: {} },
  ];
}

function rpcRow(over: Partial<FlowTableRpcRow> = {}): FlowTableRpcRow {
  return {
    run_id: "run-1",
    contact_id: "c-1",
    contact_name: "Rahul",
    contact_phone: "+919999999999",
    conversation_id: "conv-1",
    status: "active",
    started_at: "2026-09-18T10:00:00.000Z",
    last_advanced_at: "2026-09-18T10:05:00.000Z",
    ended_at: null,
    reached_at: null,
    is_completed: false,
    vars: {},
    ...over,
  };
}

describe("classifyFlowRun", () => {
  it("9. reaching the custom completion node → Completed", () => {
    expect(
      classifyFlowRun({
        status: "active",
        reachedAt: "2026-09-18T10:05:00.000Z",
        completionNodeId: "hotel",
      }),
    ).toBe("completed");
  });

  it("10. not reaching the custom completion node → Incomplete", () => {
    expect(
      classifyFlowRun({
        status: "active",
        reachedAt: null,
        completionNodeId: "hotel",
      }),
    ).toBe("incomplete");
    // Even a completed runtime status does not matter once a custom
    // point exists — reach is the only source of truth.
    expect(
      classifyFlowRun({
        status: "completed",
        reachedAt: null,
        completionNodeId: "hotel",
      }),
    ).toBe("incomplete");
  });

  it("11. no custom point → END behavior (runtime completed)", () => {
    expect(
      classifyFlowRun({ status: "completed", reachedAt: null, completionNodeId: null }),
    ).toBe("completed");
    expect(
      classifyFlowRun({ status: "active", reachedAt: null, completionNodeId: null }),
    ).toBe("incomplete");
    expect(
      classifyFlowRun({ status: "timed_out", reachedAt: null, completionNodeId: null }),
    ).toBe("incomplete");
  });

  it("records reach time as completed_at, ended_at as fallback", () => {
    expect(
      completedAtFor({
        status: "completed",
        reachedAt: "2026-09-18T10:05:00.000Z",
        endedAt: "2026-09-18T11:00:00.000Z",
      }),
    ).toBe("2026-09-18T10:05:00.000Z");
    expect(
      completedAtFor({ status: "completed", reachedAt: null, endedAt: "2026-09-18T11:00:00.000Z" }),
    ).toBe("2026-09-18T11:00:00.000Z");
    expect(
      completedAtFor({ status: "incomplete", reachedAt: null, endedAt: null }),
    ).toBeNull();
  });
});

describe("flow table rows", () => {
  it("4. one row represents one flow_run_id", () => {
    const row = toFlowTableRow(rpcRow({ run_id: "run-A" }), null, null, []);
    expect(row.runId).toBe("run-A");
  });

  it("5. the same contact keeps multiple legitimate runs as separate rows", () => {
    const a = toFlowTableRow(
      rpcRow({ run_id: "run-A", contact_phone: "+91111", vars: { Name: "A" } }),
      null,
      "Name",
      ["Name"],
    );
    const b = toFlowTableRow(
      rpcRow({ run_id: "run-B", contact_phone: "+91111", vars: { Name: "A" } }),
      null,
      "Name",
      ["Name"],
    );
    expect(a.runId).not.toBe(b.runId);
    expect(a.phone).toBe(b.phone);
  });

  it("13/14. completion reclassifies the same row — never a duplicate", () => {
    const before = toFlowTableRow(
      rpcRow({ run_id: "run-A", status: "active" }),
      "hotel",
      null,
      [],
    );
    const after = toFlowTableRow(
      rpcRow({
        run_id: "run-A",
        status: "active",
        reached_at: "2026-09-18T10:05:00.000Z",
        is_completed: true,
      }),
      "hotel",
      null,
      [],
    );
    expect(before.status).toBe("incomplete");
    expect(after.status).toBe("completed");
    expect(after.runId).toBe(before.runId);
  });

  it("projects answers onto the flow columns, missing → null", () => {
    const row = toFlowTableRow(
      rpcRow({ vars: { TravelDate: "October" } }),
      null,
      "Name",
      ["Name", "TravelDate"],
    );
    expect(row.answers).toEqual({ Name: null, TravelDate: "October" });
    // Contact name backs the Name slot when the flow did not collect one.
    expect(row.name).toBe("Rahul");
  });

  it("prefers the flow-collected name over the contact name", () => {
    const row = toFlowTableRow(
      rpcRow({ contact_name: "WA User", vars: { Name: "Akash" } }),
      null,
      "Name",
      ["Name"],
    );
    expect(row.name).toBe("Akash");
  });
});

describe("flow table columns", () => {
  it("6. dynamic columns come from the selected flow", () => {
    const { columns, nameKey, answerKeys } = buildFlowTableColumns(
      nodesFor([{ key: "Name" }, { key: "TravelDate" }]),
      "start",
    );
    expect(columns.map((c) => c.key)).toEqual([
      "name",
      "phone",
      "submission_time",
      "Name",
      "TravelDate",
      "status",
    ]);
    expect(nameKey).toBe("Name");
    expect(answerKeys).toEqual(["Name", "TravelDate"]);
    // System columns are flagged so answers can never overwrite them.
    expect(columns.filter((c) => c.system).map((c) => c.key)).toEqual([
      "name",
      "phone",
      "submission_time",
      "status",
    ]);
  });

  it("2. different flows load different table structures", () => {
    const a = buildFlowTableColumns(
      nodesFor([{ key: "Name" }, { key: "TravelDate" }, { key: "Hotel" }]),
      "start",
    );
    const b = buildFlowTableColumns(
      nodesFor([{ key: "Name" }, { key: "Destination" }, { key: "Budget" }]),
      "start",
    );
    expect(a.answerKeys).toEqual(["Name", "TravelDate", "Hotel"]);
    expect(b.answerKeys).toEqual(["Name", "Destination", "Budget"]);
  });

  it("uses the stable variable key, not prompt text, as the identity", () => {
    const { answerKeys } = buildFlowTableColumns(
      nodesFor([{ key: "TravelDate", header: "Travel Date" }]),
      "start",
    );
    expect(answerKeys).toEqual(["TravelDate"]);
  });
});
