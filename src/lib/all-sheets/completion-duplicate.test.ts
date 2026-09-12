import { describe, expect, it, vi } from "vitest";
import { importAllSheetCompleted, findCompletedRowsPresent } from "./sync";

vi.mock("@/lib/google/sheets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/sheets")>("@/lib/google/sheets");
  return {
    ...actual,
    appendRows: vi.fn(async () => {}),
    findHeaderColumn: vi.fn(async () => 5),
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
  };
});
vi.mock("@/lib/automations/assignment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/automations/assignment")>("@/lib/automations/assignment");
  return {
    ...actual,
    getAssignsForFlowRuns: vi.fn(async () => new Map()),
  };
});

describe("findCompletedRowsPresent", () => {
  it("returns empty set when header not found", async () => {
    const { findHeaderColumn } = await import("@/lib/google/sheets");
    (findHeaderColumn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await findCompletedRowsPresent("token", "ss-1", "Flow", ["run-1"]);
    expect(result.size).toBe(0);
  });
  it("returns set of found runIds", async () => {
    const { findExactValueRows, findHeaderColumn } = await import("@/lib/google/sheets");
    (findHeaderColumn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(5);
    (findExactValueRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([["run-1", 2]]));
    const result = await findCompletedRowsPresent("token", "ss-1", "Flow", ["run-1", "run-2"]);
    expect(result.has("run-1")).toBe(true);
    expect(result.has("run-2")).toBe(false);
  });
});

describe("All Sheets Completed sheet-idempotent", () => {
  it("does not append when Flow Run ID already present on sheet (crash recovery)", async () => {
    const tab = {
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
    };
    const db = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = vi.fn(() => b);
        b.eq = vi.fn(() => b);
        b.in = vi.fn(() => b);
        b.order = vi.fn(() => b);
        b.limit = vi.fn(() => b);
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
          if (table === "flow_runs") return resolve({ data: [{ id: "run-1", contact_id: "c1", vars: {}, started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T01:00:00Z" }], error: null });
          if (table === "all_sheet_tab_run_state") return resolve({ data: [], error: null });
          return resolve({ data: [], error: null });
        };
        b.upsert = vi.fn(async () => ({ error: null }));
        b.update = vi.fn(() => b);
        return b;
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { findExactValueRows } = await import("@/lib/google/sheets");
    (findExactValueRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([["run-1", 2]]));
    const { appendRows } = await import("@/lib/google/sheets");
    (appendRows as ReturnType<typeof vi.fn>).mockClear();
    const { importAllSheetCompleted: fn } = await import("./sync");
    // Need to mock findHeaderColumn to return 5 so present check works
    const { findHeaderColumn } = await import("@/lib/google/sheets");
    (findHeaderColumn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(5);
    const collection = { id: "col-1", account_id: "acct-1", spreadsheet_id: "ss-1", kind: "completed" } as unknown as import("./types").AllSheetCollectionRow;
    const result = await fn(db, collection, tab as unknown as import("./types").AllSheetFlowTabRow, "token", { runIds: ["run-1"] });
    expect(result.imported).toBe(0);
    expect((appendRows as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
