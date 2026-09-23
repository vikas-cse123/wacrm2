import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "admin" as string | null,
  accountId: "acct-1",
  flow: { id: "flow-1", account_id: "acct-1" } as Record<string, string> | null,
  fields: [] as Array<Record<string, unknown>>,
  insertError: null as { code?: string; message: string } | null,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.role) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId };
  },
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

function fakeSupabase() {
  const chain: Record<string, unknown> = {};
  const state = { table: "", op: "" as string, row: null as Record<string, unknown> | null };
  chain.from = (table: string) => {
    state.table = table;
    return chain;
  };
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = async () => {
    if (state.table === "flows") return { data: h.flow, error: null };
    if (state.table === "workspace_fields") {
      const row = h.fields[0] ?? null;
      return { data: row, error: null };
    }
    return { data: null, error: null };
  };
  chain.single = async () => {
    if (state.op === "insert") {
      if (h.insertError) return { data: null, error: h.insertError };
      return {
        data: {
          id: "field-1",
          account_id: h.accountId,
          flow_id: "flow-1",
          ...state.row,
          created_at: "2026-09-23T00:00:00Z",
          updated_at: "2026-09-23T00:00:00Z",
        },
        error: null,
      };
    }
    return { data: h.fields[0] ?? null, error: null };
  };
  chain.insert = (row: Record<string, unknown>) => {
    state.op = "insert";
    state.row = row;
    return chain;
  };
  return chain;
}

const { GET, POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/flows/flow-1/workspace-fields", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "flow-1" }) };

beforeEach(() => {
  h.role = "admin";
  h.accountId = "acct-1";
  h.flow = { id: "flow-1", account_id: "acct-1" };
  h.fields = [];
  h.insertError = null;
});

describe("GET workspace fields", () => {
  it("lists fields for members and 404s cross-account flows", async () => {
    h.role = "agent";
    h.fields = [{ id: "f1" }];
    const res = await GET(new Request("https://app.test/x"), params);
    expect(res.status).toBe(200);

    h.flow = { id: "flow-1", account_id: "acct-2" };
    const cross = await GET(new Request("https://app.test/x"), params);
    expect(cross.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    h.role = null;
    const res = await GET(new Request("https://app.test/x"), params);
    expect(res.status).toBe(401);
  });
});

describe("POST workspace fields", () => {
  it("creates a text column as admin (201)", async () => {
    const res = await POST(post({ name: "Status", field_type: "text" }), params);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { field: Record<string, unknown> };
    expect(json.field).toMatchObject({ name: "Status", field_type: "text" });
  });

  it("creates a single-select column with options and default", async () => {
    const res = await POST(
      post({
        name: "Status",
        field_type: "single_select",
        options: ["New", "Contacted"],
        default_value: "New",
      }),
      params,
    );
    expect(res.status).toBe(201);
  });

  it("403s for agents and viewers", async () => {
    h.role = "agent";
    const res = await POST(post({ name: "X", field_type: "text" }), params);
    expect(res.status).toBe(403);
  });

  it("400s on empty name and unknown type", async () => {
    expect(
      (await POST(post({ name: "  ", field_type: "text" }), params)).status,
    ).toBe(400);
    expect(
      (await POST(post({ name: "X", field_type: "formula" }), params)).status,
    ).toBe(400);
  });

  it("400s when select options are missing", async () => {
    const res = await POST(
      post({ name: "S", field_type: "single_select" }),
      params,
    );
    expect(res.status).toBe(400);
  });

  it("409s on duplicate column names", async () => {
    h.insertError = { code: "23505", message: "duplicate" };
    const res = await POST(post({ name: "Status", field_type: "text" }), params);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/already exists/i);
  });

  it("404s cross-account flows without leaking", async () => {
    h.flow = { id: "flow-1", account_id: "acct-2" };
    const res = await POST(post({ name: "X", field_type: "text" }), params);
    expect(res.status).toBe(404);
  });
});
