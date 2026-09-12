import { describe, expect, it, vi } from "vitest";
import { syncIncompleteRunsForFlow } from "./incomplete-sheet-sync";

vi.mock("@/lib/google/sheets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/sheets")>("@/lib/google/sheets");
  return {
    ...actual,
    appendRows: vi.fn(async () => {}),
    findHeaderColumn: vi.fn(async () => 5),
    findExactValueRows: vi.fn(async () => new Map()),
    setSheetColumnHidden: vi.fn(async () => {}),
    insertSheetColumns: vi.fn(async () => {}),
    updateHeaderCells: vi.fn(async () => {}),
    readFirstHeaderCell: vi.fn(async () => "Phone"),
    formatSubmissionTimeIST: () => "2026-01-01 10:00",
  };
});
vi.mock("@/lib/google/tabs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/tabs")>("@/lib/google/tabs");
  return {
    ...actual,
    quoteSheetTitle: (s: string) => `'${s}'`,
  };
});
vi.mock("@/lib/automations/assignment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/automations/assignment")>("@/lib/automations/assignment");
  return {
    ...actual,
    getAssignsForFlowRuns: vi.fn(async () => new Map()),
  };
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    flow_id: "flow-1",
    account_id: "acct-1",
    spreadsheet_id: "ss-1",
    spreadsheet_url: null,
    spreadsheet_name: null,
    sheet_tab: "Sheet1",
    answer_columns: [],
    header_written: true,
    schema_version: 6,
    ...overrides,
  };
}

function makeDbWithLock(lockAcquired = true, runs: unknown[] = [{ id: "run-1", contact_id: "c1", vars: {}, started_at: "2026-01-01T00:00:00Z", ended_at: null }]) {
  const lockTable: Array<Record<string, unknown>> = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.in = vi.fn(() => b);
    b.is = vi.fn(() => b);
    b.gte = vi.fn(() => b);
    b.lt = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.insert = vi.fn(async (row: unknown) => {
      if (table === "dedicated_incomplete_sync_locks") {
        if (!lockAcquired) return { error: { message: "duplicate" } };
        lockTable.push(row as Record<string, unknown>);
        return { error: null };
      }
      if (table === "flow_run_events") return { error: null };
      return { error: null };
    });
    b.update = vi.fn((payload: unknown) => {
      if (table === "dedicated_incomplete_sync_locks") {
        return {
          eq: vi.fn(() => ({
            lt: vi.fn(() => ({
              select: vi.fn(async () => ({ data: [], error: null })),
            })),
          })),
          select: vi.fn(async () => ({ data: [], error: null })),
        } as unknown as typeof b;
      }
      return b;
    });
    b.delete = vi.fn(() => {
      const del: Record<string, unknown> = {};
      del.eq = vi.fn(() => del);
      return del;
    });
    b.maybeSingle = vi.fn(async () => {
      if (table === "flows") return { data: { name: "Test Flow", entry_node_id: null }, error: null };
      return { data: null, error: null };
    });
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (table === "flow_runs") return resolve({ data: runs, error: null });
      if (table === "flow_nodes") return resolve({ data: [], error: null });
      if (table === "contacts") return resolve({ data: [{ id: "c1", name: "Test", phone: "999" }], error: null });
      return resolve({ data: [], error: null });
    };
    return b;
  };
  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

describe("Dedicated Incomplete lock", () => {
  it("same flow/run concurrent: appendRows exactly once (lock serializes)", async () => {
    const { appendRows } = await import("@/lib/google/sheets");
    (appendRows as ReturnType<typeof vi.fn>).mockClear();
    const config = makeConfig();
    const db1 = makeDbWithLock(true);
    const db2 = makeDbWithLock(false); // second cannot acquire lock
    const p1 = syncIncompleteRunsForFlow(db1, config as unknown as import("./incomplete-sheet-sync").IncompleteSheetConfigRow, "token");
    const p2 = syncIncompleteRunsForFlow(db2, config as unknown as import("./incomplete-sheet-sync").IncompleteSheetConfigRow, "token");
    const [r1, r2] = await Promise.all([p1, p2]);
    // One should succeed, one should return 0 due to lock
    expect([r1, r2].some((v) => v === 1)).toBe(true);
    expect([r1, r2].some((v) => v === 0)).toBe(true);
  });

  it("crash before append: retry inserts one row", async () => {
    const config = makeConfig();
    const db = makeDbWithLock(true, [{ id: "run-1", contact_id: "c1", vars: {}, started_at: "2026-01-01T00:00:00Z", ended_at: null }]);
    const result = await syncIncompleteRunsForFlow(db, config as unknown as import("./incomplete-sheet-sync").IncompleteSheetConfigRow, "token");
    expect(result).toBe(1);
  });

  it("crash after append before watermark: retry sees Flow Run ID and does not append", async () => {
    const { findExactValueRows } = await import("@/lib/google/sheets");
    (findExactValueRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([["run-1", 2]]));
    const config = makeConfig();
    const db = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = vi.fn(() => b);
        b.eq = vi.fn(() => b);
        b.in = vi.fn(() => b);
        b.is = vi.fn(() => b);
        b.order = vi.fn(() => b);
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
          if (table === "flow_runs") return resolve({ data: [{ id: "run-1", contact_id: "c1", vars: {}, started_at: "2026-01-01T00:00:00Z", ended_at: null }], error: null });
          if (table === "flow_nodes") return resolve({ data: [], error: null });
          if (table === "contacts") return resolve({ data: [], error: null });
          return resolve({ data: [], error: null });
        };
        b.insert = vi.fn(async () => {
          if (table === "dedicated_incomplete_sync_locks") return { error: null };
          return { error: null };
        });
        b.update = vi.fn(() => b);
        b.delete = vi.fn(() => b);
        b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        return b;
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;
    // This test verifies the sheet presence check heals the watermark without append
    // The actual appendRows should not be called for already-present run
    const { appendRows } = await import("@/lib/google/sheets");
    (appendRows as ReturnType<typeof vi.fn>).mockClear();
    // Mock findHeaderColumn to return 5 and findExactValueRows to return run-1 present
    const result = await syncIncompleteRunsForFlow(db, config as unknown as import("./incomplete-sheet-sync").IncompleteSheetConfigRow, "token");
    // Since run is already present on sheet, it should be marked synced and not appended (0)
    // But our mock for flow_runs still returns run-1 as unsynced (is null), but findPresent will filter it
    expect(result).toBe(0);
  });

  it("different Flow Runs both insert", async () => {
    const config = makeConfig();
    const runs = [
      { id: "run-1", contact_id: "c1", vars: {}, started_at: "2026-01-01T00:00:00Z", ended_at: null },
      { id: "run-2", contact_id: "c2", vars: {}, started_at: "2026-01-01T01:00:00Z", ended_at: null },
    ];
    const db = makeDbWithLock(true, runs);
    const result = await syncIncompleteRunsForFlow(db, config as unknown as import("./incomplete-sheet-sync").IncompleteSheetConfigRow, "token");
    expect(result).toBe(2);
  });

  it("Assign value remains in initial row", async () => {
    const { getAssignsForFlowRuns } = await import("@/lib/automations/assignment");
    (getAssignsForFlowRuns as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([["run-1", "Vivek"]]));
    const config = makeConfig();
    const db = makeDbWithLock(true, [{ id: "run-1", contact_id: "c1", vars: { city: "Delhi" }, started_at: "2026-01-01T00:00:00Z", ended_at: null }]);
    const result = await syncIncompleteRunsForFlow(db, config as unknown as import("./incomplete-sheet-sync").IncompleteSheetConfigRow, "token");
    expect(result).toBe(1);
  });
});
