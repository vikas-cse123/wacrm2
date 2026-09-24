import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "admin" as string | null,
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
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  } as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  updateError: null as { code?: string; message: string } | null,
  valueWrites: 0,
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
  const state = {
    table: "",
    patch: null as Record<string, unknown> | null,
  };
  chain.from = (table: string) => {
    state.table = table;
    return chain;
  };
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({ data: h.field, error: null });
  chain.single = async () => {
    if (h.updateError) return { data: null, error: h.updateError };
    return {
      data: { ...(h.field ?? {}), ...(state.patch ?? {}) },
      error: null,
    };
  };
  chain.update = (patch: Record<string, unknown>) => {
    state.patch = patch;
    h.updates.push(patch);
    return chain;
  };
  chain.delete = () => {
    if (state.table === "workspace_values") h.valueWrites += 1;
    return chain;
  };
  return chain;
}

const { PATCH, DELETE } = await import("./route");

function patch(body: unknown) {
  return new Request("https://app.test/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "flow-1", fieldId: "field-1" }) };

const BASE_FIELD = { ...(h.field as Record<string, unknown>) };

beforeEach(() => {
  h.role = "admin";
  h.accountId = "acct-1";
  h.field = { ...BASE_FIELD };
  h.updates = [];
  h.updateError = null;
  h.valueWrites = 0;
});

describe("PATCH workspace field", () => {
  it("renames and edits options/defaults", async () => {
    const res = await PATCH(
      patch({ name: "Lead Status", default_value: "Contacted" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { field: Record<string, unknown> };
    expect(json.field.name).toBe("Lead Status");
    expect(h.updates[0]).toMatchObject({ name: "Lead Status" });
  });

  it("rejects type changes", async () => {
    const res = await PATCH(patch({ field_type: "text" }), params);
    expect(res.status).toBe(400);
  });

  it("409s on rename collisions without touching values", async () => {
    h.updateError = { code: "23505", message: "duplicate" };
    const res = await PATCH(patch({ name: "Budget" }), params);
    expect(res.status).toBe(409);
    expect(h.valueWrites).toBe(0);
  });

  it("changing the default never rewrites history", async () => {
    const res = await PATCH(patch({ default_value: "Contacted" }), params);
    expect(res.status).toBe(200);
    // No value-table writes happen on a definition edit.
    expect(h.valueWrites).toBe(0);
    expect(h.updates[0]).toMatchObject({ default_value: "Contacted" });
  });

  it("changes a currency column's currency without touching values", async () => {
    h.field = {
      ...BASE_FIELD,
      field_type: "currency",
      options: null,
      default_value: "234234",
      currency_code: "INR",
    };
    const res = await PATCH(patch({ currency_code: "USD" }), params);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { field: Record<string, unknown> };
    expect(json.field.currency_code).toBe("USD");
    expect(json.field.default_value).toBe("234234");
    expect(h.valueWrites).toBe(0);
    expect(h.updates[0]).toMatchObject({ currency_code: "USD" });
  });

  it("rejects unsupported currencies on edit", async () => {
    h.field = {
      ...BASE_FIELD,
      field_type: "currency",
      options: null,
      default_value: null,
      currency_code: "INR",
    };
    const res = await PATCH(patch({ currency_code: "USDX" }), params);
    expect(res.status).toBe(400);
    expect(h.valueWrites).toBe(0);
  });

  it("404s cross-account fields", async () => {
    h.field = null;
    const res = await PATCH(patch({ name: "X" }), params);
    expect(res.status).toBe(404);
  });

  it("403s for agents", async () => {
    h.role = "agent";
    const res = await PATCH(patch({ name: "X" }), params);
    expect(res.status).toBe(403);
  });
});

describe("DELETE workspace field", () => {
  it("deletes the column (confirmation is UI-side)", async () => {
    const res = await DELETE(
      new Request("https://app.test/x", { method: "DELETE" }),
      params,
    );
    expect(res.status).toBe(200);
  });

  it("404s cross-account fields", async () => {
    h.field = null;
    const res = await DELETE(
      new Request("https://app.test/x", { method: "DELETE" }),
      params,
    );
    expect(res.status).toBe(404);
  });
});
