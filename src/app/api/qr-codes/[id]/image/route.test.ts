import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  accountId: "acct-1",
  config: {
    phone_number_id: "pn-1",
    access_token: "enc-token",
  } as Record<string, string> | null,
  rows: [] as Array<Record<string, unknown>>,
  metaList: [] as Array<Record<string, unknown>>,
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
  requireRole: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
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
  };
  return {
    from: (table: string) => {
      state.table = table;
      const api: Record<string, unknown> = {
        select: () => api,
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
      };
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
    listMetaQrCodes: async () => h.metaList,
  };
});

const { GET } = await import("./route");
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.authed = true;
  h.accountId = "acct-1";
  h.config = { phone_number_id: "pn-1", access_token: "enc-token" };
  h.rows = [
    {
      id: "qr-1",
      account_id: "acct-1",
      meta_code: "X1",
      name: "Bali Packages",
      qr_image_url: "https://example.com/stored.svg",
    },
  ];
  h.metaList = [
    { code: "X1", qr_image_url: "https://example.com/fresh.svg" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toBe("https://example.com/fresh.svg");
      return new Response("<svg/>", {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/qr-codes/[id]/image", () => {
  it("streams Meta's image as an attachment without auth headers", async () => {
    const res = await GET(
      new Request("https://app.test/api/qr-codes/qr-1/image"),
      params("qr-1"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(res.headers.get("Content-Disposition")).toContain(
      'filename="bali-packages.svg"',
    );
    expect(await res.text()).toBe("<svg/>");
    // The outbound image fetch carries no Authorization header.
    const init = vi.mocked(fetch).mock.calls[0][1] ?? {};
    expect(init).not.toHaveProperty("headers");
  });

  it("404s for another account's id", async () => {
    h.rows = [{ ...(h.rows[0] as object), account_id: "acct-2" }];
    const res = await GET(
      new Request("https://app.test/api/qr-codes/qr-1/image"),
      params("qr-1"),
    );
    expect(res.status).toBe(404);
  });
});
