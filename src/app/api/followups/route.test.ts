import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-1",
  contact: { id: "c-1", account_id: "acct-1", phone: "+91111", name: "Rahul" } as Record<string, unknown> | null,
  conversation: null as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
  convoCreated: 0,
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

vi.mock("@/lib/conversations/get-or-create", () => ({
  getOrCreateConversation: async () => {
    h.convoCreated += 1;
    return { conversation: { id: "conv-9" }, created: true };
  },
}));

function fakeSupabase() {
  const state = { table: "", filters: [] as Array<[string, unknown]>, write: null as Record<string, unknown> | null };
  const matched = () =>
    h.rows.filter((r) => state.filters.every(([c, v]) => r[c] === v));
  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
    limit: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push([col, val]);
      return api;
    },
    maybeSingle: async () => {
      if (state.table === "contacts") return { data: h.contact, error: null };
      if (state.table === "conversations") return { data: h.conversation, error: null };
      return { data: null, error: null };
    },
    single: async () => {
      const row = {
        id: "fu-1",
        account_id: h.accountId,
        status: "scheduled",
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-23T00:00:00Z",
        ...(state.write ?? {}),
      };
      if (state.table === "whatsapp_followups" && state.write) h.rows.push(row);
      return { data: row, error: null };
    },
    insert: (obj: Record<string, unknown>) => {
      state.write = obj;
      return api;
    },
    then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
  };
  return { from: (table: string) => { state.table = table; return api; } };
}

const { GET, POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/followups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.contact = { id: "c-1", account_id: "acct-1", phone: "+91111", name: "Rahul" };
  h.conversation = null;
  h.rows = [];
  h.convoCreated = 0;
});

describe("GET /api/followups", () => {
  it("lists account-scoped rows for members", async () => {
    h.rows = [
      { id: "a", account_id: "acct-1", status: "scheduled" },
      { id: "b", account_id: "acct-2", status: "scheduled" },
    ];
    const res = await GET(new Request("https://app.test/api/followups?status=scheduled"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { followups: Array<{ id: string }> };
    expect(json.followups.map((r) => r.id)).toEqual(["a"]);
  });

  it("400s on an invalid status filter", async () => {
    const res = await GET(new Request("https://app.test/api/followups?status=bogus"));
    expect(res.status).toBe(400);
  });

  it("401s when unauthenticated", async () => {
    h.authed = false;
    const res = await GET(new Request("https://app.test/api/followups"));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/followups", () => {
  const valid = {
    contact_id: "c-1",
    scheduled_for: "2999-01-01T10:00:00.000Z",
    message_text: "Hi Rahul",
  };

  it("creates a scheduled follow-up with the caller's account", async () => {
    const res = await POST(post(valid));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { followup: Record<string, unknown> };
    expect(json.followup).toMatchObject({
      account_id: "acct-1",
      status: "scheduled",
      message_text: "Hi Rahul",
    });
    // No existing thread → resolved once via get-or-create (no dupes).
    expect(h.convoCreated).toBe(1);
  });

  it("rejects past times and viewers", async () => {
    const past = await POST(post({ ...valid, scheduled_for: "2000-01-01T00:00:00Z" }));
    expect(past.status).toBe(400);
    h.role = "viewer";
    const forbidden = await POST(post(valid));
    expect(forbidden.status).toBe(403);
  });

  it("404s cross-account contacts", async () => {
    h.contact = { id: "c-1", account_id: "acct-2", phone: "+91111", name: "X" };
    // Scoped lookup sees nothing → 404, never another account's contact.
    h.contact = null;
    const res = await POST(post(valid));
    expect(res.status).toBe(404);
  });
});
