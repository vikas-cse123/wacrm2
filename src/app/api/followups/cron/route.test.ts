import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  drain: { processed: 2, sent: 1, failed: 1, skipped: 0 },
}));

vi.mock("@/lib/followups/admin-client", () => ({
  supabaseAdmin: () => ({ from: () => ({}) }),
}));

vi.mock("@/lib/followups/scheduler", () => ({
  drainDueFollowups: async () => ({ ...h.drain }),
}));

const { GET } = await import("./route");

function authed(secret: string | null) {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["x-cron-secret"] = secret;
  return new Request("https://app.test/api/followups/cron", { headers });
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  delete process.env.AUTOMATION_CRON_SECRET;
});

describe("GET /api/followups/cron", () => {
  it("drains with a valid secret", async () => {
    const res = await GET(authed("s3cret"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, number>;
    expect(json).toMatchObject({ processed: 2, sent: 1, failed: 1 });
  });

  it("401s without the secret and 503s unconfigured", async () => {
    expect((await GET(authed("wrong"))).status).toBe(401);
    expect((await GET(authed(null))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(authed("s3cret"))).status).toBe(503);
    process.env.CRON_SECRET = "s3cret";
  });
});
