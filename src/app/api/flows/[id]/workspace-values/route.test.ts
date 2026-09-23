import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "agent" as string | null,
  accountId: "acct-1",
  field: {
    id: "field-1",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Status",
    field_type: "single_select",
    position: 0,
    options: ["New", "Contacted"],
    default_value: "New",
  } as Record<string, unknown> | null,
  run: { id: "run-1", account_id: "acct-1", flow_id: "flow-1" } as Record<
    string,
    string
  > | null,
  upserts: [] as Array<Record<string, unknown>>,
  deletes: 0,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
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
  const state = { table: "", row: null as Record<string, unknown> | null };
  chain.from = (table: string) => {
    state.table = table;
    return chain;
  };
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => {
    if (state.table === "workspace_fields") {
      return { data: h.field, error: null };
    }
    return { data: h.run, error: null };
  };
  chain.single = async () => ({
    data: { value_text: (state.row?.value_text as string) ?? null },
    error: null,
  });
  chain.upsert = (row: Record<string, unknown>) => {
    state.row = row;
    h.upserts.push(row);
    return chain;
  };
  chain.delete = () => {
    h.deletes += 1;
    return chain;
  };
  return chain;
}

const { PUT } = await import("./route");

function put(body: unknown) {
  return new Request("https://app.test/x", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "flow-1" }) };

beforeEach(() => {
  h.role = "agent";
  h.accountId = "acct-1";
  h.upserts = [];
  h.deletes = 0;
});

describe("PUT workspace values", () => {
  it("agents can set a valid cell value", async () => {
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Contacted" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { value: string };
    expect(json.value).toBe("Contacted");
    expect(h.upserts[0]).toMatchObject({
      account_id: "acct-1",
      field_id: "field-1",
      flow_run_id: "run-1",
      value_text: "Contacted",
    });
  });

  it("viewers cannot write values", async () => {
    h.role = "viewer";
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Contacted" }),
      params,
    );
    expect(res.status).toBe(403);
    expect(h.upserts).toHaveLength(0);
  });

  it("rejects values outside the options", async () => {
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Lost" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(h.upserts).toHaveLength(0);
  });

  it("clearing a cell deletes its value row", async () => {
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(h.deletes).toBe(1);
    expect(h.upserts).toHaveLength(0);
  });

  it("404s cross-account fields and cross-flow runs", async () => {
    // A field from another account is invisible (RLS + query scope).
    const savedField = h.field;
    h.field = null;
    const missing = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "New" }),
      params,
    );
    expect(missing.status).toBe(404);
    h.field = savedField;

    h.run = { id: "run-1", account_id: "acct-1", flow_id: "flow-OTHER" };
    const wrongFlow = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "New" }),
      params,
    );
    expect(wrongFlow.status).toBe(404);
    h.run = { id: "run-1", account_id: "acct-1", flow_id: "flow-1" };
  });
});
