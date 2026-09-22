import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "admin" as string | null,
  config: {
    phone_number_id: "pn-1",
    access_token: "enc-token",
  } as Record<string, string> | null,
  metaProfile: {
    about: "Hi",
    address: null,
    description: null,
    email: null,
    profile_picture_url: null,
    vertical: null,
    websites: [],
  },
  metaCalls: [] as Array<{ kind: string; fields?: unknown }>,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (role: string) => {
    if (h.role !== role && !(h.role === "owner" && role === "admin")) {
      const err = new Error("Forbidden") as Error & { status: number };
      err.status = 403;
      throw err;
    }
    return { supabase: fakeSupabase(), accountId: "acct-1" };
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
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: h.config, error: null }),
        }),
      }),
    }),
  };
}

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: () => "plain-token",
}));

vi.mock("@/lib/whatsapp/meta-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/meta-api")>();
  return {
    ...actual,
    verifyPhoneNumber: async () => ({
      id: "pn-1",
      display_phone_number: "+91 86040 00000",
      verified_name: "Interscale Marketing",
    }),
    getBusinessProfile: async () => {
      h.metaCalls.push({ kind: "get" });
      return { ...h.metaProfile };
    },
    updateBusinessProfile: async (args: {
      fields: Record<string, unknown>;
    }) => {
      h.metaCalls.push({ kind: "update", fields: args.fields });
    },
  };
});

const { GET, PATCH } = await import("./route");

beforeEach(() => {
  h.role = "admin";
  h.config = { phone_number_id: "pn-1", access_token: "enc-token" };
  h.metaCalls = [];
  h.metaProfile = {
    about: "Hi",
    address: null,
    description: null,
    email: null,
    profile_picture_url: null,
    vertical: null,
    websites: [],
  };
});

describe("GET /api/whatsapp/business-profile", () => {
  it("returns the Meta profile plus verified name and number", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.connected).toBe(true);
    expect(json.verified_name).toBe("Interscale Marketing");
    expect(json.phone_number).toBe("+91 86040 00000");
    expect(json.profile).toMatchObject({ about: "Hi" });
  });

  it("reports unconnected when no WhatsApp config exists", async () => {
    h.config = null;
    const res = await GET();
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/whatsapp/business-profile", () => {
  it("forwards validated fields and returns the re-read profile", async () => {
    const res = await PATCH(
      new Request("https://app.test/api/whatsapp/business-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ about: "New tagline", email: "a@b.co" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.metaCalls).toContainEqual({
      kind: "update",
      fields: { about: "New tagline", email: "a@b.co" },
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.profile).toBeDefined();
  });

  it("rejects unknown verticals and bad emails/urls server-side", async () => {
    for (const body of [
      { vertical: "MOON" },
      { email: "nope" },
      { websites: ["javascript:alert(1)"] },
      { websites: ["https://a.co", "https://b.co", "https://c.co"] },
    ]) {
      const res = await PATCH(
        new Request("https://app.test/api/whatsapp/business-profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(400);
    }
    expect(h.metaCalls.filter((c) => c.kind === "update")).toHaveLength(0);
  });

  it("rejects empty updates and non-admin callers", async () => {
    const empty = await PATCH(
      new Request("https://app.test/api/whatsapp/business-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(empty.status).toBe(400);

    h.role = "agent";
    const forbidden = await PATCH(
      new Request("https://app.test/api/whatsapp/business-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ about: "x" }),
      }),
    );
    expect(forbidden.status).toBe(403);
  });
});
