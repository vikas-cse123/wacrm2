import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainDueFollowups } from "./scheduler";

const h = vi.hoisted(() => ({
  followups: [] as Array<Record<string, unknown>>,
  sends: [] as Array<{ to: string; text: string; accountId: string }>,
  sendBehavior: "ok" as "ok" | "meta-fail",
  tablesRead: [] as string[],
  writes: [] as Array<{ table: string; op: string }>,
  // A "current" profile number that DIFFERS from every row snapshot —
  // proves the scheduler never re-reads the profile for delivery.
  profileNumber: "9999999999",
}));

// The self-reminder sender is mocked at the module boundary: no Meta
// calls, no config reads here. reminder-send.ts has its own tests.
vi.mock("./reminder-send", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./reminder-send")>();
  return {
    ...actual,
    sendReminderToAgent: async (
      _db: unknown,
      accountId: string,
      params: { to: string; text: string },
    ) => {
      h.sends.push({ ...params, accountId });
      if (h.sendBehavior === "meta-fail") {
        throw new actual.SendMessageError("meta_error", "Meta API error", 502);
      }
      return { whatsappMessageId: `wamid-${h.sends.length}` };
    },
  };
});

type Row = Record<string, unknown>;

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: `fu-${Math.random().toString(36).slice(2, 8)}`,
    account_id: "acct-1",
    // Immutable creation-time snapshot of the creator's number.
    recipient_phone: "919876543210",
    // Customer context only — its phone must NEVER be dialed.
    contact_id: "contact-9",
    conversation_id: null,
    scheduled_for: "2026-01-01T00:00:00.000Z",
    message_text: "Call Rahul about Singapore package",
    template_name: null,
    template_language: null,
    status: "scheduled",
    attempts: 0,
    created_by: "user-1",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal in-memory Supabase stand-in honoring the scheduler's queries. */
function fakeDb() {
  const matches = (r: Row, filters: Array<(x: Row) => boolean>) =>
    filters.every((f) => f(r));
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    h.tablesRead.push(table);
    const q: Record<string, unknown> = {
      _filters: [] as Array<(x: Row) => boolean>,
      _patch: null as Row | null,
      _table: table,
    };
    const store = () =>
      table === "whatsapp_followups" ? h.followups : [];
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      (q._filters as Array<(x: Row) => boolean>).push((r) => r[col] === val);
      return q;
    };
    q.in = (col: string, vals: unknown[]) => {
      (q._filters as Array<(x: Row) => boolean>).push((r) =>
        (vals as unknown[]).includes(r[col]),
      );
      return q;
    };
    q.or = (expr: string) => {
      // Supports the two scheduler predicates: due scan and claim.
      (q._filters as Array<(x: Row) => boolean>).push((r) => {
        const m = expr.match(/lte\.([^,)]+)/);
        const bound = m ? m[1] : "";
        const scheduledDue =
          r.status === "scheduled" &&
          String(r.scheduled_for) <= (bound || (r.scheduled_for as string));
        // Claim form carries explicit updated_at bound for processing.
        const upd = expr.match(/updated_at\.lt\.([^,)]+)/);
        const stale =
          r.status === "processing" &&
          upd != null &&
          String(r.updated_at) < upd[1];
        if (expr.includes("status.eq.scheduled") && expr.includes("status.eq.processing")) {
          return scheduledDue || stale;
        }
        return scheduledDue || r.status === "processing";
      });
      return q;
    };
    q.order = () => q;
    q.limit = () => q;
    q.update = (patch: Row) => {
      h.writes.push({ table, op: "update" });
      q._patch = patch;
      return q;
    };
    q.insert = (obj: Row) => {
      h.writes.push({ table, op: "insert" });
      void obj;
      return q;
    };
    q.maybeSingle = async () => {
      // The scheduler never resolves recipients from profiles; serve
      // a decoy number so any such read would be caught by assertion.
      if (table === "profiles") {
        return {
          data: { whatsapp_number: h.profileNumber },
          error: null,
        };
      }
      const rows = store().filter((r) =>
        matches(r, q._filters as Array<(x: Row) => boolean>),
      );
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows[0] ?? null, error: null };
    };
    // Supabase builders are thenable: awaiting a bare chain (the
    // due scan, status updates) resolves the filtered rows and
    // applies any pending patch — mirroring the real client.
    q.then = (resolve: (v: unknown) => void) => {
      const rows = store().filter((r) =>
        matches(r, q._filters as Array<(x: Row) => boolean>),
      );
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
      }
      return resolve({ data: rows, error: null });
    };
    return q;
  };
  return api;
}

const NOW = new Date("2026-09-23T12:00:00.000Z");

beforeEach(() => {
  h.followups = [];
  h.sends = [];
  h.sendBehavior = "ok";
  h.tablesRead = [];
  h.writes = [];
});

/** Every write the scheduler performs must target its own rows. */
function expectNoCustomerSideEffects() {
  expect(h.tablesRead).not.toContain("messages");
  expect(h.tablesRead).not.toContain("conversations");
  expect(h.tablesRead).not.toContain("contacts");
  expect(h.tablesRead).not.toContain("flow_runs");
  for (const w of h.writes) {
    expect(w.table).toBe("whatsapp_followups");
  }
}

describe("drainDueFollowups (self-reminders)", () => {
  it("sends to the recipient snapshot — never the customer phone", async () => {
    h.followups = [row({})];
    const db = fakeDb();
    const first = await drainDueFollowups(db as never, NOW);
    expect(first).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      to: "919876543210",
      text: "Call Rahul about Singapore package",
      accountId: "acct-1",
    });
    const stored = h.followups[0] as Row;
    expect(stored.status).toBe("sent");
    expect(stored.whatsapp_message_id).toMatch(/^wamid-/);
    expectNoCustomerSideEffects();
    // Second drain finds nothing to do — no duplicate send.
    const second = await drainDueFollowups(db as never, NOW);
    expect(second).toMatchObject({ processed: 0, sent: 0 });
    expect(h.sends).toHaveLength(1);
  });

  it("ignores later profile-number changes (snapshot is immutable)", async () => {
    h.followups = [row({})];
    h.profileNumber = "911111111111";
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.sends[0].to).toBe("919876543210");
    expect(h.tablesRead).not.toContain("profiles");
  });

  it("sends without a customer and without any template or window", async () => {
    // No customer context at all, no template, no recent inbound —
    // the customer 24-hour window must not gate self-reminders.
    h.followups = [row({ contact_id: null })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.sends[0].to).toBe("919876543210");
    expectNoCustomerSideEffects();
  });

  it("customer message activity cannot change the recipient", async () => {
    h.followups = [row({})];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    // The scheduler never even looks at the messages table.
    expect(h.tablesRead).not.toContain("messages");
    expect(h.sends[0].to).toBe("919876543210");
  });

  it("fails loudly on legacy rows without a recipient snapshot", async () => {
    h.followups = [row({ recipient_phone: null })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(h.sends).toHaveLength(0);
    expect(h.followups[0].status).toBe("failed");
    expect(String(h.followups[0].failure_reason)).toMatch(/recipient/i);
  });

  it("fails loudly without a creator", async () => {
    h.followups = [row({ created_by: null })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ failed: 1 });
    expect(h.sends).toHaveLength(0);
  });

  it("skips cancelled reminders without sending", async () => {
    h.followups = [row({ status: "cancelled" })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(h.sends).toHaveLength(0);
    expect(out.sent).toBe(0);
  });

  it("does not send future reminders early", async () => {
    h.followups = [row({ scheduled_for: "2999-01-01T00:00:00.000Z" })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, new Date("2026-01-01T00:00:00.000Z"));
    expect(out).toMatchObject({ processed: 0, sent: 0 });
    expect(h.sends).toHaveLength(0);
  });

  it("marks Meta failures as failed with the reason stored", async () => {
    h.followups = [row({})];
    h.sendBehavior = "meta-fail";
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out.failed).toBe(1);
    expect(h.followups[0].status).toBe("failed");
    expect(h.followups[0].failure_reason).toBeTruthy();
  });

  it("gives up after max attempts", async () => {
    h.followups = [row({ attempts: 3 })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out.failed).toBe(1);
    expect(h.sends).toHaveLength(0);
  });

  it("scopes the send to the reminder's own account", async () => {
    h.followups = [row({ account_id: "acct-9" })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.sends[0].accountId).toBe("acct-9");
  });
});
