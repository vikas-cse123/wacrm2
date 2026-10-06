// ============================================================
// requireDeviceUser — user-session auth for mobile uploads.
//
// Mocks the Supabase client factory + service-role client; no
// network, no secrets. Tokens below are opaque fixtures — the
// shape (not the value) is what the code branches on.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: "user-sagar" as string | null,
  getUserError: null as { message: string } | null,
  profile: null as Record<string, unknown> | null,
  profileError: null as { message: string } | null,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => {
        if (h.getUserError || !h.userId) {
          return { data: { user: null }, error: h.getUserError ?? { message: "invalid" } };
        }
        return { data: { user: { id: h.userId } }, error: null };
      },
    },
  }),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: h.profile, error: h.profileError }),
        }),
      }),
    }),
  }),
}));

const { bearerToken, requireDeviceUser } = await import("./device");

function req(token?: string) {
  return new Request("https://app.test/api/v1/recordings", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  h.userId = "user-sagar";
  h.getUserError = null;
  h.profile = {
    account_id: "acct-A",
    account_role: "agent",
    full_name: " Sagar ",
  };
  h.profileError = null;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-fixture";
});

describe("bearerToken", () => {
  it("extracts Bearer tokens and tolerates bare values", async () => {
    expect(bearerToken(req("abc.def.ghi"))).toBe("abc.def.ghi");
    expect(bearerToken(new Request("https://x", { headers: { Authorization: "abc" } }))).toBe(
      "abc"
    );
    expect(bearerToken(req())).toBeNull();
  });
});

describe("requireDeviceUser", () => {
  it("1. valid agent session resolves user + account + role", async () => {
    const ctx = await requireDeviceUser(req("header.payload.sig"));
    expect(ctx.authType).toBe("user");
    expect(ctx.userId).toBe("user-sagar");
    expect(ctx.accountId).toBe("acct-A");
    expect(ctx.role).toBe("agent");
    expect(ctx.fullName).toBe("Sagar");
  });

  it("2/3. missing or invalid token is 401 without distinction", async () => {
    h.userId = null;
    for (const r of [req(), req("bogus")]) {
      const err = await requireDeviceUser(r).catch((e) => e);
      expect(err.status).toBe(401);
    }
  });

  it("7/9. viewer sessions are forbidden from uploading", async () => {
    h.profile = { account_id: "acct-A", account_role: "viewer", full_name: "V" };
    const err = await requireDeviceUser(req("header.payload.sig")).catch((e) => e);
    expect(err.status).toBe(403);
    expect(String(err.message)).toMatch(/permission/i);
  });

  it("owner and admin sessions may upload", async () => {
    for (const role of ["owner", "admin", "agent"]) {
      h.profile = { account_id: "acct-A", account_role: role, full_name: "X" };
      const ctx = await requireDeviceUser(req("header.payload.sig"));
      expect(ctx.role).toBe(role);
    }
  });

  it("users without a profile row are rejected", async () => {
    h.profile = null;
    const err = await requireDeviceUser(req("header.payload.sig")).catch((e) => e);
    expect(err.status).toBe(401);
  });

  it("blank full names resolve to null, never empty strings", async () => {
    h.profile = { account_id: "acct-A", account_role: "agent", full_name: "   " };
    const ctx = await requireDeviceUser(req("header.payload.sig"));
    expect(ctx.fullName).toBeNull();
  });
});
