// ---------------------------------------------------------------------------
// Tests for POST /api/internal/flows/copy.
//
// The route is a thin auth/adapt layer over copyFlowAcrossAccounts
// (fully covered in cross-account-copy.test.ts): it authenticates,
// resolves the caller's own profile, validates UUIDs, and maps
// service errors to HTTP statuses. It never touches UI.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  profile: {
    account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    account_role: "owner",
  } as { account_id: string; account_role: string } | null,
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
  copyFlowAcrossAccounts: (...args: unknown[]) => {
    if (!h.copyImpl) throw new Error("copyImpl not set");
    return h.copyImpl(...args);
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
const TARGET = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function req(body: unknown) {
  return new Request("https://app.test/api/internal/flows/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.user = { id: "user-1" };
  h.profile = {
    account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    account_role: "owner",
  };
  h.copyImpl = async () => ({
    targetFlowId: "new-flow",
    targetAccountId: TARGET,
    flowName: "X - Copy",
    nodeCount: 2,
    warnings: [],
  });
});

describe("POST /api/internal/flows/copy", () => {
  it("returns 201 with the copy summary on success", async () => {
    const res = await POST(
      req({ sourceFlowId: SOURCE, targetAccountId: TARGET }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.targetFlowId).toBe("new-flow");
    expect(json.nodeCount).toBe(2);
  });

  it("returns 401 when unauthenticated", async () => {
    h.user = null;
    const res = await POST(
      req({ sourceFlowId: SOURCE, targetAccountId: TARGET }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for non-UUID ids", async () => {
    const res = await POST(req({ sourceFlowId: "nope", targetAccountId: TARGET }));
    expect(res.status).toBe(400);
  });

  it("returns 403 when the caller has no resolvable profile", async () => {
    h.profile = null;
    const res = await POST(
      req({ sourceFlowId: SOURCE, targetAccountId: TARGET }),
    );
    expect(res.status).toBe(403);
  });

  it("maps service authorization failures to their status", async () => {
    const { CopyFlowError } = (await import(
      "@/lib/flows/cross-account-copy"
    )) as unknown as {
      CopyFlowError: new (status: number, message: string) => Error;
    };
    h.copyImpl = async () => {
      throw new CopyFlowError(403, "Not authorized to copy this flow.");
    };
    const res = await POST(
      req({ sourceFlowId: SOURCE, targetAccountId: TARGET }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("Not authorized to copy this flow.");
  });
});
