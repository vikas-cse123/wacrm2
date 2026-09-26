import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  authed: true,
  role: "viewer",
  accountId: "acct-1",
  userId: "user-1",
  flows: [] as Row[],
  settings: [] as Row[],
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
  },
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
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
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const rows = table === "flows" ? h.flows : h.settings;
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    const matched = () => rows.filter((r) => filters.every((f) => f(r)));
    q.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    q.single = async () => {
      const hit = matched()[0] ?? null;
      return hit
        ? { data: hit, error: null }
        : { data: null, error: { message: "no row", code: "PGRST116" } };
    };
    q.upsert = (obj: Row) => {
      const at = rows.findIndex(
        (r) => r.account_id === obj.account_id && r.flow_id === obj.flow_id,
      );
      const saved = { ...obj };
      if (at >= 0) rows[at] = { ...rows[at], ...saved };
      else rows.push(saved);
      return {
        select: () => ({ single: async () => ({ data: saved, error: null }) }),
      };
    };
    return q;
  };
  return api;
}

const { GET, PUT } = await import("./route");

function req(method: string, body?: unknown) {
  return new Request("https://app.test/api/flows/flow-1/travel-crm-settings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "flow-1" }) };

beforeEach(() => {
  h.authed = true;
  h.role = "viewer";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.flows = [{ id: "flow-1", account_id: "acct-1" }];
  h.settings = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET flow Travel CRM settings", () => {
  it("returns empty services when nothing is saved", async () => {
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ services: [], itinerary: [], departure: null });
  });

  it("loads the flow's own saved services", async () => {
    h.settings = [
      { account_id: "acct-1", flow_id: "flow-1", services: ["Hotel", "Flight"] },
      { account_id: "acct-1", flow_id: "flow-9", services: ["Cruise"] },
    ];
    const res = await GET(req("GET"), params);
    expect(await res.json()).toEqual({ services: ["Hotel", "Flight"], itinerary: [], departure: null });
  });

  it("404s cross-account flows", async () => {
    h.flows = [{ id: "flow-1", account_id: "acct-2" }];
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(404);
  });

  it("401s unauthenticated readers", async () => {
    h.authed = false;
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(401);
  });
});

describe("PUT flow Travel CRM settings", () => {
  it("saves selected services and reads them back", async () => {
    h.role = "agent";
    const res = await PUT(req("PUT", { services: ["Hotel", "Sightseeing"] }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ services: ["Hotel", "Sightseeing"], itinerary: [], departure: null });
    const reread = await GET(req("GET"), params);
    expect(await reread.json()).toEqual({ services: ["Hotel", "Sightseeing"], itinerary: [], departure: null });
  });

  it("replaces (never appends) on re-save", async () => {
    h.role = "agent";
    await PUT(req("PUT", { services: ["Hotel", "Flight"] }), params);
    await PUT(req("PUT", { services: ["Cruise"] }), params);
    expect(h.settings.filter((r) => r.flow_id === "flow-1")).toHaveLength(1);
    const reread = await GET(req("GET"), params);
    expect(await reread.json()).toEqual({ services: ["Cruise"], itinerary: [], departure: null });
  });

  it("is isolated by flow and account", async () => {
    h.role = "agent";
    await PUT(req("PUT", { services: ["Hotel"] }), params);
    h.flows = [
      { id: "flow-1", account_id: "acct-1" },
      { id: "flow-2", account_id: "acct-1" },
    ];
    const other = await GET(
      req("GET"),
      { params: Promise.resolve({ id: "flow-2" }) },
    );
    expect(await other.json()).toEqual({ services: [], itinerary: [], departure: null });
  });

  it("rejects unknown labels and non-lists", async () => {
    h.role = "agent";
    expect(
      (await PUT(req("PUT", { services: ["Teleport"] }), params)).status,
    ).toBe(400);
    expect((await PUT(req("PUT", { services: "Hotel" }), params)).status).toBe(400);
    expect((await PUT(req("PUT", {}), params)).status).toBe(400);
    expect(h.settings).toHaveLength(0);
  });

  it("403s viewers on write", async () => {
    const res = await PUT(req("PUT", { services: ["Hotel"] }), params);
    expect(res.status).toBe(403);
  });
});
