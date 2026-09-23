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
  writes: [] as Array<Record<string, unknown>>,
  metaList: [] as Array<Record<string, unknown>>,
  metaError: null as Error | null,
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
  const matched = () =>
    h.rows.filter((r) => state.filters.every(([c, v]) => r[c] === v));
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
      return { data: null, error: null };
    },
    single: async () => {
      const base = matched()[0] ?? {};
      const merged = { ...base, ...(state.write ?? {}) };
      // Persist the refresh so later assertions see reconciled values.
      const idx = h.rows.findIndex((r) => r.id === merged.id);
      if (idx >= 0) h.rows[idx] = merged;
      return { data: merged, error: null };
    },
    update: (obj: Record<string, unknown>) => {
      state.write = obj;
      h.writes.push(obj);
      return api;
    },
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: matched(), error: null }),
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
    listMetaQrCodes: async () => {
      if (h.metaError) throw h.metaError;
      return h.metaList;
    },
  };
});

const { POST } = await import("./route");

beforeEach(() => {
  h.authed = true;
  h.role = "admin";
  h.accountId = "acct-1";
  h.config = { phone_number_id: "pn-1", access_token: "enc-token" };
  h.rows = [];
  h.writes = [];
  h.metaList = [];
  h.metaError = null;
});

describe("POST /api/qr-codes/sync", () => {
  it("403s for non-admin roles", async () => {
    h.role = "agent";
    const res = await POST();
    expect(res.status).toBe(403);
  });

  it("marks active, imported, and Meta-deleted codes distinctly", async () => {
    h.rows = [
      {
        id: "qr-1",
        account_id: "acct-1",
        meta_code: "KEEP",
        name: "Keep",
        prefilled_message: "Hi",
        deep_link_url: "https://wa.me/message/KEEP",
        qr_image_url: "https://example.com/keep.svg",
      },
      {
        id: "qr-2",
        account_id: "acct-1",
        meta_code: "GONE",
        name: "Gone",
        prefilled_message: "Bye",
        deep_link_url: null,
        qr_image_url: null,
      },
    ];
    h.metaList = [
      {
        code: "KEEP",
        prefilled_message: "Hi",
        deep_link_url: "https://wa.me/message/KEEP",
        qr_image_url: "https://example.com/keep.svg",
      },
      {
        code: "NEW",
        prefilled_message: "Fresh",
        deep_link_url: "https://wa.me/message/NEW",
        qr_image_url: "https://example.com/new.svg",
      },
    ];

    const res = await POST();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      qr_codes: Array<{ meta_code: string; sync_status: string }>;
      imported: Array<{
        id: null;
        meta_code: string;
        sync_status: string;
      }>;
    };
    expect(
      json.qr_codes.map((r) => `${r.meta_code}:${r.sync_status}`).sort(),
    ).toEqual(["GONE:deleted_in_whatsapp", "KEEP:active"]);
    expect(json.imported).toHaveLength(1);
    expect(json.imported[0]).toMatchObject({
      id: null,
      meta_code: "NEW",
      sync_status: "imported_from_whatsapp",
    });
  });

  it("refreshes drifted local values from Meta", async () => {
    h.rows = [
      {
        id: "qr-1",
        account_id: "acct-1",
        meta_code: "KEEP",
        name: "Keep",
        prefilled_message: "Stale",
        deep_link_url: null,
        qr_image_url: null,
      },
    ];
    h.metaList = [
      {
        code: "KEEP",
        prefilled_message: "Fresh",
        deep_link_url: "https://wa.me/message/KEEP",
        qr_image_url: "https://example.com/keep.svg",
      },
    ];
    const res = await POST();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      qr_codes: Array<{ prefilled_message: string; sync_status: string }>;
    };
    expect(json.qr_codes[0]).toMatchObject({
      prefilled_message: "Fresh",
      sync_status: "active",
    });
    // The local display name is never overwritten by Meta.
    expect(h.rows[0].name).toBe("Keep");
  });

  it("502s when Meta is unreachable", async () => {
    h.metaError = new Error("network down");
    const res = await POST();
    expect(res.status).toBe(502);
  });
});
