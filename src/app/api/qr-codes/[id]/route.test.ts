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
  deleted: [] as Array<Record<string, unknown>>,
  metaCalls: [] as Array<{ kind: string; args: unknown }>,
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
    isDelete: false,
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
      const rows = matched();
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      const base = matched()[0] ?? {
        id: "qr-1",
        account_id: h.accountId,
        created_at: "2026-09-22T00:00:00Z",
        updated_at: "2026-09-22T00:00:00Z",
      };
      return { data: { ...base, ...(state.write ?? {}) }, error: null };
    },
    update: (obj: Record<string, unknown>) => {
      state.write = obj;
      h.writes.push(obj);
      return api;
    },
    delete: () => {
      state.isDelete = true;
      return api;
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.isDelete) {
        const gone = matched();
        h.deleted.push(...gone);
        h.rows = h.rows.filter((r) => !gone.includes(r));
      }
      return resolve({ data: null, error: null });
    },
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
    updateMetaQrCode: async (args: Record<string, unknown>) => {
      h.metaCalls.push({ kind: "update", args });
      if (h.metaError) throw h.metaError;
      return {
        code: args.code,
        prefilled_message: args.prefilledMessage,
        deep_link_url: "https://wa.me/message/X1",
        qr_image_url: "https://example.com/qr.svg",
      };
    },
    deleteMetaQrCode: async (args: Record<string, unknown>) => {
      h.metaCalls.push({ kind: "delete", args });
      if (h.metaError) throw h.metaError;
    },
  };
});

const { PATCH, DELETE } = await import("./route");

const ROW = {
  id: "qr-1",
  account_id: "acct-1",
  meta_code: "X1",
  name: "Bali",
  prefilled_message: "Hi",
  deep_link_url: "https://wa.me/message/X1",
  qr_image_url: "https://example.com/qr.svg",
  image_format: "SVG",
};

function patch(id: string, body: unknown) {
  return new Request(`https://app.test/api/qr-codes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.authed = true;
  h.role = "admin";
  h.accountId = "acct-1";
  h.config = { phone_number_id: "pn-1", access_token: "enc-token" };
  h.rows = [{ ...ROW }];
  h.writes = [];
  h.deleted = [];
  h.metaCalls = [];
  h.metaError = null;
});

describe("PATCH /api/qr-codes/[id]", () => {
  it("404s for another account's id (no cross-account access)", async () => {
    h.rows = [{ ...ROW, account_id: "acct-2" }];
    const res = await PATCH(patch("qr-1", { name: "X" }), params("qr-1"));
    expect(res.status).toBe(404);
    expect(h.metaCalls).toHaveLength(0);
  });

  it("renames locally without calling Meta", async () => {
    const res = await PATCH(patch("qr-1", { name: "Bali 2026" }), params("qr-1"));
    expect(res.status).toBe(200);
    expect(h.metaCalls).toHaveLength(0);
    expect(h.writes[0]).toMatchObject({ name: "Bali 2026" });
  });

  it("updates the prefilled message in Meta with the code", async () => {
    const res = await PATCH(
      patch("qr-1", { prefilled_message: "New text" }),
      params("qr-1"),
    );
    expect(res.status).toBe(200);
    expect(h.metaCalls).toHaveLength(1);
    expect(h.metaCalls[0].args).toMatchObject({
      phoneNumberId: "pn-1",
      accessToken: "plain-token",
      code: "X1",
      prefilledMessage: "New text",
    });
  });

  it("410s with meta_missing when Meta no longer has the code", async () => {    h.metaError = new Error("QR code does not exist (code 100)");
    const res = await PATCH(
      patch("qr-1", { prefilled_message: "New text" }),
      params("qr-1"),
    );
    expect(res.status).toBe(410);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.meta_missing).toBe(true);
  });

  it("re-renders through Meta on a format-only change", async () => {
    const res = await PATCH(patch("qr-1", { image_format: "PNG" }), params("qr-1"));
    expect(res.status).toBe(200);
    expect(h.metaCalls).toHaveLength(1);
    expect(h.metaCalls[0].args).toMatchObject({
      code: "X1",
      prefilledMessage: "Hi",
      imageFormat: "PNG",
    });
    expect(h.writes[0]).toMatchObject({ image_format: "PNG" });
  });

  it("400s on empty input", async () => {
    const res = await PATCH(patch("qr-1", {}), params("qr-1"));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/qr-codes/[id]", () => {
  it("deletes in Meta, then locally", async () => {
    const res = await DELETE(
      new Request("https://app.test/api/qr-codes/qr-1", { method: "DELETE" }),
      params("qr-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ deleted: true, reconciled: false });
    expect(h.metaCalls[0].args).toMatchObject({
      phoneNumberId: "pn-1",
      code: "X1",
    });
    expect(h.deleted.map((r) => r.id)).toEqual(["qr-1"]);
  });

  it("reconciles locally when Meta already deleted the code", async () => {
    h.metaError = new Error("QR code does not exist (code 100)");
    const res = await DELETE(
      new Request("https://app.test/api/qr-codes/qr-1", { method: "DELETE" }),
      params("qr-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ deleted: true, reconciled: true });
    expect(h.rows).toHaveLength(0);
  });

  it("404s for another account's id", async () => {
    h.rows = [{ ...ROW, account_id: "acct-2" }];
    const res = await DELETE(
      new Request("https://app.test/api/qr-codes/qr-1", { method: "DELETE" }),
      params("qr-1"),
    );
    expect(res.status).toBe(404);
    expect(h.metaCalls).toHaveLength(0);
  });
});
