import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-A",
  createdBy: "user-minter",
  // contacts visible to the mocked lookup (already account-filtered by the mock).
  contacts: [] as Array<{ id: string; phone_normalized: string }>,
  lastInsert: null as Record<string, unknown> | null,
  uploadBucket: null as string | null,
}));

function chainableSelect() {
  const builder: Record<string, (...args: never[]) => unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.limit = async () => ({ data: h.contacts, error: null });
  builder.maybeSingle = async () => ({
    data: h.contacts.length > 0 ? { id: h.contacts[0].id } : null,
    error: null,
  });
  return builder;
}

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === "call_recordings") {
        return {
          insert: (obj: Record<string, unknown>) => {
            h.lastInsert = obj;
            return {
              select: () => ({
                single: async () => ({
                  data: {
                    id: "r-1",
                    created_at: "2026-10-04T12:00:00.000Z",
                    ...obj,
                  },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      return chainableSelect();
    },
    storage: {
      from: (bucket: string) => {
        h.uploadBucket = bucket;
        return {
          upload: async () => ({ error: null }),
          remove: async () => ({}),
        };
      },
    },
  };
}

vi.mock("@/lib/auth/api-context", () => ({
  requireApiKey: async () => ({
    authType: "api_key",
    supabase: fakeSupabase(),
    accountId: h.accountId,
    keyId: "key-1",
    scopes: ["recordings:write"],
    createdBy: h.createdBy,
  }),
}));

const { POST } = await import("./route");

function uploadRequest(fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append(
    "audio",
    new File([new Uint8Array([1, 2, 3, 4])], "call.ogg", {
      type: "audio/ogg",
    }),
  );
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request("https://app.test/api/v1/recordings", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  h.accountId = "acct-A";
  h.createdBy = "user-minter";
  h.contacts = [];
  h.lastInsert = null;
  h.uploadBucket = null;
});

describe("POST /api/v1/recordings contact association (Phase 2B)", () => {
  it("1. unique phone match populates contact_id with matched=true", async () => {
    h.contacts = [{ id: "c-raj", phone_normalized: "91916394642516" }];
    const res = await POST(
      uploadRequest({ phone_number: "+91916394642516", direction: "out" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; direction?: string };
    };
    expect(json.data.contact_id).toBe("c-raj");
    expect((json.data as { matched?: boolean }).matched).toBe(true);
    expect(h.lastInsert?.contact_id).toBe("c-raj");
    expect(h.lastInsert?.direction).toBe("out");
    expect(h.lastInsert?.phone_number).toBe("+91916394642516");
  });

  it("2. unknown phone uploads unlinked with matched=false", async () => {
    h.contacts = [];
    const res = await POST(uploadRequest({ phone_number: "+91111" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("3. ambiguous phone uploads unlinked (never guesses)", async () => {
    h.contacts = [
      { id: "c-1", phone_normalized: "91911" },
      { id: "c-2", phone_normalized: "91911" },
    ];
    const res = await POST(uploadRequest({ phone_number: "+91911" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("4/5. direction in and out are accepted and stored", async () => {
    for (const direction of ["in", "out"]) {
      const res = await POST(uploadRequest({ direction }));
      expect(res.status).toBe(201);
      expect(h.lastInsert?.direction).toBe(direction);
    }
  });

  it("6. invalid direction is rejected with 400", async () => {
    const res = await POST(uploadRequest({ direction: "missed" }));
    expect(res.status).toBe(400);
  });

  it("7. equivalent number formats match the same contact", async () => {
    h.contacts = [{ id: "c-raj", phone_normalized: "91916394642516" }];
    for (const phone of [
      "+91916394642516",
      "91916394642516",
      "+91 91639 46425 16",
      "+91-916394642516",
    ]) {
      const res = await POST(uploadRequest({ phone_number: phone }));
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        data: { contact_id: string | null };
      };
      expect(json.data.contact_id).toBe("c-raj");
    }
  });

  it("8. matching is restricted to the API key's account", async () => {
    // The mock only returns contacts "in account A" — the route must
    // scope by ctx.accountId, never globally. Here the account has no
    // such contact, so the row stays unlinked even though a contact
    // with that number exists in account B (unreachable to the mock).
    h.accountId = "acct-A";
    h.contacts = [];
    const res = await POST(uploadRequest({ phone_number: "+91999" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; account_id: string };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.account_id).toBe("acct-A");
  });

  it("9. explicit contact_id from another account is rejected", async () => {
    // accountOwns() finds nothing in this account → 400.
    h.contacts = [];
    const res = await POST(uploadRequest({ contact_id: "c-foreign" }));
    expect(res.status).toBe(400);
  });

  it("10. upload without phone_number still succeeds (Phase 1 compat)", async () => {
    const res = await POST(
      uploadRequest({ recorded_at: "2026-10-04T15:00:00Z", duration_seconds: "10" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("11. explicit contact_id remains authoritative over phone matching", async () => {
    // Explicit c-explicit wins even though the phone would match c-other.
    h.contacts = [{ id: "c-explicit", phone_normalized: "1" }];
    const res = await POST(
      uploadRequest({ contact_id: "c-explicit", phone_number: "+91911" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBe("c-explicit");
    expect(json.data.matched).toBe(true);
  });

  it("12. phone_number over 64 characters is rejected with 400", async () => {
    const res = await POST(uploadRequest({ phone_number: "1".repeat(65) }));
    expect(res.status).toBe(400);
  });

  it("13. empty phone_number uploads with no match", async () => {
    const res = await POST(uploadRequest({ phone_number: "   " }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("audio still lands in the private call-recordings bucket", async () => {
    const res = await POST(uploadRequest({ phone_number: "+91911" }));
    expect(res.status).toBe(201);
    expect(h.uploadBucket).toBe("call-recordings");
  });
});
