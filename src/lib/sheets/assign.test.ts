import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveFlowSheetColumns } from "@/lib/flows/sheet-sync";
import { resolveAllTabColumns } from "@/lib/all-sheets/columns";
import {
  buildCompletedHeader,
  buildCompletedRow,
  buildIncompleteHeader,
  buildIncompleteRow,
  incompleteRunIdColumnIndex,
} from "@/lib/flows/sheet-layout";
import {
  ASSIGN_HEADER,
  ASSIGN_KEY,
  COMPLETED_RUN_ID_KEY,
} from "@/lib/automations/assignment";
import type { AllSheetFlowTabRow } from "@/lib/all-sheets/types";

function dedicatedSheet(overrides = {}) {
  return {
    flow_id: "flow-1",
    account_id: "acct-1",
    spreadsheet_id: "ss-1",
    spreadsheet_url: null,
    spreadsheet_name: null,
    sheet_tab: "Sheet1",
    answer_columns: ["city"],
    answer_headers: ["City"],
    header_written: true,
    schema_version: 3,
    name_column_key: null,
    name_column_header: null,
    ...overrides,
  };
}

function collectNode(node_key: string, var_key: string, header?: string) {
  return {
    node_key,
    node_type: "collect_input",
    config: {
      var_key,
      prompt_text: `${var_key}?`,
      ...(header ? { sheet_column_name: header } : {}),
    },
    created_at: "2026-07-14T10:00:00.000Z",
  };
}

function makeDedicatedDb(sheetRow: Record<string, unknown>, nodes: Record<string, unknown>[]) {
  const updates: Array<{ table: string; payload: unknown }> = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.update = vi.fn((payload: unknown) => {
      updates.push({ table, payload });
      return b;
    });
    b.maybeSingle = vi.fn(async () => {
      if (table === "flow_sheet_configs") return { data: sheetRow, error: null };
      return { data: { entry_node_id: "start" }, error: null };
    });
    b.single = vi.fn(async () => ({ data: sheetRow, error: null }));
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (table === "flow_nodes") return resolve({ data: nodes, error: null });
      return resolve({ data: null, error: null });
    };
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, updates };
}

function makeAllSheetsDb(tab: AllSheetFlowTabRow, nodes: Record<string, unknown>[]) {
  const updates: Array<{ table: string; payload: unknown }> = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.update = vi.fn((payload: unknown) => {
      updates.push({ table, payload });
      return b;
    });
    b.maybeSingle = vi.fn(async () => ({ data: { entry_node_id: "start" }, error: null }));
    b.single = vi.fn(async () => ({ data: tab, error: null }));
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (table === "flow_nodes") return resolve({ data: nodes, error: null });
      return resolve({ data: null, error: null });
    };
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, updates };
}

describe("Dedicated Completed Assign healing", () => {
  const nodes = [
    { node_key: "start", node_type: "start", config: { next_node_key: "city" } },
    collectNode("city", "city", "City"),
  ];

  it("leaves layouts untouched when no assignment exists", async () => {
    const { db, updates } = makeDedicatedDb(dedicatedSheet(), nodes);
    const resolved = await resolveFlowSheetColumns(db, "flow-1", null);
    expect(resolved?.keys).toEqual(["city"]);
    expect(resolved?.headers).toEqual(["City"]);
    expect(updates).toHaveLength(0);
  });

  it("appends Assign + hidden Run ID trailing when requested", async () => {
    const { db, updates } = makeDedicatedDb(dedicatedSheet(), nodes);
    const resolved = await resolveFlowSheetColumns(db, "flow-1", null, { includeAssign: true });
    expect(resolved?.keys).toEqual(["city", ASSIGN_KEY, COMPLETED_RUN_ID_KEY]);
    expect(resolved?.headers).toEqual(["City", ASSIGN_HEADER, "Flow Run ID"]);
    expect(resolved?.activeKeys.has(ASSIGN_KEY)).toBe(true);
    const persisted = updates.find((u) => u.table === "flow_sheet_configs");
    expect((persisted?.payload as { answer_columns: string[] }).answer_columns).toEqual([
      "city",
      ASSIGN_KEY,
      COMPLETED_RUN_ID_KEY,
    ]);
  });

  it("renders Assign value and Run ID in the row, blank when unassigned", () => {
    const keys = ["city", ASSIGN_KEY, COMPLETED_RUN_ID_KEY];
    const headers = ["City", ASSIGN_HEADER, "Flow Run ID"];
    const activeKeys = new Set(keys);
    const header = buildCompletedHeader({
      schemaVersion: 3,
      nameHeader: null,
      nameValue: null,
      contactPhone: "",
      flowName: "",
      submissionTime: "",
      contactId: "",
      answerKeys: keys,
      answerHeaders: headers,
      activeKeys,
      vars: {},
    });
    // Standard V3 [Phone, Time] + answers; Assign second-last, Run ID last.
    expect(header.slice(-3)).toEqual(["City", "Assign", "Flow Run ID"]);

    const rahulRow = buildCompletedRow({
      schemaVersion: 3,
      nameHeader: null,
      nameValue: null,
      contactPhone: "999",
      flowName: "",
      submissionTime: "t",
      contactId: "c1",
      answerKeys: keys,
      answerHeaders: headers,
      activeKeys,
      vars: { city: "Delhi", [ASSIGN_KEY]: "Rahul", [COMPLETED_RUN_ID_KEY]: "run-1" },
    });
    expect(rahulRow.slice(-3)).toEqual(["Delhi", "Rahul", "run-1"]);

    const blankRow = buildCompletedRow({
      schemaVersion: 3,
      nameHeader: null,
      nameValue: null,
      contactPhone: "999",
      flowName: "",
      submissionTime: "t",
      contactId: "c2",
      answerKeys: keys,
      answerHeaders: headers,
      activeKeys,
      vars: { city: "Delhi", [ASSIGN_KEY]: "", [COMPLETED_RUN_ID_KEY]: "run-2" },
    });
    expect(blankRow.slice(-3)).toEqual(["Delhi", "", "run-2"]);
  });

  it("keeps two runs for the same contact isolated (per-run values)", () => {
    const keys = ["city", ASSIGN_KEY, COMPLETED_RUN_ID_KEY];
    const headers = ["City", ASSIGN_HEADER, "Flow Run ID"];
    const activeKeys = new Set(keys);
    const assignMap = new Map([
      ["run-1", "Rahul"],
      ["run-2", "Priya"],
    ]);
    for (const [runId, expected] of assignMap) {
      const row = buildCompletedRow({
        schemaVersion: 3,
        nameHeader: null,
        nameValue: null,
        contactPhone: "same-phone",
        flowName: "",
        submissionTime: "t",
        contactId: "same-contact",
        answerKeys: keys,
        answerHeaders: headers,
        activeKeys,
        vars: { city: "Delhi", [ASSIGN_KEY]: assignMap.get(runId) ?? "", [COMPLETED_RUN_ID_KEY]: runId },
      });
      expect(row[row.length - 2]).toBe(expected);
      expect(row[row.length - 1]).toBe(runId);
    }
  });
});

describe("Incomplete Assign placement (Run ID stays last)", () => {
  it("inserts Assign before the hidden Run ID; Run ID remains final", () => {
    const answerColumns = ["city", ASSIGN_KEY];
    const headers = buildIncompleteHeader(6, answerColumns, ["City", ASSIGN_HEADER], null);
    expect(headers[headers.length - 1]).toBe("Flow Run ID");
    expect(headers[headers.length - 2]).toBe("WhatsApp Name");
    expect(headers).toContain("Assign");
    const assignIdx = headers.indexOf("Assign");
    const runIdIdx = headers.indexOf("Flow Run ID");
    expect(assignIdx).toBeGreaterThanOrEqual(0);
    expect(assignIdx).toBeLessThan(runIdIdx);

    const runIdCol = incompleteRunIdColumnIndex(6, answerColumns, false);
    expect(runIdCol).toBe(headers.length - 1);

    const row = buildIncompleteRow({
      schemaVersion: 6,
      contactName: "Vikas",
      contactPhone: "999",
      flowName: "",
      submissionTime: "t",
      contactId: "c1",
      vars: { city: "Delhi", [ASSIGN_KEY]: "Rahul" },
      answerColumns,
      runId: "run-1",
      promotedHeader: null,
      promotedValue: null,
    });
    expect(row.length).toBe(headers.length);
    expect(row[row.length - 1]).toBe("run-1");
    expect(row[assignIdx]).toBe("Rahul");
  });
});

describe("All Sheets Completed Assign healing (isolated)", () => {
  const tab = (overrides = {}): AllSheetFlowTabRow => ({
    id: "tab-1",
    collection_id: "col-1",
    flow_id: "flow-1",
    worksheet_id: 1,
    worksheet_title: "Flow",
    answer_columns: ["city"],
    answer_headers: ["City"],
    header_written: true,
    schema_version: 3,
    name_column_key: null,
    name_column_header: null,
    display_order: 0,
    ...overrides,
  });
  const nodes = [
    { node_key: "start", node_type: "start", config: { next_node_key: "city" } },
    collectNode("city", "city", "City"),
  ];

  it("leaves tabs untouched without assignments; appends Assign+RunID on demand", async () => {
    const plain = makeAllSheetsDb(tab(), nodes);
    const resolvedPlain = await resolveAllTabColumns(plain.db, tab(), "ss-1", null);
    expect(resolvedPlain.keys).toEqual(["city"]);
    expect(plain.updates).toHaveLength(0);

    const withAssign = makeAllSheetsDb(tab(), nodes);
    const resolved = await resolveAllTabColumns(withAssign.db, tab(), "ss-1", null, {
      includeAssign: true,
    });
    expect(resolved.keys).toEqual(["city", ASSIGN_KEY, COMPLETED_RUN_ID_KEY]);
    expect(resolved.headers).toEqual(["City", ASSIGN_HEADER, "Flow Run ID"]);
  });

  it("never touches Dedicated tables (isolation)", async () => {
    const { updates } = makeAllSheetsDb(tab(), nodes);
    await resolveAllTabColumns(
      makeAllSheetsDb(tab(), nodes).db,
      tab(),
      "ss-1",
      null,
      { includeAssign: true },
    );
    expect(updates.every((u) => u.table === "all_sheet_flow_tabs")).toBe(true);
  });
});
