import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the VAPID env BEFORE importing send.ts so ensureConfigured() is
// true (the module captures the key values at load).
vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "test-public-key");
vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
vi.stubEnv("VAPID_SUBJECT", "mailto:test@example.com");

const h = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
  subs: [] as Array<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    user_id: string;
  }>,
  behaviors: {} as Record<
    string,
    Array<{ ok: true } | { reject: unknown }>
  >,
  deletedIds: [] as string[],
  touchedIds: [] as string[],
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: h.setVapidDetails,
    sendNotification: h.sendNotification,
  },
}));

vi.mock("@/lib/push/admin-client", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table !== "push_subscriptions") throw new Error(`unexpected table ${table}`);
      let mode: "select" | "delete" | "update" = "select";
      let ids: string[] = [];
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.neq = () => builder;
      builder.in = (col: string, vals: string[]) => {
        if (col === "id") ids = vals;
        return builder;
      };
      builder.update = () => {
        mode = "update";
        return builder;
      };
      builder.delete = () => {
        mode = "delete";
        return builder;
      };
      builder.then = (resolve: (v: unknown) => void) => {
        if (mode === "delete") {
          h.deletedIds.push(...ids);
          resolve({ error: null });
        } else if (mode === "update") {
          h.touchedIds.push(...ids);
          resolve({ error: null });
        } else {
          resolve({ data: h.subs, error: null });
        }
      };
      return builder;
    },
  }),
}));

const { sendPushToAccount } = await import("./send");

const ACCOUNT = "acct-1";
const sub = (id: string, endpoint: string) => ({
  id,
  endpoint,
  p256dh: "p",
  auth: "a",
  user_id: "u-" + id,
});

function nextOutcome(
  endpoint: string,
): { ok: true } | { reject: unknown } {
  const queue = h.behaviors[endpoint] ?? [];
  return queue.shift() ?? { ok: true };
}

// Drive each subscription's send from the behaviors map.
h.sendNotification.mockImplementation((subArg: { endpoint: string }) => {
  const spec = nextOutcome(subArg.endpoint);
  if ("ok" in spec) return Promise.resolve({ statusCode: 201 });
  return Promise.reject(spec.reject);
});

afterEach(() => {
  vi.unstubAllEnvs();
  // mockClear (not mockReset) so the behavior-driven implementation stays.
  h.sendNotification.mockClear();
  h.setVapidDetails.mockClear();
  h.subs = [];
  h.behaviors = {};
  h.deletedIds = [];
  h.touchedIds = [];
});

describe("sendPushToAccount fan-out", () => {
  it("prunes a 404/410 dead subscription", async () => {
    h.subs = [sub("sub-1", "https://push/1")];
    h.behaviors["https://push/1"] = [
      { reject: Object.assign(new Error("gone"), { statusCode: 404 }) },
    ];
    await sendPushToAccount(ACCOUNT, { title: "t", body: "b" });
    expect(h.sendNotification).toHaveBeenCalledTimes(1);
    expect(h.deletedIds).toEqual(["sub-1"]);
    expect(h.touchedIds).toEqual([]);
  });

  it("prunes a 401/403 subscription only when another subscription delivered", async () => {
    h.subs = [sub("sub-a", "https://push/a"), sub("sub-b", "https://push/b")];
    h.behaviors["https://push/a"] = [
      { reject: Object.assign(new Error("unauthorized"), { statusCode: 401 }) },
    ];
    h.behaviors["https://push/b"] = [{ ok: true }];
    await sendPushToAccount(ACCOUNT, { title: "t", body: "b" });
    expect(h.deletedIds).toEqual(["sub-a"]);
    expect(h.touchedIds).toEqual(["sub-b"]);
  });

  it("keeps 401/403 subscriptions when nothing delivered (VAPID/config suspected)", async () => {
    h.subs = [sub("sub-a", "https://push/a"), sub("sub-b", "https://push/b")];
    h.behaviors["https://push/a"] = [
      { reject: Object.assign(new Error("unauthorized"), { statusCode: 401 }) },
    ];
    h.behaviors["https://push/b"] = [
      { reject: Object.assign(new Error("forbidden"), { statusCode: 403 }) },
    ];
    await sendPushToAccount(ACCOUNT, { title: "t", body: "b" });
    expect(h.deletedIds).toEqual([]);
    expect(h.touchedIds).toEqual([]);
  });

  it("retries a transient 429 with backoff, then succeeds and touches last_used_at", async () => {
    h.subs = [sub("sub-1", "https://push/1")];
    h.behaviors["https://push/1"] = [
      { reject: Object.assign(new Error("rate limited"), { statusCode: 429 }) },
      { ok: true },
    ];
    await sendPushToAccount(ACCOUNT, { title: "t", body: "b" });
    expect(h.sendNotification).toHaveBeenCalledTimes(2);
    expect(h.deletedIds).toEqual([]);
    expect(h.touchedIds).toEqual(["sub-1"]);
  });

  it("keeps a subscription that exhausts transient retries (no pruning)", async () => {
    h.subs = [sub("sub-1", "https://push/1")];
    // Always 429 → retried up to the budget, then kept.
    h.behaviors["https://push/1"] = Array.from({ length: 5 }, () => ({
      reject: Object.assign(new Error("rate limited"), { statusCode: 429 }),
    }));
    await sendPushToAccount(ACCOUNT, { title: "t", body: "b" });
    expect(h.sendNotification.mock.calls.length).toBeGreaterThan(1);
    expect(h.deletedIds).toEqual([]);
    expect(h.touchedIds).toEqual([]);
  });

  it("does not retry permanent errors", async () => {
    h.subs = [sub("sub-1", "https://push/1")];
    h.behaviors["https://push/1"] = [
      { reject: Object.assign(new Error("bad request"), { statusCode: 400 }) },
    ];
    await sendPushToAccount(ACCOUNT, { title: "t", body: "b" });
    expect(h.sendNotification).toHaveBeenCalledTimes(1);
    expect(h.deletedIds).toEqual([]);
  });

  it("does not retry timeouts (bounds webhook latency)", async () => {
    h.subs = [sub("sub-1", "https://push/1")];
    h.behaviors["https://push/1"] = [{ reject: new Error("Socket timeout") }];
    await sendPushToAccount(ACCOUNT, { title: "t", body: "b" });
    expect(h.sendNotification).toHaveBeenCalledTimes(1);
    expect(h.deletedIds).toEqual([]);
  });

  it("a failing subscription never blocks a healthy one", async () => {
    h.subs = [sub("sub-a", "https://push/a"), sub("sub-b", "https://push/b")];
    h.behaviors["https://push/a"] = Array.from({ length: 5 }, () => ({
      reject: Object.assign(new Error("server error"), { statusCode: 500 }),
    }));
    h.behaviors["https://push/b"] = [{ ok: true }];
    await sendPushToAccount(ACCOUNT, { title: "t", body: "b" });
    expect(h.touchedIds).toEqual(["sub-b"]);
    // sub-a exhausted retries and was kept; sub-b delivered.
    expect(h.deletedIds).toEqual([]);
  });
});