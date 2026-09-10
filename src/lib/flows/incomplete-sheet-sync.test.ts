// ============================================================
// Incomplete-sheet sync behavior tests (V4 + sheet_include filtering).
//
// Pure layout math lives in sheet-layout.test.ts; these tests pin the
// orchestration glue with a mocked Supabase client and a mocked Google
// Sheets REST layer:
//   - V4 new sheets: no fixed Name, disabled keys never stored/displayed,
//     Run ID last + hidden, watermark + marker writes, flow-name fetch skip.
//   - V2 existing sheets: frozen positions, stored disabled cells blanked.
//   - Cleanup removes V4 rows by Run ID and clears the watermark.
//   - Run selection stays scoped (flow_id + watermark).
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatSubmissionTimeIST } from "../google/sheets";
import { INCOMPLETE_RUN_ID_HEADER } from "./sheet-layout";
import {
  syncIncompleteRunsForFlow,
  type IncompleteSheetConfigRow,
} from "./incomplete-sheet-sync";
import { cleanupCompletedIncompleteRows } from "./incomplete-sheet-cleanup";

vi.mock("@/lib/google/oauth", () => ({
  getValidAccessToken: vi.fn(async () => "tok"),
}));

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  body?: unknown;
}

const fetchCalls: FetchCall[] = [];
let headerRow: string[] = [];
let columnValues: string[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url);
      const body =
        init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
      fetchCalls.push({ url: u, body });
      if (u.includes("?fields=sheets.properties")) {
        return okJson({
          sheets: [{ properties: { sheetId: 7, title: "Sheet1" } }],
        });
      }
      if (u.includes("/values/") && u.includes("1:1")) {
        return okJson({ values: [headerRow] });
      }
      if (u.includes("/values/") && !u.includes(":append")) {
        return okJson({ values: [columnValues] });
      }
      return okJson({});
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchCalls.length = 0;
  headerRow = [];
  columnValues = [];
});

interface SelectCall {
  table: string;
  filters: Array<[string, string, unknown]>;
}

interface Scenario {
  runs: Record<string, unknown>[];
  flow?: Record<string, unknown> | null;
  contacts?: Record<string, unknown>[];
  nodes?: Record<string, unknown>[];
  runEvents?: Record<string, unknown>[];
  incompleteConfigs?: IncompleteSheetConfigRow[];
  completedRuns?: Record<string, unknown>[];
}

function makeDb(scenario: Scenario) {
  const selects: SelectCall[] = [];
  const updates: Array<{ table: string; payload: unknown }> = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];

  const from = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => {
      selects.push({ table, filters });
      return b;
    });
    const chain = (kind: string) => (col: string, val?: unknown) => {
      filters.push([kind, col, val]);
      return b;
    };
    b.eq = vi.fn(chain("eq"));
    b.in = vi.fn(chain("in"));
    b.is = vi.fn(chain("is"));
    b.gte = vi.fn(chain("gte"));
    b.lt = vi.fn(chain("lt"));
    b.not = vi.fn(chain("not"));
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.update = vi.fn((payload: unknown) => {
      updates.push({ table, payload });
      return b;
    });
    b.insert = vi.fn((payload: unknown) => {
      inserts.push({ table, payload });
      return b;
    });
    b.maybeSingle = vi.fn(async () => {
      if (table === "flows") return { data: scenario.flow ?? null, error: null };
      return { data: null, error: null };
    });
    b.single = vi.fn(async () => ({ data: null, error: null }));
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (table === "flow_runs" && scenario.completedRuns) {
        return resolve({ data: scenario.completedRuns, error: null });
      }
      if (table === "flow_runs") {
        return resolve({ data: scenario.runs, error: null });
      }
      if (table === "contacts") {
        return resolve({ data: scenario.contacts ?? [], error: null });
      }
      if (table === "flow_nodes") {
        return resolve({ data: scenario.nodes ?? [], error: null });
      }
      if (table === "flow_run_events") {
        return resolve({ data: scenario.runEvents ?? [], error: null });
      }
      if (table === "flow_incomplete_sheet_configs") {
        return resolve({ data: scenario.incompleteConfigs ?? [], error: null });
      }
      return resolve({ data: null, error: null });
    };
    return b;
  };

  return {
    db: { from } as unknown as SupabaseClient,
    selects,
    updates,
    inserts,
  };
}

function baseConfig(
  overrides: Partial<IncompleteSheetConfigRow> = {},
): IncompleteSheetConfigRow {
  return {
    flow_id: "flow-1",
    account_id: "acct-1",
    spreadsheet_id: "ss-1",
    spreadsheet_url: "https://sheets/1",
    spreadsheet_name: "Incomplete",
    sheet_tab: "Sheet1",
    answer_columns: [],
    header_written: false,
    ...overrides,
  };
}

const NODES = [
  {
    node_key: "name",
    node_type: "collect_input",
    config: { var_key: "name", prompt_text: "Your name?" },
  },
  {
    node_key: "rooms",
    node_type: "collect_input",
    config: { var_key: "rooms", prompt_text: "Rooms?" },
  },
  {
    node_key: "send_buttons",
    node_type: "send_buttons",
    config: { text: "Pick", sheet_include: false },
  },
  {
    node_key: "send_buttons_4",
    node_type: "send_buttons",
    config: { text: "Pick again", sheet_include: false },
  },
  {
    node_key: "color",
    node_type: "send_buttons",
    config: { text: "Color?" },
  },
];

describe("syncIncompleteRunsForFlow on a new V4 sheet", () => {
  it("writes slim headers/rows, filters disabled keys, hides Run ID, stamps state", async () => {
    stubFetch();
    const runs = [
      {
        id: "run-1",
        contact_id: "c-1",
        vars: {
          name: "Asha",
          rooms: "2",
          send_buttons: "Yes",
          send_buttons_4: "No",
          extra: "E",
        },
        started_at: "2026-07-14T10:00:00.000Z",
        ended_at: "2026-07-14T11:00:00.000Z",
      },
    ];
    const { db, selects, updates, inserts } = makeDb({
      runs,
      contacts: [{ id: "c-1", name: "WA Name", phone: "+911234567890" }],
      nodes: NODES,
    });

    const appended = await syncIncompleteRunsForFlow(
      db,
      baseConfig({ schema_version: 4 }),
      "tok",
    );
    expect(appended).toBe(1);

    // Run selection stays scoped to this flow's unsynced terminal runs.
    const runSelect = selects.find((s) => s.table === "flow_runs");
    expect(runSelect?.filters).toContainEqual(["eq", "flow_id", "flow-1"]);
    expect(runSelect?.filters).toContainEqual([
      "is",
      "incomplete_synced_at",
      null,
    ]);
    // V4 skips the flows.name lookup (no Flow Name cell).
    expect(selects.some((s) => s.table === "flows")).toBe(false);

    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const values = (append?.body as { values: string[][] }).values;
    expect(values[0]).toEqual([
      "Phone Number",
      "Submission Time",
      "name",
      "rooms",
      "extra",
      "Flow Run ID",
    ]);
    expect(values[1]?.[0]).toBe("+911234567890");
    expect(values[1]?.[1]).toBe(
      formatSubmissionTimeIST("2026-07-14T11:00:00.000Z"),
    );
    expect(values[1]?.slice(2)).toEqual(["Asha", "2", "E", "run-1"]);

    // Disabled keys are never persisted into answer_columns.
    const persisted = updates.find(
      (u) =>
        u.table === "flow_incomplete_sheet_configs" &&
        (u.payload as Record<string, unknown>).answer_columns !== undefined,
    );
    expect(
      (persisted?.payload as { answer_columns: string[] }).answer_columns,
    ).toEqual(["name", "rooms", "extra"]);

    // Hidden Run ID column targeted at its exact (last) index.
    const hide = fetchCalls.find((c) =>
      JSON.stringify(c.body ?? {}).includes("hiddenByUser"),
    );
    const range = (
      hide?.body as {
        requests: Array<{
          updateDimensionProperties: { range: Record<string, unknown> };
        }>;
      }
    ).requests[0]?.updateDimensionProperties.range;
    expect(range).toMatchObject({
      sheetId: 7,
      dimension: "COLUMNS",
      startIndex: 5,
      endIndex: 6,
    });

    // Watermark stamped + durable cleanup marker written.
    expect(
      updates.some(
        (u) =>
          u.table === "flow_runs" &&
          "incomplete_synced_at" in (u.payload as Record<string, unknown>),
      ),
    ).toBe(true);
    const marker = inserts.find((i) => i.table === "flow_run_events");
    expect(
      (marker?.payload as Array<{ payload: Record<string, unknown> }>)[0]
        ?.payload,
    ).toMatchObject({ incomplete_sheet_row_key_written: true });
  });
});

describe("syncIncompleteRunsForFlow on an existing V2 sheet", () => {
  it("keeps frozen positions and blanks stored disabled cells", async () => {
    stubFetch();
    const { db } = makeDb({
      runs: [
        {
          id: "run-2",
          contact_id: "c-1",
          vars: { city: "Goa", send_buttons: "Yes", newq: "N" },
          started_at: "2026-07-14T10:00:00.000Z",
          ended_at: "2026-07-14T11:00:00.000Z",
        },
      ],
      flow: { name: "Welcome Flow" },
      contacts: [{ id: "c-1", name: "WA Name", phone: "+91" }],
      nodes: [
        {
          node_key: "city",
          node_type: "collect_input",
          config: { var_key: "city" },
        },
        {
          node_key: "send_buttons",
          node_type: "send_buttons",
          config: { text: "Pick", sheet_include: false },
        },
        {
          node_key: "newq",
          node_type: "collect_input",
          config: { var_key: "newq" },
        },
      ],
    });

    await syncIncompleteRunsForFlow(
      db,
      baseConfig({
        schema_version: 2,
        answer_columns: ["city", "send_buttons"],
        header_written: true,
      }),
      "tok",
    );

    // Existing Run ID slot re-affirmed at the frozen V2 index (1+4+2).
    const headerWrite = fetchCalls.find((c) =>
      c.url.includes("values:batchUpdate"),
    );
    expect(
      (headerWrite?.body as { data: Array<{ range: string }> }).data,
    ).toContainEqual({
      range: "Sheet1!H1",
      values: [[INCOMPLETE_RUN_ID_HEADER]],
    });

    // New answer column inserted before Run ID; header label = raw key.
    const columnInsert = fetchCalls.find((c) =>
      JSON.stringify(c.body ?? {}).includes("insertDimension"),
    );
    expect(
      (
        columnInsert?.body as {
          requests: Array<{ insertDimension: { range: unknown } }>;
        }
      ).requests[0]?.insertDimension.range,
    ).toMatchObject({ startIndex: 7, endIndex: 8 });

    // Appended row: V2 width, disabled cell blank in place, new value before Run ID.
    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const row = (append?.body as { values: string[][] }).values[0];
    expect(row?.length).toBe(9);
    expect(row?.slice(0, 5)).toEqual([
      "WA Name",
      "+91",
      "Welcome Flow",
      formatSubmissionTimeIST("2026-07-14T11:00:00.000Z"),
      "c-1",
    ]);
    expect(row?.slice(5)).toEqual(["Goa", "", "N", "run-2"]);
  });

  it("nullish version defaults to the frozen V2 layout", async () => {
    stubFetch();
    const { db } = makeDb({
      runs: [
        {
          id: "run-3",
          contact_id: null,
          vars: {},
          started_at: "2026-07-14T10:00:00.000Z",
          ended_at: null,
        },
      ],
      flow: { name: "F" },
      nodes: [],
    });
    const { header_written: _hw, ...rest } = baseConfig();
    void _hw;
    await syncIncompleteRunsForFlow(
      db,
      { ...rest, header_written: false, schema_version: undefined },
      "tok",
    );
    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const header = (append?.body as { values: string[][] }).values[0];
    expect(header?.slice(0, 6)).toEqual([
      "Name",
      "Phone Number",
      "Flow Name",
      "Submission Time",
      "User ID",
      "Flow Run ID",
    ]);
  });
});

describe("cleanupCompletedIncompleteRows against a V4 sheet", () => {
  it("deletes the Run ID row and clears the watermark", async () => {
    headerRow = ["Phone Number", "Submission Time", "a", "Flow Run ID"];
    columnValues = ["", "run-9"];
    stubFetch();
    const { db, updates } = makeDb({
      runs: [],
      completedRuns: [{ id: "run-9", flow_id: "flow-1", account_id: "acct-1" }],
      runEvents: [
        {
          flow_run_id: "run-9",
          payload: { incomplete_sheet_row_key_written: true },
          created_at: "2026-07-14T10:00:00.000Z",
        },
        {
          flow_run_id: "run-9",
          payload: { node_type: "google_sheets_sync", result: "synced" },
          created_at: "2026-07-14T11:00:00.000Z",
        },
      ],
      incompleteConfigs: [baseConfig({ schema_version: 4 })],
    });

    const result = await cleanupCompletedIncompleteRows(db);
    expect(result.removed).toBe(1);

    const del = fetchCalls.find((c) =>
      JSON.stringify(c.body ?? {}).includes("deleteDimension"),
    );
    expect(
      (
        del?.body as {
          requests: Array<{ deleteDimension: { range: unknown } }>;
        }
      ).requests[0]?.deleteDimension.range,
    ).toMatchObject({
      sheetId: 7,
      dimension: "ROWS",
      startIndex: 2,
      endIndex: 3,
    });

    expect(
      updates.some(
        (u) =>
          u.table === "flow_runs" &&
          (u.payload as Record<string, unknown>).incomplete_synced_at ===
            null,
      ),
    ).toBe(true);
  });
});
