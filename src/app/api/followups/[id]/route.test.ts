import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  row: {
    id: "fu-1",
    account_id: "acct-1",
    contact_id: "c-1",
    status: "scheduled",
    scheduled_for: "2999-01-01T10:00:00.000Z",
    message_text: "Hi",
    template_name: null,
    template_language: null,
  } as Record<string, unknown> | null,
  writes: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
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
  const api: Record<string, unknown> = {
    select: () => api,
    eq: () => api,
    in: () => api,
    maybeSingle: async () => ({ data: h.row, error: null }),
    single: async () => ({ data: { ...(h.row ?? {}), ...lastWrite() }, error: null }),
    update: (patch: Record<string, unknown>) => {
      h.writes.push(patch);
      return api;
    },
  };
  function lastWrite() {
    return h.writes[h.writes.length - 1] ?? {};
  }
  return { from: () => api };
}

const { PATCH } = await import("./route");

function patch(body: unknown) {
  return new Request("https://app.test/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "fu-1" }) };

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.writes = [];
  (h.row as Record<string, unknown>).status = "scheduled";
});

describe("PATCH /api/followups/[id]", () => {
  it("edits a scheduled follow-up", async () => {
    const res = await PATCH(
      patch({ message_text: "Updated", scheduled_for: "2999-02-01T10:00:00.000Z" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(h.writes[0]).toMatchObject({ message_text: "Updated", status: "scheduled" });
  });

  it("cancels a scheduled follow-up (never sent after)", async () => {
    const res = await PATCH(patch({ action: "cancel" }), params);
    expect(res.status).toBe(200);
    expect(h.writes[0]).toMatchObject({ status: "cancelled" });
  });

  it("refuses to edit sent follow-ups", async () => {
    (h.row as Record<string, unknown>).status = "sent";
    const res = await PATCH(patch({ message_text: "Changed" }), params);
    expect(res.status).toBe(400);
  });

  it("404s cross-account ids and 403s viewers", async () => {
    h.row = null;
    const missing = await PATCH(patch({ action: "cancel" }), params);
    expect(missing.status).toBe(404);
    h.row = {
      id: "fu-1", account_id: "acct-1", contact_id: "c-1", status: "scheduled",
      scheduled_for: "2999-01-01T00:00:00.000Z", message_text: "Hi",
      template_name: null, template_language: null,
    };
    h.role = "viewer";
    const forbidden = await PATCH(patch({ action: "cancel" }), params);
    expect(forbidden.status).toBe(403);
  });
});
