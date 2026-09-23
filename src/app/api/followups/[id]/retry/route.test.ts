import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "agent",
  accountId: "acct-1",
  row: {
    id: "fu-1",
    account_id: "acct-1",
    status: "failed",
  } as Record<string, unknown> | null,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
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
    update: () => api,
    single: async () => ({ data: h.row, error: null }),
  };
  return { from: () => api };
}

const { POST } = await import("./route");
const params = { params: Promise.resolve({ id: "fu-1" }) };

beforeEach(() => {
  h.role = "agent";
});

describe("POST /api/followups/[id]/retry", () => {
  it("re-arms failed follow-ups only", async () => {
    const res = await POST(
      new Request("https://app.test/x", { method: "POST" }),
      params,
    );
    expect(res.status).toBe(200);
  });

  it("403s viewers", async () => {
    h.role = "viewer";
    const res = await POST(
      new Request("https://app.test/x", { method: "POST" }),
      params,
    );
    expect(res.status).toBe(403);
  });
});
