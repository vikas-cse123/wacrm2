import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The analytics route resolves the caller via getCurrentAccount and
// runs the RPC plus a WHATSAPP_FOLLOWUPS count. We stub the account
// context and the two queries, then assert the count filter uses the
// shared pending reminder statuses (scheduled + processing only).

const h = vi.hoisted(() => ({
  rpcData: {} as Record<string, unknown>,
  countResult: { count: 0, error: null } as {
    count: number | null;
    error: unknown;
  },
  countFilter: { accountId: "", statuses: [] as string[] },
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: {
      rpc: vi.fn(async () => ({ data: h.rpcData, error: null })),
      from: (table: string) => {
        if (table === "whatsapp_followups") {
          const q: Record<string, unknown> = {};
          q.select = () => q;
          q.eq = (col: string, val: unknown) => {
            if (col === "account_id") h.countFilter.accountId = String(val);
            return q;
          };
          q.in = (col: string, vals: string[]) => {
            if (col === "status") h.countFilter.statuses = [...vals];
            return q;
          };
          q.then = (resolve: (v: unknown) => void) => resolve(h.countResult);
          return q;
        }
        return {
          select: () => ({ then: (resolve: (v: unknown) => void) => resolve({ error: null }) }),
        };
      },
    },
    userId: "user-1",
    accountId: "acct-1",
    role: "owner",
    account: { id: "acct-1", name: "Acme" },
  }),
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

const { GET } = await import("./route");

const URL =
  "https://app.test/api/dashboard/analytics?start=2026-09-22T00:00:00.000Z&end=2026-09-23T00:00:00.000Z&prevStart=2026-09-21T00:00:00.000Z&prevEnd=2026-09-22T00:00:00.000Z&yearStart=2026-01-01T00:00:00.000Z&yearEnd=2027-01-01T00:00:00.000Z&year=2026&tz=UTC";

beforeEach(() => {
  h.rpcData = {
    kpis: { uniqueContacts: { current: 7, previous: 3 } },
    flowBreakdown: { totalContacts: 7, rows: [] },
    dailyContacts: [],
    dailyFlows: [],
    monthlyUniqueContacts: [],
    monthlyFlows: [],
  };
  h.countResult = { count: 4, error: null };
  h.countFilter = { accountId: "", statuses: [] };
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/dashboard/analytics", () => {
  it("counts pending reminders only (scheduled/processing) for the account", async () => {
    const res = await GET(new Request(URL));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scheduledReminderCount?: unknown };
    expect(json.scheduledReminderCount).toBe(4);
    // Account-scoped and limited to the shared pending statuses.
    expect(h.countFilter.accountId).toBe("acct-1");
    expect(h.countFilter.statuses.sort()).toEqual(["processing", "scheduled"]);
  });

  it("never counts sent/failed/cancelled reminders", async () => {
    await GET(new Request(URL));
    expect(h.countFilter.statuses).not.toContain("sent");
    expect(h.countFilter.statuses).not.toContain("failed");
    expect(h.countFilter.statuses).not.toContain("cancelled");
  });

  it("degrades the count to 0 on a count-query error (dashboard stays up)", async () => {
    h.countResult = { count: null, error: new Error("boom") };
    const res = await GET(new Request(URL));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scheduledReminderCount?: unknown };
    expect(json.scheduledReminderCount).toBe(0);
  });
});