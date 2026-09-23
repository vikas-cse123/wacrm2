import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "u-1" } as { id: string } | null,
  flow: {
    id: "flow-1",
    name: "Singapore Chat Automation",
    completion_node_id: null,
    entry_node_id: "start",
  } as Record<string, unknown> | null,
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "q0" },
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      node_key: "q0",
      node_type: "collect_input",
      config: {
        prompt_text: "May I know your Full Name?",
        var_key: "Name",
        next_node_key: "q1",
      },
      created_at: "2026-01-01T00:00:01.000Z",
    },
    {
      node_key: "q1",
      node_type: "collect_input",
      config: {
        prompt_text: "Travel date?",
        var_key: "TravelDate",
        next_node_key: "end",
      },
      created_at: "2026-01-01T00:00:02.000Z",
    },
    { node_key: "end", node_type: "end", config: {} },
  ],
  rpc: {
    total: 2,
    rows: [
      {
        run_id: "run-1",
        contact_id: "c-1",
        contact_name: "Rahul",
        contact_phone: "+91111",
        conversation_id: "conv-1",
        status: "completed",
        started_at: "2026-09-18T10:00:00.000Z",
        last_advanced_at: "2026-09-18T10:05:00.000Z",
        ended_at: "2026-09-18T10:05:00.000Z",
        reached_at: null,
        is_completed: true,
        vars: { Name: "Rahul", TravelDate: "October" },
      },
      {
        run_id: "run-2",
        contact_id: "c-2",
        contact_name: null,
        contact_phone: "+91222",
        conversation_id: null,
        status: "active",
        started_at: "2026-09-18T09:00:00.000Z",
        last_advanced_at: "2026-09-18T09:01:00.000Z",
        ended_at: null,
        reached_at: null,
        is_completed: false,
        vars: {},
      },
    ],
  },
  rpcArgs: null as Record<string, unknown> | null,
}));

function tableBuilder(rows: unknown) {
  const builder: Record<string, (...args: never[]) => unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.order = () => builder;
  builder.maybeSingle = async () => ({ data: rows, error: null });
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: (table: string) => {
      if (table === "flows") return tableBuilder(h.flow);
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: h.nodes, error: null }),
          }),
        }),
      };
    },
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      h.rpcArgs = args;
      return { data: h.rpc, error: null };
    },
  }),
}));

const { GET } = await import("./route");

beforeEach(() => {
  h.user = { id: "u-1" };
  h.flow = {
    id: "flow-1",
    name: "Singapore Chat Automation",
    completion_node_id: null,
    entry_node_id: "start",
  };
  h.rpcArgs = null;
});

describe("GET /api/flows/[id]/table", () => {
  it("3. returns the dynamic flow name with derived columns and run rows", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const meta = json.meta as Record<string, unknown>;
    // Flow name is dynamic — straight from the flow record.
    expect(meta.flowName).toBe("Singapore Chat Automation");
    expect(meta.completionNodeId).toBeNull();
    const columns = json.columns as Array<{ key: string; label: string }>;
    expect(columns.map((c) => c.key)).toContain("TravelDate");
    const rows = json.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // One row per flow_run_id with classification attached.
    expect(rows[0]).toMatchObject({ runId: "run-1", status: "completed" });
    expect(rows[1]).toMatchObject({ runId: "run-2", status: "incomplete" });
    // Dynamic answers projected; RPC was scoped to this flow.
    expect((rows[0] as { answers: unknown }).answers).toMatchObject({
      TravelDate: "October",
    });
    expect(h.rpcArgs).toMatchObject({ p_flow_id: "flow-1", p_view: "all" });
  });

  it("forwards the completed/incomplete view server-side", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table?view=completed"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({ p_view: "completed" });
  });

  it("rejects unknown views and unauthorized callers", async () => {
    const bad = await GET(
      new Request("https://app.test/api/flows/flow-1/table?view=done"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(bad.status).toBe(400);
    h.user = null;
    const anon = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(anon.status).toBe(401);
  });

  it("16. isolates accounts — another account's flow reads as not found", async () => {
    h.flow = null;
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(404);
  });
});
