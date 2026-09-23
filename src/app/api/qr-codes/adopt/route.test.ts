import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "admin",
  accountId: "acct-1",
  config: {
    phone_number_id: "pn-1",
    access_token: "enc-token",
  } as Record<string, string> | null,
  metaList: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId };
  },
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    if (min === "admin" && h.role !== "admin" && h.role !== "owner") {
      throw statusError(403, "Forbidden");
    }
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
    maybeSingle: async () => ({ data: h.config, error: null }),
    single: async () => ({
      data: {
        id: "qr-9",
        account_id: h.accountId,
        meta_code: "M1",
        name: "Desk",
        prefilled_message: "Meta text",
        deep_link_url: "https://wa.me/message/M1",
        qr_image_url: "https://example.com/m1.svg",
        image_format: "SVG",
        created_at: "2026-09-22T00:00:00Z",
        updated_at: "2026-09-22T00:00:00Z",
      },
      error: null,
    }),
    upsert: (obj: Record<string, unknown>) => {
      h.upserts.push(obj);
      return api;
    },
  };
  return { from: () => api };
}

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: () => "plain-token",
}));

vi.mock("@/lib/whatsapp/meta-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/whatsapp/meta-api")>();
  return { ...actual, listMetaQrCodes: async () => h.metaList };
});

const { POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/qr-codes/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.authed = true;
  h.role = "admin";
  h.accountId = "acct-1";
  h.config = { phone_number_id: "pn-1", access_token: "enc-token" };
  h.metaList = [
    {
      code: "M1",
      prefilled_message: "Meta text",
      deep_link_url: "https://wa.me/message/M1",
      qr_image_url: "https://example.com/m1.svg",
    },
  ];
  h.upserts = [];
});

describe("POST /api/qr-codes/adopt", () => {
  it("403s for non-admin roles", async () => {
    h.role = "agent";
    const res = await POST(post({ meta_code: "M1", name: "Desk" }));
    expect(res.status).toBe(403);
    expect(h.upserts).toHaveLength(0);
  });

  it("stores Meta's values under the caller's account, never client data", async () => {
    const res = await POST(
      post({
        meta_code: "M1",
        name: "Desk",
        prefilled_message: "forged",
        account_id: "acct-evil",
      }),
    );
    expect(res.status).toBe(201);
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({
      account_id: "acct-1",
      meta_code: "M1",
      name: "Desk",
      prefilled_message: "Meta text",
      deep_link_url: "https://wa.me/message/M1",
    });
    expect(h.upserts[0]).not.toHaveProperty("account_id", "acct-evil");
  });

  it("410s when the Meta code is gone", async () => {
    const res = await POST(post({ meta_code: "NOPE", name: "Desk" }));
    expect(res.status).toBe(410);
    expect(h.upserts).toHaveLength(0);
  });

  it("400s on a missing name", async () => {
    const res = await POST(post({ meta_code: "M1", name: " " }));
    expect(res.status).toBe(400);
  });
});
