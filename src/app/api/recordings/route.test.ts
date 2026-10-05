import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  contact: { id: "c-1", account_id: "acct-1" } as Record<string, unknown> | null,
  recordings: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
}));

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Array<[string, unknown]>,
  };
  const matched = () =>
    h.recordings.filter((r) => state.filters.every(([c, v]) => r[c] === v));
  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push([col, val]);
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      state.filters.push([col, vals]);
      return api;
    },
    range: async () => ({ data: matched(), error: null, count: matched().length }),
    maybeSingle: async () => {
      if (state.table === "contacts") return { data: h.contact, error: null };
      return { data: null, error: null };
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      if (table === "profiles") {
        return {
          select: () => ({
            in: async () => ({ data: h.profiles, error: null }),
          }),
        };
      }
      return api;
    },
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

function recording(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    account_id: "acct-1",
    contact_id: "c-1",
    conversation_id: null,
    uploaded_by: "u-9",
    storage_bucket: "call-recordings",
    storage_path: "account-acct-1/1-x.ogg",
    file_name: "x.ogg",
    mime_type: "audio/ogg",
    file_size: 1000,
    duration_seconds: 35,
    recorded_at: "2026-10-04T12:00:00.000Z",
    created_at: "2026-10-04T12:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.contact = { id: "c-1", account_id: "acct-1" };
  h.recordings = [];
  h.profiles = [{ user_id: "u-9", full_name: "Akash", email: "a@x.com" }];
});

describe("GET /api/recordings?contact_id=", () => {
  it("scopes to one contact and joins the uploader name", async () => {
    h.recordings = [recording(), recording({ id: "r-2", contact_id: "c-9" })];
    const res = await GET(
      new Request("https://app.test/api/recordings?contact_id=c-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ id: string; uploader_name: string | null }>;
      total: number;
    };
    expect(json.total).toBe(1);
    expect(json.recordings.map((r) => r.id)).toEqual(["r-1"]);
    expect(json.recordings[0].uploader_name).toBe("Akash");
  });

  it("404s a contact from another account (no cross-tenant oracle)", async () => {
    h.contact = null;
    const res = await GET(
      new Request("https://app.test/api/recordings?contact_id=c-evil"),
    );
    expect(res.status).toBe(404);
  });

  it("falls back to Unknown when the uploader profile is gone", async () => {
    h.recordings = [recording()];
    h.profiles = [];
    const res = await GET(
      new Request("https://app.test/api/recordings?contact_id=c-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ uploader_name: string | null }>;
    };
    expect(json.recordings[0].uploader_name).toBe("Unknown");
  });

  it("keeps unlinked recordings in the unfiltered global list", async () => {
    h.recordings = [recording({ id: "r-u", contact_id: null })];
    const res = await GET(new Request("https://app.test/api/recordings"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ id: string }>;
      total: number;
    };
    expect(json.total).toBe(1);
    expect(json.recordings[0].id).toBe("r-u");
  });
});
