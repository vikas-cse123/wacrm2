// ============================================================
// POST /api/flows/[id]/incomplete-sheet creation test.
//
// Proves the version contract end to end: the DB stamp and the first
// sync receive the SAME version (CURRENT_INCOMPLETE_SCHEMA_VERSION),
// so the first header/row write uses the layout all later syncs read
// back. A stale literal here once wrote the first header as V3 on a
// v6-config sheet — every later row misaligned. This test inspects the
// stamped payload AND the first appended header/row to pin the fix.
// ============================================================

import { describe, expect, it, vi } from "vitest";

import { CURRENT_INCOMPLETE_SCHEMA_VERSION } from "@/lib/flows/sheet-layout";

const h = vi.hoisted(() => ({
  runs: [] as Record<string, unknown>[],
  contacts: [] as Record<string, unknown>[],
  nodes: [] as Record<string, unknown>[],
  flow: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
  updates: [] as Array<{ table: string; payload: unknown }>,
  inserts: [] as Array<{ table: string; payload: unknown }>,
  appends: [] as unknown[],
  createdSheets: 0,
}));

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeDb() {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.in = vi.fn(() => b);
    b.is = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.update = vi.fn((payload: unknown) => {
      h.updates.push({ table, payload });
      return b;
    });
    b.insert = vi.fn((payload: unknown) => {
      h.inserts.push({ table, payload });
      return b;
    });
    b.maybeSingle = vi.fn(async () => {
      if (table === "flows") return { data: h.flow, error: null };
      if (table === "flow_incomplete_sheet_configs") {
        return { data: h.existing, error: null };
      }
      return { data: null, error: null };
    });
    b.single = vi.fn(async () => {
      if (table === "flow_incomplete_sheet_configs") {
        const payload = h.inserts
          .filter((i) => i.table === table)
          .map((i) => i.payload as Record<string, unknown>)
          .at(-1);
        return {
          data: {
            header_written: false,
            answer_columns: [],
            ...(payload ?? {}),
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (table === "flow_runs") return resolve({ data: h.runs, error: null });
      if (table === "contacts")
        return resolve({ data: h.contacts, error: null });
      if (table === "flow_nodes")
        return resolve({ data: h.nodes, error: null });
      return resolve({ data: null, error: null });
    };
    return b;
  };
  return { from };
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: vi.fn(async () => ({ supabase: makeDb(), accountId: "acct-1" })),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: String(err) }, { status: 500 }),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: vi.fn(() => makeDb()),
}));

vi.mock("@/lib/google/oauth", () => ({
  getValidAccessToken: vi.fn(async () => "tok"),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: unknown, init?: { body?: unknown; method?: string }) => {
    const u = String(url);
    if (
      u === "https://sheets.googleapis.com/v4/spreadsheets" &&
      init?.method === "POST"
    ) {
      h.createdSheets += 1;
      return okJson({
        spreadsheetId: "ss-new",
        spreadsheetUrl: "https://sheets/new",
        properties: { title: "F — Incomplete Runs (Live)" },
        sheets: [{ properties: { sheetId: 7, title: "Sheet1" } }],
      });
    }
    if (u.includes("?fields=sheets.properties")) {
      return okJson({
        sheets: [{ properties: { sheetId: 7, title: "Sheet1" } }],
      });
    }
    if (u.includes(":append")) {
      h.appends.push(
        init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
      );
      return okJson({});
    }
    return okJson({});
  }),
);

import { POST } from "./route";

describe("POST /api/flows/[id]/incomplete-sheet version contract", () => {
  it("stamps v6 and writes the first header/row as V6", async () => {
    h.flow = { id: "flow-1", name: "F", entry_node_id: "start" };
    h.existing = null;
    h.runs = [
      {
        id: "run-1",
        contact_id: "c-1",
        vars: { name: "Asha", rooms: "2" },
        started_at: "2026-07-14T10:00:00.000Z",
        ended_at: "2026-07-14T11:00:00.000Z",
      },
    ];
    h.contacts = [{ id: "c-1", name: "WA Profile", phone: "+91" }];
    h.nodes = [
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
    h.updates.length = 0;
    h.inserts.length = 0;
    h.appends.length = 0;
    h.createdSheets = 0;

    const res = await POST(
      new Request("http://localhost/api/flows/flow-1/incomplete-sheet", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    expect(h.createdSheets).toBe(1);

    // DB stamp uses the current version constant (no stale literal).
    const stamp = h.updates.find(
      (u) =>
        u.table === "flow_incomplete_sheet_configs" &&
        "schema_version" in (u.payload as Record<string, unknown>),
    );
    expect(
      (stamp?.payload as { schema_version: number }).schema_version,
    ).toBe(CURRENT_INCOMPLETE_SCHEMA_VERSION);
    expect(CURRENT_INCOMPLETE_SCHEMA_VERSION).toBe(6);

    // The first appended header/row prove the first sync ran as V6:
    // promoted flow Name first, WhatsApp trailing, Run ID last — and no
    // trace of a V3 first write (no Flow Name / User ID cells).
    const values = (h.appends[0] as { values: string[][] }).values;
    expect(values[0]).toEqual([
      "Your name?",
      "Phone Number",
      "Submission Time",
      "No. of Rooms",
      "WhatsApp Name",
      "Flow Run ID",
    ]);
    expect(values[1]?.slice(0, 2)).toEqual(["Asha", "+91"]);
    expect(values[1]?.slice(-2)).toEqual(["WA Profile", "run-1"]);
    expect(values.flat()).not.toContain("Flow Name");
    expect(values.flat()).not.toContain("User ID");

    const json = (await res.json()) as { imported: number };
    expect(json.imported).toBe(1);
  });
});
