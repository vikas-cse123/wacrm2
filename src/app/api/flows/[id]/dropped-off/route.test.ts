// ============================================================
// Dropped-off export sheet_include filtering.
//
// The one-shot export always creates a brand-new spreadsheet, so it
// must contain only enabled answer columns: nodes switched off via
// "Include in Google Sheet" never become headers, while unknown keys
// (deleted nodes) keep the conservative export-everything behavior.
// ============================================================

import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runs: [] as Record<string, unknown>[],
  contacts: [] as Record<string, unknown>[],
  nodes: [] as Record<string, unknown>[],
  flowExtra: {} as Record<string, unknown>,
}));

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const appendBodies: unknown[] = [];

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: vi.fn(async () => ({
    supabase: {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = vi.fn(() => b);
        b.eq = vi.fn(() => b);
        b.in = vi.fn(() => b);
        b.neq = vi.fn(() => b);
        b.order = vi.fn(() => b);
        b.maybeSingle = vi.fn(async () => {
          if (table === "flows") {
            return {
              data: { id: "flow-1", name: "Welcome Flow", ...h.flowExtra },
              error: null,
            };
          }
          return { data: null, error: null };
        });
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
          if (table === "flow_runs") {
            return resolve({ data: h.runs, error: null });
          }
          if (table === "contacts") {
            return resolve({ data: h.contacts, error: null });
          }
          if (table === "flow_nodes") {
            return resolve({ data: h.nodes, error: null });
          }
          return resolve({ data: null, error: null });
        };
        return b;
      },
    },
    accountId: "acct-1",
  })),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: String(err) }, { status: 500 }),
}));

vi.mock("@/lib/google/oauth", () => ({
  getValidAccessToken: vi.fn(async () => "tok"),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u === "https://sheets.googleapis.com/v4/spreadsheets") {
      return okJson({
        spreadsheetId: "ss-new",
        spreadsheetUrl: "https://sheets/new",
        properties: { title: "Welcome Flow — Dropped Off Users" },
        sheets: [{ properties: { title: "Sheet1" } }],
      });
    }
    if (u.includes(":append")) {
      appendBodies.push(
        init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
      );
      return okJson({});
    }
    return okJson({});
  }),
);

import { POST } from "./route";

function postDroppedOff() {
  return POST(
    new Request("http://localhost/api/flows/flow-1/dropped-off", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "flow-1" }) },
  );
}

describe("POST /api/flows/[id]/dropped-off", () => {
  it("omits disabled nodes while keeping enabled and unknown keys", async () => {
    h.runs = [
      {
        id: "run-1",
        contact_id: "c-1",
        vars: {
          rooms: "2",
          send_buttons: "Yes",
          send_buttons_4: "No",
          ghost: "kept",
        },
        started_at: "2026-07-14T10:00:00.000Z",
        ended_at: "2026-07-14T11:00:00.000Z",
      },
      {
        id: "run-2",
        contact_id: "c-1",
        vars: { rooms: "3" },
        started_at: "2026-07-14T10:05:00.000Z",
        ended_at: "2026-07-14T11:05:00.000Z",
      },
    ];
    h.contacts = [{ id: "c-1", name: "WA Name", phone: "+91" }];
    h.nodes = [
      {
        node_key: "rooms",
        node_type: "collect_input",
        config: { var_key: "rooms" },
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
    ];
    appendBodies.length = 0;

    const res = await postDroppedOff();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rowCount: 2 });

    const values = (appendBodies[0] as { values: string[][] }).values;
    // Header: fixed Name + V3 standards + enabled/unknown answers only.
    expect(values[0]).toEqual([
      "Name",
      "Phone Number",
      "Submission Time",
      "rooms",
      "ghost",
    ]);
    // Rows stay aligned with the header.
    expect(values[1]).toHaveLength(values[0]?.length);
    expect(values[1]?.slice(3)).toEqual(["2", "kept"]);
    expect(values[2]?.slice(3)).toEqual(["3", ""]);
  });
});

describe("POST /api/flows/[id]/dropped-off ordering", () => {
  it("lists answers in flow order despite shuffled nodes and vars", async () => {
    h.flowExtra = { entry_node_id: "start" };
    h.runs = [
      {
        id: "run-1",
        contact_id: "c-1",
        // Deliberately non-flow order.
        vars: { hotel: "H", rooms: "2", month: "May" },
        started_at: "2026-07-14T10:00:00.000Z",
        ended_at: "2026-07-14T11:00:00.000Z",
      },
    ];
    h.contacts = [{ id: "c-1", name: "WA Name", phone: "+91" }];
    // Deliberately shuffled storage order; edges define the flow.
    h.nodes = [
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
        config: {
          var_key: "rooms",
          prompt_text: "Rooms?",
          next_node_key: "hotel",
        },
      },
      {
        node_key: "month",
        node_type: "collect_input",
        config: {
          var_key: "month",
          prompt_text: "Month?",
          next_node_key: "rooms",
        },
      },
    ];
    appendBodies.length = 0;

    const res = await postDroppedOff();
    expect(res.status).toBe(200);

    const values = (appendBodies[0] as { values: string[][] }).values;
    expect(values[0]).toEqual([
      "Name",
      "Phone Number",
      "Submission Time",
      "Month?",
      "Rooms?",
      "Hotel?",
    ]);
    expect(values[1]?.slice(3)).toEqual(["May", "2", "H"]);
    h.flowExtra = {};
  });
});
