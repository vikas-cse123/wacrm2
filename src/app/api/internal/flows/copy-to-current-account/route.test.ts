// ---------------------------------------------------------------------------
// Tests for POST /api/internal/flows/copy-to-current-account.
//
// Thin auth/adapt layer: the destination is always the caller's own
// account (never client input). Verifies 401/400/403/404/201 mapping
// and that the service receives target-owner authorization pinned to
// the profile-derived account.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  profile: {
    account_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    account_role: "owner",
  } as { account_id: string; account_role: string } | null,
  copyArgs: null as null | Record<string, unknown>,
  copyImpl: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: h.profile, error: null }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ __admin: true }),
}));

vi.mock("@/lib/flows/cross-account-copy", () => ({
  copyFlowAcrossAccounts: (_db: unknown, input: Record<string, unknown>) => {
    h.copyArgs = input;
    if (!h.copyImpl) throw new Error("copyImpl not set");
    return h.copyImpl(input);
  },
  CopyFlowError: class CopyFlowError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const { POST } = await import("./route");

const SOURCE = "11111111-1111-1111-1111-111111111111";
const OWN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function req(body: unknown) {
  return new Request(
    "https://app.test/api/internal/flows/copy-to-current-account",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  h.user = { id: "user-1" };
  h.profile = { account_id: OWN, account_role: "owner" };
  h.copyArgs = null;
  h.copyImpl = async () => ({
    targetFlowId: "new-flow",
    targetAccountId: OWN,
    flowName: "X - Copy",
    nodeCount: 3,
    warnings: [],
  });
});

describe("POST /api/internal/flows/copy-to-current-account", () => {
  it("returns 201 and pins the destination to the caller's account", async () => {
    const res = await POST(req({ sourceFlowId: SOURCE }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.targetFlowId).toBe("new-flow");
    expect(h.copyArgs).toMatchObject({
      callerUserId: "user-1",
      callerAccountId: OWN,
      callerRole: "owner",
      sourceFlowId: SOURCE,
      targetAccountId: OWN,
      authorization: "target-owner",
    });
  });

  it("ignores any client-supplied destination", async () => {
    const res = await POST(
      req({ sourceFlowId: SOURCE, targetAccountId: OTHER }),
    );
    expect(res.status).toBe(201);
    expect(h.copyArgs?.targetAccountId).toBe(OWN);
  });

  it("returns 401 when unauthenticated", async () => {
    h.user = null;
    const res = await POST(req({ sourceFlowId: SOURCE }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for non-UUID source ids", async () => {
    const res = await POST(req({ sourceFlowId: "Singapore Chat" }));
    expect(res.status).toBe(400);
  });

  it("returns 403 for non-owners before any source lookup", async () => {
    h.profile = { account_id: OWN, account_role: "admin" };
    const res = await POST(req({ sourceFlowId: SOURCE }));
    expect(res.status).toBe(403);
  });

  it("returns 403 when the profile does not resolve", async () => {
    h.profile = null;
    const res = await POST(req({ sourceFlowId: SOURCE }));
    expect(res.status).toBe(403);
  });

  it("maps service 404 (unknown ID) through", async () => {
    const { CopyFlowError } = (await import(
      "@/lib/flows/cross-account-copy"
    )) as unknown as {
      CopyFlowError: new (status: number, message: string) => Error;
    };
    h.copyImpl = async () => {
      throw new CopyFlowError(404, "Source flow not found.");
    };
    const res = await POST(req({ sourceFlowId: SOURCE }));
    expect(res.status).toBe(404);
  });
});
