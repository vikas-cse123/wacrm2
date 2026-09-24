import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "agent" as string | null,
  accountId: "acct-1",
  flow: {
    id: "flow-1",
    account_id: "acct-1",
  } as Record<string, unknown> | null,
  rows: [] as Array<{
    account_id: string;
    flow_id: string;
    column_key: string;
    color: string;
  }>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function hcQuery(op: "select" | "delete") {
  const filters: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  q.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return q;
  };
  // Thenable: `await query` resolves the filtered result, so the
  // chained `.eq()` calls behave like the real builder.
  q.then = (resolve: (v: unknown) => unknown) => {
    if (op === "delete") {
      h.rows = h.rows.filter(
        (r) =>
          !(
            r.account_id === filters.account_id &&
            r.flow_id === filters.flow_id &&
            (filters.column_key === undefined || r.column_key === filters.column_key)
          ),
      );
      return resolve({ data: null, error: null });
    }
    return resolve({
      data: h.rows
        .filter(
          (r) =>
            r.account_id === filters.account_id && r.flow_id === filters.flow_id,
        )
        .map((r) => ({ column_key: r.column_key, color: r.color })),
      error: null,
    });
  };
  return q;
}

function fakeSupabase() {
  const chain: Record<string, unknown> = {};
  chain.from = (table: string) => {
    if (table === "flows") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: h.flow, error: null }),
          }),
        }),
      };
    }
    if (table === "workspace_header_colors") {
      return {
        select: () => hcQuery("select"),
        delete: () => hcQuery("delete"),
        upsert: (row: Record<string, unknown>) => {
          const key = row as {
            account_id: string;
            flow_id: string;
            column_key: string;
            color: string;
          };
          h.rows = h.rows.filter(
            (r) =>
              !(
                r.account_id === key.account_id &&
                r.flow_id === key.flow_id &&
                r.column_key === key.column_key
              ),
          );
          h.rows.push({ ...key });
          return {};
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  return chain;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
  }),
  requireRole: async (min: string) => {
    if (!h.role) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = {
      viewer: 1,
      agent: 2,
      admin: 3,
      owner: 4,
    };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) {
      throw statusError(403, "Forbidden");
    }
    return { supabase: fakeSupabase(), accountId: h.accountId };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

const { GET, PUT } = await import("./route");

function get(flowId: string) {
  return GET(new Request("https://app.test/x"), {
    params: Promise.resolve({ id: flowId }),
  });
}

function put(flowId: string, body: unknown) {
  return PUT(
    new Request("https://app.test/x", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: flowId }) },
  );
}

beforeEach(() => {
  h.role = "agent";
  h.accountId = "acct-1";
  h.flow = { id: "flow-1", account_id: "acct-1" };
  h.rows = [];
});

describe("GET header colors", () => {
  it("returns overrides as a key→color map (viewers may read)", async () => {
    h.role = "viewer";
    h.rows = [
      { account_id: "acct-1", flow_id: "flow-1", column_key: "custom:a", color: "#123456" },
    ];
    const res = await get("flow-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ colors: { "custom:a": "#123456" } });
  });

  it("starts empty and 404s cross-account flows", async () => {
    const empty = await get("flow-1");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ colors: {} });

    h.flow = null;
    const missing = await get("flow-1");
    expect(missing.status).toBe(404);
  });
});

describe("PUT header colors (3/4/5/8)", () => {
  it("stores a custom color that GET returns (persists across calls)", async () => {
    const saved = await put("flow-1", { column_key: "custom:a", color: "#FCE7F3" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ column_key: "custom:a", color: "#fce7f3" });

    const listed = await get("flow-1");
    expect(await listed.json()).toEqual({ colors: { "custom:a": "#fce7f3" } });
  });

  it("changing one column leaves the other untouched", async () => {
    await put("flow-1", { column_key: "custom:a", color: "#111111" });
    await put("flow-1", { column_key: "flow:name", color: "#222222" });
    await put("flow-1", { column_key: "custom:a", color: "#333333" });
    expect(await (await get("flow-1")).json()).toEqual({
      colors: { "custom:a": "#333333", "flow:name": "#222222" },
    });
  });

  it("null resets one column to its default", async () => {
    await put("flow-1", { column_key: "custom:a", color: "#111111" });
    const reset = await put("flow-1", { column_key: "custom:a", color: null });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ column_key: "custom:a", color: null });
    expect(await (await get("flow-1")).json()).toEqual({ colors: {} });
  });

  it("isolates flows: flow-2 sees none of flow-1's colors", async () => {
    await put("flow-1", { column_key: "custom:a", color: "#111111" });
    expect(await (await get("flow-2")).json()).toEqual({ colors: {} });
    await put("flow-2", { column_key: "custom:a", color: "#222222" });
    expect(await (await get("flow-1")).json()).toEqual({
      colors: { "custom:a": "#111111" },
    });
  });

  it("rejects bad keys and non-hex colors", async () => {
    expect((await put("flow-1", { column_key: "", color: "#111111" })).status).toBe(400);
    expect((await put("flow-1", { column_key: "custom:a" })).status).toBe(400);
    expect((await put("flow-1", { column_key: "custom:a", color: "red" })).status).toBe(400);
    expect(h.rows).toHaveLength(0);
  });

  it("5. rejects a color another column already uses (409), verbosely", async () => {
    await put("flow-1", { column_key: "custom:a", color: "#111111" });
    const clash = await put("flow-1", { column_key: "custom:b", color: "#111111" });
    expect(clash.status).toBe(409);
    const payload = (await clash.json()) as { error: string };
    expect(payload.error).toMatch(/already used by another column/i);
    // Loser row never stored; winner untouched.
    expect(h.rows).toHaveLength(1);
    expect(await (await get("flow-1")).json()).toEqual({
      colors: { "custom:a": "#111111" },
    });
  });

  it("re-saving a column's own color stays idempotent (200)", async () => {
    await put("flow-1", { column_key: "custom:a", color: "#111111" });
    const again = await put("flow-1", { column_key: "custom:a", color: "#111111" });
    expect(again.status).toBe(200);
  });

  it("viewers cannot write; cross-account writes 404", async () => {
    h.role = "viewer";
    const forbidden = await put("flow-1", { column_key: "custom:a", color: "#111111" });
    expect(forbidden.status).toBe(403);

    h.role = "agent";
    h.flow = null;
    const missing = await put("flow-1", { column_key: "custom:a", color: "#111111" });
    expect(missing.status).toBe(404);
  });
});
