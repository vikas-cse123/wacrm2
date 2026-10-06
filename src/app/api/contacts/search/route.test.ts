import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  contacts: [] as Array<Record<string, unknown>>,
  seenOr: [] as string[],
}));

function fakeSupabase() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          // contacts/search chain: select.eq.or.order.limit
          or: (expr: string) => {
            h.seenOr.push(expr);
            return {
              order: () => ({
                limit: async () => ({ data: h.contacts, error: null }),
              }),
            };
          },
        }),
      }),
    }),
  };
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: "user-1",
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

beforeEach(() => {
  h.accountId = "acct-1";
  h.contacts = [];
  h.seenOr = [];
});

describe("GET /api/contacts/search", () => {
  it("badges the single exact phone match", async () => {
    h.contacts = [
      { id: "c-1", name: "Sagar", phone: "+916394642516", phone_normalized: "916394642516" },
    ];
    const res = await GET(new Request("https://app.test/api/contacts/search?q=916394642516"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      leads: Array<{ id: string }>;
      exactMatchId: string | null;
    };
    expect(json.leads.map((l) => l.id)).toEqual(["c-1"]);
    expect(json.exactMatchId).toBe("c-1");
  });

  it("leaves ambiguous numbers unbadged", async () => {
    h.contacts = [
      { id: "c-1", name: "A", phone: "+91111", phone_normalized: "91111" },
      { id: "c-2", name: "B", phone: "+91111", phone_normalized: "91111" },
    ];
    const res = await GET(new Request("https://app.test/api/contacts/search?q=91111"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { exactMatchId: string | null };
    expect(json.exactMatchId).toBeNull();
  });

  it("searches names and normalizes phone queries", async () => {
    h.contacts = [{ id: "c-1", name: "Sagar", phone: "+91 63946 42516", phone_normalized: "916394642516" }];
    const res = await GET(new Request("https://app.test/api/contacts/search?q=Sagar"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { leads: Array<{ id: string }> };
    expect(json.leads).toHaveLength(1);
    // Name query carries no digits → phone branch absent, name branch present.
    expect(h.seenOr.join("|")).toContain("name.ilike.");
    expect(h.seenOr.join("|")).not.toContain("phone_normalized");
  });

  it("rejects short queries without touching the database", async () => {
    const res = await GET(new Request("https://app.test/api/contacts/search?q=x"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { leads: unknown[]; exactMatchId: null };
    expect(json.leads).toEqual([]);
    expect(h.seenOr).toEqual([]);
  });
});
