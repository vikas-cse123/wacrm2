import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "admin",
  accountId: "acct-1",
  config: {
    phone_number_id: "pn-1",
    access_token: "enc-token",
  } as Record<string, string> | null,
  rows: [] as Array<Record<string, unknown>>,
  metaCalls: [] as Array<{ kind: string; args: unknown }>,
  metaError: null as Error | null,
  metaCreated: {
    code: "META1",
    prefilled_message: "Hello",
    deep_link_url: "https://wa.me/message/META1",
    qr_image_url: "https://example.com/qr.svg",
  },
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
  const state = {
    table: "",
    filters: [] as Array<[string, unknown]>,
    write: null as Record<string, unknown> | null,
  };
  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push([col, val]);
      return api;
    },
    maybeSingle: async () => {
      if (state.table === "whatsapp_config") {
        return { data: h.config, error: null };
      }
      const rows = h.rows.filter((r) =>
        state.filters.every(([c, v]) => r[c] === v),
      );
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      const row = {
        id: "qr-1",
        account_id: h.accountId,
        created_at: "2026-09-22T00:00:00Z",
        updated_at: "2026-09-22T00:00:00Z",
        ...(state.write ?? {}),
      };
      return { data: row, error: null };
    },
    upsert: (obj: Record<string, unknown>) => {
      state.write = obj;
      return api;
    },
    then: (resolve: (v: unknown) => void) =>
      resolve({
        data: h.rows.filter((r) =>
          state.filters.every(([c, v]) => r[c] === v),
        ),
        error: null,
      }),
  };
  return {
    from: (table: string) => {
      state.table = table;
      return api;
    },
  };
}

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: () => "plain-token",
}));

vi.mock("@/lib/whatsapp/meta-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/whatsapp/meta-api")>();
  return {
    ...actual,
    createMetaQrCode: async (args: unknown) => {
      h.metaCalls.push({ kind: "create", args });
      if (h.metaError) throw h.metaError;
      return { ...h.metaCreated };
    },
  };
});

const { GET, POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/qr-codes", {
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
  h.rows = [];
  h.metaCalls = [];
  h.metaError = null;
});

describe("GET /api/qr-codes", () => {
  it("401s when unauthenticated", async () => {
    h.authed = false;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("400s with connected:false when no WhatsApp number is linked", async () => {
    h.config = null;
    const res = await GET();
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.connected).toBe(false);
  });

  it("returns only the caller's account rows", async () => {
    h.rows = [
      { id: "a", account_id: "acct-1", meta_code: "A" },
      { id: "b", account_id: "acct-2", meta_code: "B" },
    ];
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      qr_codes: Array<{ id: string }>;
    };
    expect(json.qr_codes.map((r) => r.id)).toEqual(["a"]);
  });

  it("lets agents and viewers read", async () => {
    h.role = "agent";
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

describe("POST /api/qr-codes", () => {
  it("403s for non-admin roles", async () => {
    h.role = "agent";
    const res = await POST(post({ name: "X", prefilled_message: "Hi" }));
    expect(res.status).toBe(403);
    expect(h.metaCalls).toHaveLength(0);
  });

  it("400s on invalid input without touching Meta", async () => {
    const res = await POST(post({ name: "", prefilled_message: "" }));
    expect(res.status).toBe(400);
    expect(h.metaCalls).toHaveLength(0);
  });

  it("400s on an invalid image format", async () => {
    const res = await POST(
      post({ name: "X", prefilled_message: "Hi", image_format: "GIF" }),
    );
    expect(res.status).toBe(400);
    expect(h.metaCalls).toHaveLength(0);
  });

  it("creates in Meta first, then stores metadata (201)", async () => {
    const res = await POST(
      post({ name: "Bali", prefilled_message: "Hi Bali", image_format: "SVG" }),
    );
    expect(res.status).toBe(201);
    expect(h.metaCalls).toHaveLength(1);
    const args = h.metaCalls[0].args as Record<string, unknown>;
    // Server resolves phone/token from the session — never the client.
    expect(args).toMatchObject({
      phoneNumberId: "pn-1",
      accessToken: "plain-token",
      prefilledMessage: "Hi Bali",
      imageFormat: "SVG",
    });
    const json = (await res.json()) as {
      qr_code: Record<string, unknown>;
    };
    expect(json.qr_code).toMatchObject({
      account_id: "acct-1",
      meta_code: "META1",
      name: "Bali",
    });
    expect(json.qr_code).not.toHaveProperty("access_token");
  });

  it("502s (storing nothing) when Meta rejects", async () => {
    h.metaError = new Error("Meta API error: 400");
    const res = await POST(post({ name: "Bali", prefilled_message: "Hi" }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.error)).not.toMatch(/plain-token/);
  });
});
