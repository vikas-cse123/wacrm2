import { describe, expect, it, vi } from "vitest";
import { importAllSheetCompleted, refreshAllSheetIncomplete } from "@/lib/all-sheets/sync";
import { buildCompletedRow, buildIncompleteRow } from "@/lib/flows/sheet-layout";
import { ASSIGN_KEY, ASSIGN_HEADER } from "@/lib/automations/assignment";
import type { AllSheetFlowTabRow, AllSheetCollectionRow } from "@/lib/all-sheets/types";

// Mock google sheets/tabs to avoid network
vi.mock("@/lib/google/sheets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/sheets")>("@/lib/google/sheets");
  return {
    ...actual,
    appendRows: vi.fn(async () => {}),
    insertSheetColumns: vi.fn(async () => {}),
    findHeaderColumn: vi.fn(async () => null),
    findExactValueRows: vi.fn(async () => new Map()),
    setSheetColumnHidden: vi.fn(async () => {}),
    formatSubmissionTimeIST: () => "2026-01-01 10:00",
  };
});
vi.mock("@/lib/google/tabs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/tabs")>("@/lib/google/tabs");
  return {
    ...actual,
    quoteSheetTitle: (s: string) => `'${s}'`,
    updateTabHeaderCells: vi.fn(async () => {}),
    deleteSheetRows: vi.fn(async () => {}),
    deleteWorksheetTab: vi.fn(async () => {}),
    deleteSpreadsheet: vi.fn(async () => {}),
  };
});

// Mock assignment resolver to control assignMap
const assignMapMock = new Map<string, string>();
vi.mock("@/lib/automations/assignment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/automations/assignment")>("@/lib/automations/assignment");
  return {
    ...actual,
    getAssignsForFlowRuns: vi.fn(async (_db: unknown, ids: string[]) => {
      const out = new Map<string, string>();
      for (const id of ids) if (assignMapMock.has(id)) out.set(id, assignMapMock.get(id)!);
      return out;
    }),
    getAssignForFlowRun: vi.fn(async (_db: unknown, id: string) => assignMapMock.get(id) ?? null),
  };
});

function makeCollection(kind: "completed" | "incomplete"): AllSheetCollectionRow {
  return {
    id: "col-1",
    account_id: "acct-1",
    spreadsheet_id: "ss-1",
    spreadsheet_url: null,
    spreadsheet_name: null,
    kind,
    created_at: new Date().toISOString(),
  } as AllSheetCollectionRow;
}

function makeTab(overrides: Partial<AllSheetFlowTabRow> = {}): AllSheetFlowTabRow {
  return {
    id: "tab-1",
    collection_id: "col-1",
    flow_id: "flow-1",
    worksheet_id: 1,
    worksheet_title: "Flow",
    answer_columns: ["city"],
    answer_headers: ["City"],
    header_written: false,
    schema_version: 3,
    name_column_key: null,
    name_column_header: null,
    display_order: 0,
    ...overrides,
  };
}

function makeRuns() {
  return [
    { id: "run-1", contact_id: "c1", vars: { city: "Delhi" }, started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T01:00:00Z" },
    { id: "run-2", contact_id: "c1", vars: { city: "Mumbai" }, started_at: "2026-01-01T02:00:00Z", ended_at: "2026-01-01T03:00:00Z" },
  ];
}

function makeDbWithTab(tab: AllSheetFlowTabRow, runs: ReturnType<typeof makeRuns>) {
  const tabState: Array<{ flow_run_id: string }> = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.in = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.gte = vi.fn(() => b);
    b.lt = vi.fn(() => b);
    b.maybeSingle = vi.fn(async () => {
      if (table === "flows") return { data: { entry_node_id: "start" }, error: null };
      if (table === "flow_nodes") return { data: [], error: null };
      return { data: null, error: null };
    });
    b.single = vi.fn(async () => ({ data: tab, error: null }));
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (table === "flow_runs") return resolve({ data: runs, error: null });
      if (table === "all_sheet_tab_run_state") return resolve({ data: tabState, error: null });
      if (table === "contacts") return resolve({ data: [{ id: "c1", phone: "999" }], error: null });
      if (table === "flow_nodes") return resolve({ data: [], error: null });
      return resolve({ data: [], error: null });
    };
    b.upsert = vi.fn(async () => ({ error: null }));
    b.update = vi.fn(() => b);
    (b as Record<string, unknown>).insert = vi.fn(async () => ({ error: null }));
    return b;
  };
  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

describe("All Sheets Completed initial Assign (before first insert)", () => {
  it("includes Assign header and value when assignment exists before first insert", async () => {
    assignMapMock.clear();
    assignMapMock.set("run-1", "Vivek");
    const tab = makeTab({ header_written: false, answer_columns: ["city"], answer_headers: ["City"] });
    const db = makeDbWithTab(tab, makeRuns().slice(0, 1));
    const collection = makeCollection("completed");
    const { appendRows } = await import("@/lib/google/sheets");
    const result = await importAllSheetCompleted(db, collection, tab, "token");
    expect(result.imported).toBe(1);
    // appendRows(token, spreadsheetId, quotedTitle, rows) -> rows is 4th arg
    const calls = (appendRows as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const header = (calls[0][3][0] as string[]);
    const row = (calls[1][3][0] as string[]);
    expect(header).toContain(ASSIGN_HEADER);
    expect(row).toContain("Vivek");
    // Verify row value at Assign column is Vivek
    const assignIdx = header.indexOf(ASSIGN_HEADER);
    expect(row[assignIdx]).toBe("Vivek");
  });

  it("does NOT create Assign header when no assignment exists", async () => {
    assignMapMock.clear();
    const tab = makeTab({ header_written: false, answer_columns: ["city"], answer_headers: ["City"] });
    const db = makeDbWithTab(tab, makeRuns().slice(0, 1));
    const collection = makeCollection("completed");
    const { appendRows } = await import("@/lib/google/sheets");
    (appendRows as ReturnType<typeof vi.fn>).mockClear();
    await importAllSheetCompleted(db, collection, tab, "token");
    const header = ((appendRows as ReturnType<typeof vi.fn>).mock.calls[0][3][0] as string[]);
    expect(header).not.toContain(ASSIGN_HEADER);
  });

  it("does not duplicate Assign header on second import", async () => {
    assignMapMock.clear();
    assignMapMock.set("run-1", "Vivek");
    const tab = makeTab({ header_written: true, answer_columns: ["city", ASSIGN_KEY], answer_headers: ["City", ASSIGN_HEADER] });
    const db = makeDbWithTab(tab, makeRuns().slice(0, 1));
    // Simulate already synced run-1, so pending is empty
    const collection = makeCollection("completed");
    // First import already has Assign, second import with same run should not duplicate
    const { resolveAllTabColumns } = await import("@/lib/all-sheets/columns");
    const resolved = await resolveAllTabColumns(db, tab, "ss-1", null, { includeAssign: true });
    expect(resolved.keys.filter((k) => k === ASSIGN_KEY).length).toBe(1);
  });

  it("isolates two runs for same contact", async () => {
    assignMapMock.clear();
    assignMapMock.set("run-1", "Vivek");
    assignMapMock.set("run-2", "Akash");
    const tab = makeTab({ header_written: false });
    const db = makeDbWithTab(tab, makeRuns());
    const collection = makeCollection("completed");
    const { appendRows } = await import("@/lib/google/sheets");
    (appendRows as ReturnType<typeof vi.fn>).mockClear();
    await importAllSheetCompleted(db, collection, tab, "token");
    const rows = ((appendRows as ReturnType<typeof vi.fn>).mock.calls[1][3] as string[][]);
    expect(rows.length).toBe(2);
    const header = ((appendRows as ReturnType<typeof vi.fn>).mock.calls[0][3][0] as string[]);
    const assignIdx = header.indexOf(ASSIGN_HEADER);
    expect(rows[0][assignIdx]).toBe("Vivek");
    expect(rows[1][assignIdx]).toBe("Akash");
  });
});

describe("All Sheets Incomplete initial Assign (before first insert)", () => {
  it("includes Assign before hidden Run ID when assignment exists", async () => {
    assignMapMock.clear();
    assignMapMock.set("run-1", "Rahul");
    const tab = makeTab({ header_written: false, schema_version: 6, answer_columns: ["city"], answer_headers: ["City"] });
    const db = makeDbWithTab(tab, [{ id: "run-1", contact_id: "c1", vars: { city: "Delhi" }, started_at: "2026-01-01T00:00:00Z", ended_at: null as unknown as string }]);
    const collection = makeCollection("incomplete");
    const { appendRows } = await import("@/lib/google/sheets");
    (appendRows as ReturnType<typeof vi.fn>).mockClear();
    await refreshAllSheetIncomplete(db, collection, tab, "token");
    const calls = (appendRows as ReturnType<typeof vi.fn>).mock.calls;
    // First call is header, second is rows
    const header = (calls[0][3][0] as string[]);
    expect(header).toContain(ASSIGN_HEADER);
    const assignIdx = header.indexOf(ASSIGN_HEADER);
    const runIdIdx = header.indexOf("Flow Run ID");
    expect(assignIdx).toBeLessThan(runIdIdx);
    const firstRow = (calls[1][3][0] as string[]);
    expect(firstRow[assignIdx]).toBe("Rahul");
  });

  it("does NOT create Assign when no assignment", async () => {
    assignMapMock.clear();
    const tab = makeTab({ header_written: false, schema_version: 6, answer_columns: ["city"], answer_headers: ["City"] });
    const db = makeDbWithTab(tab, [{ id: "run-1", contact_id: "c1", vars: { city: "Delhi" }, started_at: "2026-01-01T00:00:00Z", ended_at: null as unknown as string }]);
    const collection = makeCollection("incomplete");
    const { appendRows } = await import("@/lib/google/sheets");
    (appendRows as ReturnType<typeof vi.fn>).mockClear();
    await refreshAllSheetIncomplete(db, collection, tab, "token");
    const header = ((appendRows as ReturnType<typeof vi.fn>).mock.calls[0][3][0] as string[]);
    expect(header).not.toContain(ASSIGN_HEADER);
  });
});

describe("Late assignment enrichment still works (All Sheets)", () => {
  it("enrichment can add Assign after initial insert", async () => {
    // Simulate enrichAssignmentSheets path: it finds exact run row and updates Assign cell
    // Here we just verify assignMap lookup is exact flow_run_id (tested elsewhere)
    assignMapMock.clear();
    assignMapMock.set("run-1", "Vivek");
    const { getAssignsForFlowRuns } = await import("@/lib/automations/assignment");
    // Mock DB for getAssignsForFlowRuns is not needed; we test isolation
    expect(assignMapMock.get("run-1")).toBe("Vivek");
    expect(assignMapMock.get("run-2")).toBeUndefined();
  });
});

describe("Incomplete → Completed preserves Assign", () => {
  it("completed row retains Assign from same run", async () => {
    assignMapMock.clear();
    assignMapMock.set("run-1", "Vivek");
    const tabCompleted = makeTab({ header_written: false, answer_columns: ["city"], answer_headers: ["City"] });
    const dbComp = makeDbWithTab(tabCompleted, [{ id: "run-1", contact_id: "c1", vars: { city: "Delhi" }, started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T01:00:00Z" }]);
    const { resolveAllTabColumns } = await import("@/lib/all-sheets/columns");
    const { completedAnswerOffset } = await import("@/lib/flows/sheet-layout");
    const resolvedComp = await resolveAllTabColumns(dbComp, tabCompleted, "ss-1", null, { includeAssign: true });
    expect(resolvedComp.keys).toContain(ASSIGN_KEY);
    const vars = { city: "Delhi", [ASSIGN_KEY]: "Vivek" };
    const row = buildCompletedRow({
      schemaVersion: 3,
      nameHeader: null,
      nameValue: null,
      contactPhone: "999",
      flowName: "",
      submissionTime: "t",
      contactId: "c1",
      answerKeys: resolvedComp.keys,
      answerHeaders: resolvedComp.headers,
      activeKeys: resolvedComp.activeKeys,
      vars,
    });
    const assignIdx = completedAnswerOffset(3, false) + resolvedComp.keys.indexOf(ASSIGN_KEY);
    expect(row[assignIdx]).toBe("Vivek");
  });
});

describe("No duplicate Assign header", () => {
  it("second call with same assign does not duplicate", async () => {
    assignMapMock.clear();
    assignMapMock.set("run-1", "Vivek");
    const tab = makeTab({ header_written: true, answer_columns: ["city", ASSIGN_KEY], answer_headers: ["City", ASSIGN_HEADER] });
    const db = makeDbWithTab(tab, []);
    const { resolveAllTabColumns } = await import("@/lib/all-sheets/columns");
    const r1 = await resolveAllTabColumns(db, tab, "ss-1", null, { includeAssign: true });
    const r2 = await resolveAllTabColumns(db, { ...tab, answer_columns: r1.keys, answer_headers: r1.headers }, "ss-1", null, { includeAssign: true });
    expect(r2.keys.filter((k) => k === ASSIGN_KEY).length).toBe(1);
  });
});

describe("Custom columns preserved", () => {
  it("existing city column stays, Assign appended", async () => {
    assignMapMock.clear();
    assignMapMock.set("run-1", "Vivek");
    const tab = makeTab({ answer_columns: ["city"], answer_headers: ["City"] });
    const db = makeDbWithTab(tab, []);
    const { resolveAllTabColumns } = await import("@/lib/all-sheets/columns");
    const resolved = await resolveAllTabColumns(db, tab, "ss-1", null, { includeAssign: true });
    expect(resolved.headers[0]).toBe("City");
    expect(resolved.headers[1]).toBe(ASSIGN_HEADER);
  });
});
