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
    width_px: number;
  }>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function widthsQuery(op: "select" | "delete") {
  const filters: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  q.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return q;
  };
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
        .map((r) => ({ column_key: r.column_key, width_px: r.width_px })),
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
    if (table === "workspace_column_widths") {
      return {
        select: () => widthsQuery("select"),
        delete: () => widthsQuery("delete"),
        upsert: (row: Record<string, unknown>) => {
          const key = row as {
            account_id: string;
            flow_id: string;
            column_key: string;
            width_px: number;
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

describe("GET column widths", () => {
  it("returns widths as a key→px map (viewers may read)", async () => {
    h.role = "viewer";
    h.rows = [
      { account_id: "acct-1", flow_id: "flow-1", column_key: "flow:name", width_px: 220 },
    ];
    const res = await get("flow-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ widths: { "flow:name": 220 } });
  });

  it("starts empty and 404s cross-account flows", async () => {
    expect(await (await get("flow-1")).json()).toEqual({ widths: {} });
    h.flow = null;
    expect((await get("flow-1")).status).toBe(404);
  });
});

describe("PUT column widths (3/4/5/7)", () => {
  it("stores a width that GET returns (persists across calls)", async () => {
    const saved = await put("flow-1", { column_key: "flow:name", width_px: 220 });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ column_key: "flow:name", width_px: 220 });
    expect(await (await get("flow-1")).json()).toEqual({
      widths: { "flow:name": 220 },
    });
  });

  it("clamps to integers; rejects out-of-band and non-numeric widths", async () => {
    expect((await put("flow-1", { column_key: "flow:name", width_px: 79 })).status).toBe(400);
    expect((await put("flow-1", { column_key: "flow:name", width_px: 501 })).status).toBe(400);
    expect((await put("flow-1", { column_key: "flow:name", width_px: "wide" })).status).toBe(400);
    expect((await put("flow-1", { column_key: "", width_px: 120 })).status).toBe(400);
    expect(h.rows).toHaveLength(0);
  });

  it("null resets one column to natural width", async () => {
    await put("flow-1", { column_key: "flow:name", width_px: 220 });
    const reset = await put("flow-1", { column_key: "flow:name", width_px: null });
    expect(reset.status).toBe(200);
    expect(await (await get("flow-1")).json()).toEqual({ widths: {} });
  });

  it("isolates flows: flow-2 sees none of flow-1's widths", async () => {
    await put("flow-1", { column_key: "flow:name", width_px: 220 });
    expect(await (await get("flow-2")).json()).toEqual({ widths: {} });
  });

  it("viewers cannot write; cross-account writes 404", async () => {
    h.role = "viewer";
    expect((await put("flow-1", { column_key: "flow:name", width_px: 120 })).status).toBe(403);
    h.role = "agent";
    h.flow = null;
    expect((await put("flow-1", { column_key: "flow:name", width_px: 120 })).status).toBe(404);
  });
});
