import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatReminderFailure,
  reconcileReminderDelivery,
} from "./delivery";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  failLookup: false,
  failUpdate: false,
}));

type Row = Record<string, unknown>;

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "fu-1",
    status: "sent",
    delivered_at: null,
    read_at: null,
    whatsapp_message_id: "wamid-1",
    ...overrides,
  };
}

/** Minimal thenable Supabase stand-in for the reconciliation queries. */
function fakeDb() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    if (table !== "whatsapp_followups") throw new Error(`unexpected ${table}`);
    const q: Record<string, unknown> = {
      _wamid: null as string | null,
      _id: null as string | null,
      _patch: null as Record<string, unknown> | null,
    };
    const applyPatch = () => {
      if (!q._patch) return;
      const target = h.rows.find((r) => r.id === q._id);
      if (target) {
        Object.assign(target, q._patch);
        h.writes.push({ id: target.id as string, patch: q._patch as Record<string, unknown> });
      }
    };
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      if (col === "whatsapp_message_id") q._wamid = val as string;
      if (col === "id") q._id = val as string;
      return q;
    };
    q.update = (patch: Record<string, unknown>) => {
      q._patch = patch;
      return q;
    };
    q.maybeSingle = async () => {
      if (h.failLookup) return { data: null, error: { message: "db down" } };
      const found =
        h.rows.find((r) => r.whatsapp_message_id === q._wamid) ?? null;
      return { data: found, error: null };
    };
    // Awaiting a bare chain applies any pending patch (mirrors the
    // real thenable client).
    q.then = (resolve: (v: unknown) => void) => {
      if (h.failUpdate) {
        return resolve({ data: null, error: { message: "db down" } });
      }
      applyPatch();
      return resolve({ data: null, error: null });
    };
    return q;
  };
  return api;
}

const TS = String(Math.floor(new Date("2026-09-24T20:26:00Z").getTime() / 1000));

beforeEach(() => {
  h.rows = [row()];
  h.writes = [];
  h.failLookup = false;
  h.failUpdate = false;
});

describe("reconcileReminderDelivery (6/7/8/9/10/14)", () => {
  it("6. sent keeps Sent with no write", async () => {
    const res = await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
      status: "sent",
      timestamp: TS,
    });
    expect(res).toEqual({ matched: true, updated: false });
    expect(h.writes).toHaveLength(0);
    expect(h.rows[0].status).toBe("sent");
  });

  it("7. delivered fills delivered_at once", async () => {
    const first = await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
      status: "delivered",
      timestamp: TS,
    });
    expect(first).toEqual({ matched: true, updated: true });
    expect(h.rows[0].delivered_at).toBe("2026-09-24T20:26:00.000Z");
    expect(h.rows[0].status).toBe("sent");
    // Replay is a no-op (never overwrites).
    const replay = await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
      status: "delivered",
      timestamp: String(Number(TS) + 60),
    });
    expect(replay).toEqual({ matched: true, updated: false });
    expect(h.rows[0].delivered_at).toBe("2026-09-24T20:26:00.000Z");
  });

  it("8. read fills read_at (and delivered_at when missing)", async () => {
    const res = await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
      status: "read",
      timestamp: TS,
    });
    expect(res).toEqual({ matched: true, updated: true });
    expect(h.rows[0].read_at).toBe("2026-09-24T20:26:00.000Z");
    expect(h.rows[0].delivered_at).toBe("2026-09-24T20:26:00.000Z");
    expect(h.rows[0].status).toBe("sent");
  });

  it("9. failed flips to Failed with the Meta error detail", async () => {
    const res = await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
      status: "failed",
      timestamp: TS,
      errors: [{ code: 131026, title: "Receiver incapable of receiving this message" }],
    });
    expect(res).toEqual({ matched: true, updated: true });
    expect(h.rows[0]).toMatchObject({
      status: "failed",
      failed_at: "2026-09-24T20:26:00.000Z",
    });
    expect(String(h.rows[0].failure_reason)).toMatch(/131026/);
    expect(String(h.rows[0].failure_reason)).toMatch(/incapable/);
  });

  it("10. correlates by wamid alone — no messages row needed", async () => {
    // The fake exposes ONLY whatsapp_followups: any messages-table
    // read would throw. Correlation succeeds regardless.
    const res = await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
      status: "delivered",
      timestamp: TS,
    });
    expect(res.matched).toBe(true);
  });

  it("14. ignores unknown wamids, non-sent rows, and unknown statuses", async () => {
    expect(
      await reconcileReminderDelivery(fakeDb() as never, "wamid-nope", {
        status: "delivered",
        timestamp: TS,
      }),
    ).toEqual({ matched: false, updated: false });

    h.rows = [row({ id: "fu-2", whatsapp_message_id: "wamid-2", status: "cancelled" })];
    expect(
      await reconcileReminderDelivery(fakeDb() as never, "wamid-2", {
        status: "failed",
        timestamp: TS,
        errors: [{ code: 1, title: "x" }],
      }),
    ).toEqual({ matched: true, updated: false });
    expect(h.rows[0].status).toBe("cancelled");

    h.rows = [row({ status: "failed" })];
    expect(
      await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
        status: "delivered",
        timestamp: TS,
      }),
    ).toEqual({ matched: true, updated: false });

    expect(
      await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
        status: "played",
        timestamp: TS,
      }),
    ).toEqual({ matched: false, updated: false });
    expect(h.writes).toHaveLength(0);
  });

  it("never throws on db failures or garbage timestamps", async () => {
    h.failLookup = true;
    expect(
      await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
        status: "delivered",
        timestamp: TS,
      }),
    ).toEqual({ matched: false, updated: false });
    h.failLookup = false;

    h.failUpdate = true;
    expect(
      await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
        status: "delivered",
        timestamp: TS,
      }),
    ).toEqual({ matched: true, updated: false });

    expect(
      await reconcileReminderDelivery(fakeDb() as never, "wamid-1", {
        status: "delivered",
        timestamp: "not-a-time",
      }),
    ).toEqual({ matched: false, updated: false });
    expect(
      await reconcileReminderDelivery(fakeDb() as never, "", {
        status: "delivered",
        timestamp: TS,
      }),
    ).toEqual({ matched: false, updated: false });
  });
});

describe("formatReminderFailure", () => {
  it("formats Meta codes/titles and caps length", () => {
    expect(formatReminderFailure([{ code: 131026, title: "Nope" }])).toBe(
      "Meta error code 131026: Nope",
    );
    expect(formatReminderFailure(null)).toBe("Meta reported delivery failure.");
    expect(formatReminderFailure([])).toBe("Meta reported delivery failure.");
    expect(formatReminderFailure([{ code: 1, title: "x".repeat(600) }]).length).toBeLessThanOrEqual(500);
  });
});
