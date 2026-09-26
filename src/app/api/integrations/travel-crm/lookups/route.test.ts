import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "wacrm_secret_123";
const BASE = "https://crm.example.com";

const h = vi.hoisted(() => ({
  authed: true,
  lookups: {} as Record<string, unknown>,
  fail: false,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) {
      const err = new Error("Unauthorized") as Error & { status: number };
      err.status = 401;
      throw err;
    }
    return { supabase: {}, accountId: "acct-1", userId: "user-1" };
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

beforeEach(() => {
  h.authed = true;
  h.fail = false;
  h.lookups = {
    destinations: [{ value: "dest-sg", label: "Singapore" }],
    cities: [{ value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" }],
  };
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    if (String(url).endsWith("/api/integrations/wacrm/lookups")) {
      if (h.fail) {
        return new Response(JSON.stringify({ success: false }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, data: h.lookups }), {
        status: 200,
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch);
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const { GET } = await import("./route");

describe("GET /api/integrations/travel-crm/lookups (itinerary proxy)", () => {
  it("8. returns Travel CRM destinations/cities without the secret", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      success: true,
      destinations: [{ value: "dest-sg", label: "Singapore" }],
      cities: [{ value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" }],
    });
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });

  it("degrades to empty (never fake) when Travel CRM is down", async () => {
    h.fail = true;
    const res = await GET();
    const json = (await res.json()) as {
      success: boolean;
      destinations: unknown[];
      cities: unknown[];
    };
    expect(json.success).toBe(false);
    expect(json.destinations).toEqual([]);
    expect(json.cities).toEqual([]);
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });
});
