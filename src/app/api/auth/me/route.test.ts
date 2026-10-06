import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  deviceOk: true as boolean,
  account: { id: "acct-A", name: "Acme" } as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth/device", () => ({
  requireDeviceUser: async () => {
    if (!h.deviceOk) {
      const { unauthorized } = await import("@/lib/api/v1/respond");
      throw unauthorized("Invalid or expired session");
    }
    return {
      authType: "user",
      supabase: {},
      service: {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: h.account, error: null }),
            }),
          }),
        }),
      },
      userId: "user-sagar",
      accountId: "acct-A",
      role: "agent",
      fullName: "Sagar",
      email: "sagar@example.com",
    };
  },
}));

const { GET } = await import("./route");

describe("GET /api/auth/me", () => {
  it("returns the authenticated user, account, and role", async () => {
    const res = await GET(
      new Request("https://app.test/api/auth/me", {
        headers: { Authorization: "Bearer header.payload.sig" },
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      user: { id: string; email: string; fullName: string };
      account: { id: string; name: string };
      role: string;
    };
    expect(json.user).toEqual({ id: "user-sagar", email: "sagar@example.com", fullName: "Sagar" });
    expect(json.account).toEqual({ id: "acct-A", name: "Acme" });
    expect(json.role).toBe("agent");
  });

  it("rejects invalid sessions with 401", async () => {
    h.deviceOk = false;
    const res = await GET(new Request("https://app.test/api/auth/me"));
    expect(res.status).toBe(401);
    h.deviceOk = true;
  });
});
