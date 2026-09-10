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
let a1Value: string | null | "ERROR" = null;

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
      if (u.includes("A1:A1")) {
        if (a1Value === "ERROR") {
          return new Response("boom", { status: 500 });
        }
        return okJson(a1Value === null ? {} : { values: [[a1Value]] });
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
  a1Value = null;
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
    // V4 still reads flows, but only for entry_node_id (canonical order)
    // — never for the removed Flow Name cell.
    expect(selects.some((s) => s.table === "flows")).toBe(true);

    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const values = (append?.body as { values: string[][] }).values;
    // Human-readable headers resolved from node config; unknown keys
    // keep their raw key. Row values stay key-addressed either way.
    expect(values[0]).toEqual([
      "Phone Number",
      "Submission Time",
      "Your name?",
      "Rooms?",
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
          // Renamed after the sheet was created: the frozen on-sheet
          // "city" header must NOT be rewritten to "Town".
          config: { var_key: "city", sheet_column_name: "Town" },
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

    // Stored raw headers are never rewritten: no header-cell write may
    // relabel the frozen "city" column as "Town".
    const writtenLabels = fetchCalls
      .filter((c) => c.url.includes("values:batchUpdate"))
      .flatMap(
        (c) =>
          (c.body as { data?: Array<{ values?: string[][] }> }).data ?? [],
      )
      .flatMap((d) => d.values ?? [])
      .flat();
    expect(writtenLabels).not.toContain("Town");
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

describe("syncIncompleteRunsForFlow answer ordering", () => {
  const GRAPH_NODES = [
    {
      node_key: "hotel",
      node_type: "collect_input",
      config: { var_key: "hotel", prompt_text: "Hotel?" },
    },
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "month" },
    },
    {
      node_key: "rooms",
      node_type: "collect_input",
      config: { var_key: "rooms", prompt_text: "Rooms?", next_node_key: "hotel" },
    },
    {
      node_key: "month",
      node_type: "collect_input",
      config: { var_key: "month", prompt_text: "Month?", next_node_key: "rooms" },
    },
  ];

  it("new V4 sheets follow flow order, not vars arrival order", async () => {
    stubFetch();
    const { db } = makeDb({
      runs: [
        {
          id: "run-4",
          contact_id: "c-1",
          // Deliberately non-flow order (as JSONB normalization may yield).
          vars: { hotel: "H", rooms: "2", month: "May" },
          started_at: "2026-07-14T10:00:00.000Z",
          ended_at: "2026-07-14T11:00:00.000Z",
        },
      ],
      flow: { entry_node_id: "start" },
      contacts: [{ id: "c-1", name: "WA Name", phone: "+91" }],
      nodes: GRAPH_NODES,
    });

    await syncIncompleteRunsForFlow(
      db,
      baseConfig({ schema_version: 4 }),
      "tok",
    );

    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const values = (append?.body as { values: string[][] }).values;
    expect(values[0]).toEqual([
      "Phone Number",
      "Submission Time",
      "Month?",
      "Rooms?",
      "Hotel?",
      "Flow Run ID",
    ]);
    expect(values[1]?.slice(2)).toEqual(["May", "2", "H", "run-4"]);
  });

  it("existing sheets append flow-sorted new keys without moving history", async () => {
    stubFetch();
    const { db, updates } = makeDb({
      runs: [
        {
          id: "run-5",
          contact_id: "c-1",
          vars: { rooms: "2", hotel: "H", month: "May" },
          started_at: "2026-07-14T10:00:00.000Z",
          ended_at: "2026-07-14T11:00:00.000Z",
        },
      ],
      flow: { name: "F", entry_node_id: "start" },
      contacts: [{ id: "c-1", name: "WA Name", phone: "+91" }],
      nodes: GRAPH_NODES,
    });

    await syncIncompleteRunsForFlow(
      db,
      baseConfig({
        schema_version: 2,
        answer_columns: ["rooms"],
        header_written: true,
      }),
      "tok",
    );

    // Stored "rooms" stays first; new keys arrive flow-sorted after it.
    const persisted = updates.find(
      (u) =>
        u.table === "flow_incomplete_sheet_configs" &&
        (u.payload as Record<string, unknown>).answer_columns !== undefined,
    );
    expect(
      (persisted?.payload as { answer_columns: string[] }).answer_columns,
    ).toEqual(["rooms", "month", "hotel"]);

    // Inserted as one block before the frozen Run ID slot (1+4+1 = 6).
    const columnInsert = fetchCalls.find((c) =>
      JSON.stringify(c.body ?? {}).includes("insertDimension"),
    );
    expect(
      (
        columnInsert?.body as {
          requests: Array<{ insertDimension: { range: unknown } }>;
        }
      ).requests[0]?.insertDimension.range,
    ).toMatchObject({ startIndex: 6, endIndex: 8 });

    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const row = (append?.body as { values: string[][] }).values[0];
    expect(row?.slice(5)).toEqual(["2", "May", "H", "run-5"]);
  });
});

describe("syncIncompleteRunsForFlow on a new V5 sheet", () => {
  it("writes WhatsApp Name + mapped headers with Run ID last and hidden", async () => {
    stubFetch();
    const { db, updates } = makeDb({
      runs: [
        {
          id: "run-6",
          contact_id: "c-1",
          vars: { name: "Asha", send_button_3: "Taj", rooms: "2" },
          started_at: "2026-07-14T10:00:00.000Z",
          ended_at: "2026-07-14T11:00:00.000Z",
        },
      ],
      flow: { entry_node_id: "start" },
      contacts: [{ id: "c-1", name: "WA Profile", phone: "+91" }],
      nodes: [
        {
          node_key: "start",
          node_type: "start",
          config: { next_node_key: "name" },
        },
        {
          node_key: "name",
          node_type: "collect_input",
          config: {
            var_key: "name",
            prompt_text: "Your name?",
            next_node_key: "send_button_3",
          },
        },
        {
          node_key: "send_button_3",
          node_type: "send_buttons",
          config: { text: "Pick a hotel?", next_node_key: "rooms" },
        },
        {
          node_key: "rooms",
          node_type: "collect_input",
          config: { var_key: "rooms", sheet_column_name: "No. of Rooms" },
        },
      ],
    });

    const appended = await syncIncompleteRunsForFlow(
      db,
      baseConfig({ schema_version: 5 }),
      "tok",
    );
    expect(appended).toBe(1);

    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const values = (append?.body as { values: string[][] }).values;
    expect(values[0]).toEqual([
      "WhatsApp Name",
      "Phone Number",
      "Submission Time",
      "Your name?",
      "Pick a hotel?",
      "No. of Rooms",
      "Flow Run ID",
    ]);
    // Fixed contact value first; flow-collected Name stays an answer.
    expect(values[1]?.slice(0, 4)).toEqual([
      "WA Profile",
      "+91",
      formatSubmissionTimeIST("2026-07-14T11:00:00.000Z"),
      "Asha",
    ]);
    expect(values[1]?.slice(-3)).toEqual(["Taj", "2", "run-6"]);

    // Stored keys (raw) are unaffected by header mapping.
    const persisted = updates.find(
      (u) =>
        u.table === "flow_incomplete_sheet_configs" &&
        (u.payload as Record<string, unknown>).answer_columns !== undefined,
    );
    expect(
      (persisted?.payload as { answer_columns: string[] }).answer_columns,
    ).toEqual(["name", "send_button_3", "rooms"]);

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
    expect(range).toMatchObject({ startIndex: 6, endIndex: 7 });
  });
});

describe("cleanupCompletedIncompleteRows against a V5 sheet", () => {
  it("finds the Run ID by name despite the renamed leading header", async () => {
    headerRow = [
      "WhatsApp Name",
      "Phone Number",
      "Submission Time",
      "Your name?",
      "Flow Run ID",
    ];
    columnValues = ["", "run-7"];
    stubFetch();
    const { db } = makeDb({
      runs: [],
      completedRuns: [{ id: "run-7", flow_id: "flow-1", account_id: "acct-1" }],
      runEvents: [
        {
          flow_run_id: "run-7",
          payload: { incomplete_sheet_row_key_written: true },
          created_at: "2026-07-14T10:00:00.000Z",
        },
        {
          flow_run_id: "run-7",
          payload: { node_type: "google_sheets_sync", result: "synced" },
          created_at: "2026-07-14T11:00:00.000Z",
        },
      ],
      incompleteConfigs: [baseConfig({ schema_version: 5 })],
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
  });
});

describe("syncIncompleteRunsForFlow on V6 sheets", () => {
  const V6_NODES = [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "name" },
    },
    {
      node_key: "name",
      node_type: "collect_input",
      config: {
        var_key: "name",
        prompt_text: "Your name?",
        next_node_key: "rooms",
      },
    },
    {
      node_key: "rooms",
      node_type: "collect_input",
      config: { var_key: "rooms", sheet_column_name: "No. of Rooms" },
    },
  ];

  function v6Run(vars: Record<string, unknown>) {
    return {
      id: "run-6",
      contact_id: "c-1",
      vars,
      started_at: "2026-07-14T10:00:00.000Z",
      ended_at: "2026-07-14T11:00:00.000Z",
    };
  }

  function v6Db(nodes: Record<string, unknown>[] = V6_NODES) {
    return makeDb({
      runs: [v6Run({ name: "Asha", rooms: "2" })],
      flow: { name: "F", entry_node_id: "start" },
      contacts: [{ id: "c-1", name: "WA Profile", phone: "+91" }],
      nodes,
    });
  }

  it("fresh sheet promotes the flow Name first with WhatsApp trailing", async () => {
    stubFetch();
    const { db, updates } = v6Db();

    const appended = await syncIncompleteRunsForFlow(
      db,
      baseConfig({ schema_version: 6 }),
      "tok",
    );
    expect(appended).toBe(1);

    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const values = (append?.body as { values: string[][] }).values;
    expect(values[0]).toEqual([
      "Your name?",
      "Phone Number",
      "Submission Time",
      "No. of Rooms",
      "WhatsApp Name",
      "Flow Run ID",
    ]);
    expect(values[1]).toEqual([
      "Asha",
      "+91",
      formatSubmissionTimeIST("2026-07-14T11:00:00.000Z"),
      "2",
      "WA Profile",
      "run-6",
    ]);

    // Promoted key excluded from persisted answers; Run ID hidden last.
    const persisted = updates.find(
      (u) =>
        u.table === "flow_incomplete_sheet_configs" &&
        (u.payload as Record<string, unknown>).answer_columns !== undefined,
    );
    expect(
      (persisted?.payload as { answer_columns: string[] }).answer_columns,
    ).toEqual(["rooms"]);
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
    expect(range).toMatchObject({ startIndex: 5, endIndex: 6 });
  });

  it("fresh sheet without a name node omits the first cell", async () => {
    stubFetch();
    const nodes = V6_NODES.filter((n) => n.node_key !== "name").map((n) =>
      n.node_key === "start"
        ? { ...n, config: { next_node_key: "rooms" } }
        : n,
    );
    const { db } = makeDb({
      runs: [v6Run({ rooms: "2" })],
      flow: { name: "F", entry_node_id: "start" },
      contacts: [{ id: "c-1", name: "WA Profile", phone: "+91" }],
      nodes,
    });

    await syncIncompleteRunsForFlow(db, baseConfig({ schema_version: 6 }), "tok");

    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const values = (append?.body as { values: string[][] }).values;
    expect(values[0]).toEqual([
      "Phone Number",
      "Submission Time",
      "No. of Rooms",
      "WhatsApp Name",
      "Flow Run ID",
    ]);
    expect(values[1]?.[0]).toBe("+91");
  });

  it("deleted name node later blanks the first cell without shifting", async () => {
    a1Value = "Your name?";
    stubFetch();
    const nodes = V6_NODES.filter((n) => n.node_key !== "name");
    const { db } = makeDb({
      runs: [v6Run({ rooms: "2" })],
      flow: { name: "F", entry_node_id: "start" },
      contacts: [{ id: "c-1", name: "WA Profile", phone: "+91" }],
      nodes,
    });

    await syncIncompleteRunsForFlow(
      db,
      baseConfig({
        schema_version: 6,
        answer_columns: ["rooms"],
        header_written: true,
      }),
      "tok",
    );

    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const row = (append?.body as { values: string[][] }).values[0];
    // Width preserved (6 cells incl. blank first + trailing WhatsApp).
    expect(row).toEqual([
      "",
      "+91",
      formatSubmissionTimeIST("2026-07-14T11:00:00.000Z"),
      "2",
      "WA Profile",
      "run-6",
    ]);
  });

  it("late-added name node folds in as a normal answer (no promotion)", async () => {
    a1Value = "Phone Number";
    stubFetch();
    const { db, updates } = v6Db();

    await syncIncompleteRunsForFlow(
      db,
      baseConfig({
        schema_version: 6,
        answer_columns: ["rooms"],
        header_written: true,
      }),
      "tok",
    );

    // "name" heals as a trailing answer; no first cell appears.
    const persisted = updates.find(
      (u) =>
        u.table === "flow_incomplete_sheet_configs" &&
        (u.payload as Record<string, unknown>).answer_columns !== undefined,
    );
    expect(
      (persisted?.payload as { answer_columns: string[] }).answer_columns,
    ).toEqual(["rooms", "name"]);
    // Physical insert lands BEFORE the trailing WhatsApp cell (index 3),
    // not at the Run ID index (4) — otherwise the new column would sit
    // after WhatsApp while rows render it before. This assertion is the
    // regression pin for that misalignment.
    const columnInsert = fetchCalls.find((c) =>
      JSON.stringify(c.body ?? {}).includes("insertDimension"),
    );
    expect(
      (
        columnInsert?.body as {
          requests: Array<{ insertDimension: { range: unknown } }>;
        }
      ).requests[0]?.insertDimension.range,
    ).toMatchObject({ startIndex: 3, endIndex: 4 });
    const labelWrite = fetchCalls.find(
      (c) =>
        c.url.includes("values:batchUpdate") &&
        JSON.stringify(c.body ?? {}).includes("Your name?"),
    );
    expect(
      (labelWrite?.body as { data: Array<{ range: string }> }).data,
    ).toContainEqual({ range: "Sheet1!D1", values: [["Your name?"]] });
    const append = fetchCalls.find((c) => c.url.includes(":append"));
    const row = (append?.body as { values: string[][] }).values[0];
    expect(row?.[0]).toBe("+91");
    expect(row?.slice(2, 4)).toEqual(["2", "Asha"]);
  });

  it("A1 read failure aborts before any write", async () => {
    a1Value = "ERROR";
    stubFetch();
    const { db, updates, inserts } = v6Db();

    await expect(
      syncIncompleteRunsForFlow(
        db,
        baseConfig({
          schema_version: 6,
          answer_columns: ["rooms"],
          header_written: true,
        }),
        "tok",
      ),
    ).rejects.toThrow();
    expect(fetchCalls.some((c) => c.url.includes(":append"))).toBe(false);
    expect(
      updates.some(
        (u) =>
          u.table === "flow_runs" &&
          "incomplete_synced_at" in (u.payload as Record<string, unknown>),
      ),
    ).toBe(false);
    expect(inserts.length).toBe(0);
  });
});

describe("cleanupCompletedIncompleteRows against a V6 sheet", () => {
  it("finds the Run ID by name across promoted and trailing cells", async () => {
    headerRow = [
      "Your name?",
      "Phone Number",
      "Submission Time",
      "No. of Rooms",
      "WhatsApp Name",
      "Flow Run ID",
    ];
    columnValues = ["", "", "run-10"];
    stubFetch();
    const { db, updates } = makeDb({
      runs: [],
      completedRuns: [{ id: "run-10", flow_id: "flow-1", account_id: "acct-1" }],
      runEvents: [
        {
          flow_run_id: "run-10",
          payload: { incomplete_sheet_row_key_written: true },
          created_at: "2026-07-14T10:00:00.000Z",
        },
        {
          flow_run_id: "run-10",
          payload: { node_type: "google_sheets_sync", result: "synced" },
          created_at: "2026-07-14T11:00:00.000Z",
        },
      ],
      incompleteConfigs: [baseConfig({ schema_version: 6 })],
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
      startIndex: 3,
      endIndex: 4,
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
