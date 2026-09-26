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

// NOTE: no Travel CRM fetch is ever needed here — departure options
// come from the copied static catalog, validated locally.

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

describe("1+3. departure defaults save per account + flow (catalog verified)", () => {
  it("saves India/Delhi and reads it back", async () => {
    h.role = "agent";
    const res = await PUT(
      req("PUT", {
        services: [],
        itinerary: [],
        departure: { country: "India", city: "Delhi" },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      services: [],
      itinerary: [],
      departure: { country: "India", city: "Delhi" },
    });
    const reread = await GET(req("GET"), params);
    expect(await reread.json()).toEqual({
      services: [],
      itinerary: [],
      departure: { country: "India", city: "Delhi" },
    });
  });

  it("returns null departure when nothing is saved", async () => {
    const res = await GET(req("GET"), params);
    expect(await res.json()).toEqual({ services: [], itinerary: [], departure: null });
  });

  it("country-only defaults are accepted (city null)", async () => {
    h.role = "agent";
    const res = await PUT(
      req("PUT", { services: [], itinerary: [], departure: { country: "India", city: "" } }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      services: [],
      itinerary: [],
      departure: { country: "India", city: null },
    });
  });

  it("null/empty clears stored defaults", async () => {
    h.role = "agent";
    await PUT(
      req("PUT", {
        services: [],
        itinerary: [],
        departure: { country: "India", city: "Delhi" },
      }),
      params,
    );
    const cleared = await PUT(
      req("PUT", { services: [], itinerary: [], departure: null }),
      params,
    );
    expect(((await cleared.json()) as { departure: unknown }).departure).toBeNull();
  });
});

describe("2+4. different flows have different departure defaults", () => {
  it("isolates by flow", async () => {
    h.role = "agent";
    h.flows = [
      { id: "flow-1", account_id: "acct-1" },
      { id: "flow-2", account_id: "acct-1" },
    ];
    await PUT(
      req("PUT", {
        services: [],
        itinerary: [],
        departure: { country: "India", city: "Mumbai" },
      }),
      params,
    );
    const other = await GET(req("GET"), {
      params: Promise.resolve({ id: "flow-2" }),
    });
    expect(await other.json()).toEqual({ services: [], itinerary: [], departure: null });
    await PUT(
      req("PUT", {
        services: [],
        itinerary: [],
        departure: { country: "United Arab Emirates", city: "Dubai" },
      }),
      { params: Promise.resolve({ id: "flow-2" }) },
    );
    const reread = await GET(req("GET"), params);
    expect(((await reread.json()) as { departure: unknown }).departure).toEqual({
      country: "India",
      city: "Mumbai",
    });
  });
});

describe("11. invalid combinations are rejected, never stored", () => {
  it("rejects unknown countries, unknown cities, and mismatched pairs", async () => {
    h.role = "agent";
    for (const departure of [
      { country: "Atlantis", city: null },
      { country: "India", city: "Atlantis" },
      { country: "India", city: "Dubai" },
      { country: "", city: "Delhi" },
    ]) {
      const res = await PUT(
        req("PUT", { services: [], itinerary: [], departure }),
        params,
      );
      expect(res.status).toBe(400);
    }
    expect(h.settings).toHaveLength(0);
  });

  it("omitting departure preserves stored values (backward compatible)", async () => {
    h.role = "agent";
    await PUT(
      req("PUT", {
        services: [],
        itinerary: [],
        departure: { country: "India", city: "Delhi" },
      }),
      params,
    );
    await PUT(req("PUT", { services: ["Hotel"], itinerary: [] }), params);
    const reread = (await (await GET(req("GET"), params)).json()) as {
      services: string[];
      departure: unknown;
    };
    expect(reread.services).toEqual(["Hotel"]);
    expect(reread.departure).toEqual({ country: "India", city: "Delhi" });
  });
});

describe("12+13. services and itinerary behavior unaffected", () => {
  it("departure round-trips alongside services and itinerary", async () => {
    h.role = "agent";
    const res = await PUT(
      req("PUT", {
        services: ["Hotel"],
        itinerary: [{ destination: "d", city: "c", nights: 2 }],
        departure: { country: "United Arab Emirates", city: null },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      services: ["Hotel"],
      itinerary: [{ destination: "d", city: "c", nights: 2 }],
      departure: { country: "United Arab Emirates", city: null },
    });
  });
});
