import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  owned: true,
  storedNodeKeys: ["start", "hotel", "end"],
  flowPatch: null as Record<string, unknown> | null,
}));

function chainable(result: unknown) {
  const chain: Record<string, (...args: never[]) => unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.delete = () => chain;
  chain.update = (patch: Record<string, unknown>) => {
    h.flowPatch = patch;
    return chain;
  };
  chain.insert = () => chain;
  chain.maybeSingle = async () => ({ data: result, error: null });
  // Awaitable directly for update/delete/insert chains.
  (chain as { then: unknown }).then = (
    resolve: (v: { data: unknown; error: null }) => unknown,
  ) => Promise.resolve({ data: result, error: null }).then(resolve);
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            h.owned ? { data: { id: "flow-1" }, error: null } : { data: null, error: null },
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "flows") return chainable({ id: "flow-1" });
      return chainable(
        h.storedNodeKeys.map((node_key) => ({ node_key })),
      );
    },
  }),
}));

const { PUT } = await import("./route");

function put(body: unknown) {
  return PUT(
    new Request("https://app.test/api/flows/flow-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "flow-1" }) },
  );
}

beforeEach(() => {
  h.owned = true;
  h.storedNodeKeys = ["start", "hotel", "end"];
  h.flowPatch = null;
});

describe("PUT /api/flows/[id] completion point", () => {
  it("7. accepts a custom completion node matching the flow", async () => {
    const res = await put({
      completion_node_id: "hotel",
      nodes: [
        { node_key: "start", node_type: "start", config: {} },
        { node_key: "hotel", node_type: "collect_input", config: {} },
        { node_key: "end", node_type: "end", config: {} },
      ],
    });
    expect(res.status).toBe(200);
    expect(h.flowPatch).toMatchObject({ completion_node_id: "hotel" });
  });

  it("8. clearing back to null restores END behavior", async () => {
    const res = await put({ completion_node_id: null });
    expect(res.status).toBe(200);
    expect(h.flowPatch).toMatchObject({ completion_node_id: null });
  });

  it("rejects a completion key outside the flow", async () => {
    const res = await put({ completion_node_id: "nope" });
    expect(res.status).toBe(400);
    // Scalar single-point shape: one column, one value — selecting
    // another node later simply overwrites it (no second slot exists).
    expect(h.flowPatch).not.toMatchObject({ completion_node_id: "nope" });
  });

  it("validates against stored nodes when the save carries no graph", async () => {
    h.storedNodeKeys = ["start", "end"];
    const res = await put({ completion_node_id: "hotel" });
    expect(res.status).toBe(400);
  });

  it("15. saves without completion config leave existing flows untouched", async () => {
    const res = await put({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(h.flowPatch).not.toHaveProperty("completion_node_id");
    expect(h.flowPatch).toMatchObject({ name: "Renamed" });
  });
});
