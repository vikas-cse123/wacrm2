import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  recordings: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
}));

function chainable(table: string) {
  const api: Record<string, (...args: never[]) => unknown> = {};
  api.select = () => api;
  api.eq = (...args: never[]) => {
    h.calls.push({ table, op: "eq", args: args as unknown[] });
    return api;
  };
  api.or = (...args: never[]) => {
    h.calls.push({ table, op: "or", args: args as unknown[] });
    return api;
  };
  api.in = (...args: never[]) => {
    h.calls.push({ table, op: "in", args: args as unknown[] });
    return api;
  };
  api.range = async () => ({ data: h.recordings, error: null });
  return api;
}

function fakeSupabase() {
  return {
    from: (table: string) => chainable(table),
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

function rec(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    contact_id: "c-1",
    direction: "out",
    call_type: "phone",
    duration_seconds: 60,
    recorded_at: "2026-10-04T12:00:00.000Z",
    created_at: "2026-10-04T12:00:00.000Z",
    ...over,
  };
}

const RANGE = "from=2026-10-01T00:00:00.000Z&to=2026-10-06T00:00:00.000Z";

beforeEach(() => {
  h.accountId = "acct-1";
  h.recordings = [];
  h.calls = [];
});

describe("GET /api/calls/stats", () => {
  it("returns recording metrics scoped by account", async () => {
    h.recordings = [
      rec(),
      rec({ id: "r-2", direction: "in", call_type: "whatsapp", contact_id: null }),
    ];
    const res = await GET(new Request(`https://app.test/api/calls/stats?${RANGE}`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      recordingCount: 2,
      recordingDurationSecs: 120,
      incomingRecordings: 1,
      outgoingRecordings: 1,
      phoneRecordings: 1,
      whatsappRecordings: 1,
      whatsappBusinessRecordings: 0,
      uniqueClients: 1,
      unlinkedRecordings: 1,
      averageDurationSecs: 60,
      unknownDirectionRecordings: 0,
      truncated: false,
    });
    expect(json.previous).toMatchObject({
      recordingCount: 2,
      incomingRecordings: 1,
      outgoingRecordings: 1,
    });
    expect(json.daily).toHaveLength(5);
    expect(json.durationBuckets).toEqual({
      under30: 0,
      from30To60: 0,
      min1To5: 2,
      min5To10: 0,
      over10: 0,
    });
    expect(json.topClients).toHaveLength(1);
    expect(json.recent).toHaveLength(2);
    const eqs = h.calls.filter((c) => c.table === "call_recordings" && c.op === "eq");
    expect(eqs).toContainEqual({ table: "call_recordings", op: "eq", args: ["account_id", "acct-1"] });
  });

  it("rejects missing, inverted, and oversized ranges", async () => {
    const missing = await GET(new Request("https://app.test/api/calls/stats"));
    expect(missing.status).toBe(400);
    const bad = await GET(
      new Request("https://app.test/api/calls/stats?from=2026-10-06T00:00:00.000Z&to=2026-10-01T00:00:00.000Z")
    );
    expect(bad.status).toBe(400);
    const wide = await GET(
      new Request("https://app.test/api/calls/stats?from=2020-01-01T00:00:00.000Z&to=2026-10-06T00:00:00.000Z")
    );
    expect(wide.status).toBe(400);
  });

  it("exposes no storage internals", async () => {
    h.recordings = [rec()];
    const res = await GET(new Request(`https://app.test/api/calls/stats?${RANGE}`));
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(
      [
        "averageDurationSecs",
        "daily",
        "durationBuckets",
        "incomingRecordings",
        "outgoingRecordings",
        "phoneRecordings",
        "previous",
        "recent",
        "recordingCount",
        "recordingDurationSecs",
        "topClients",
        "truncated",
        "uniqueClients",
        "unknownDirectionRecordings",
        "unlinkedRecordings",
        "whatsappBusinessRecordings",
        "whatsappRecordings",
      ].sort()
    );
    const dumped = JSON.stringify(json);
    expect(dumped).not.toContain("storage_bucket");
    expect(dumped).not.toContain("storage_path");
  });

  it("filters by user and direction when valid, 400s when not", async () => {
    h.recordings = [rec()];
    const userId = "123e4567-e89b-12d3-a456-426614174000";
    const ok = await GET(
      new Request(`https://app.test/api/calls/stats?${RANGE}&user=${userId}&direction=in`)
    );
    expect(ok.status).toBe(200);
    const eqs = h.calls.filter((c) => c.table === "call_recordings" && c.op === "eq");
    expect(eqs).toContainEqual({
      table: "call_recordings",
      op: "eq",
      args: ["uploaded_by", userId],
    });
    expect(eqs).toContainEqual({ table: "call_recordings", op: "eq", args: ["direction", "in"] });

    const badUser = await GET(new Request(`https://app.test/api/calls/stats?${RANGE}&user=nope`));
    expect(badUser.status).toBe(400);
    const badDir = await GET(
      new Request(`https://app.test/api/calls/stats?${RANGE}&direction=missed`)
    );
    expect(badDir.status).toBe(400);
  });
});
