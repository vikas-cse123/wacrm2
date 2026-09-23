import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainDueFollowups, isServiceWindowOpen } from "./scheduler";

const h = vi.hoisted(() => ({
  followups: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  sends: [] as Array<Record<string, unknown>>,
  sendBehavior: "ok" as "ok" | "meta-fail" | "db-fail",
  convId: "conv-1" as string | null,
}));

vi.mock("@/lib/conversations/get-or-create", () => ({
  getOrCreateConversation: async (
    _db: unknown,
    accountId: string,
    contactId: string,
    _auditUserId: string,
  ) => {
    void _auditUserId;
    if (h.convId === null) return null;
    return {
      conversation: { id: h.convId, account_id: accountId, contact_id: contactId },
      created: false,
    };
  },
}));

vi.mock("@/lib/whatsapp/send-message", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/whatsapp/send-message")>();
  return {
    ...actual,
    sendMessageToConversation: async (
      _db: unknown,
      _accountId: string,
      params: Record<string, unknown>,
    ) => {
      h.sends.push(params);
      if (h.sendBehavior === "meta-fail") {
        throw new actual.SendMessageError("meta_error", "Meta API error", 502);
      }
      if (h.sendBehavior === "db-fail") {
        throw new actual.SendMessageError(
          "db_error",
          "Message sent to Meta but failed to save to DB",
          500,
        );
      }
      const wamid = `wamid-${h.sends.length}`;
      h.messages.push({
        id: `msg-${h.sends.length}`,
        conversation_id: params.conversationId,
        message_id: wamid,
      });
      return { messageId: `msg-${h.sends.length}`, whatsappMessageId: wamid };
    },
  };
});

type Row = Record<string, unknown>;

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: `fu-${Math.random().toString(36).slice(2, 8)}`,
    account_id: "acct-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    scheduled_for: "2026-01-01T00:00:00.000Z",
    message_text: "Hi",
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
    const q: Record<string, unknown> = {
      _filters: [] as Array<(x: Row) => boolean>,
      _patch: null as Row | null,
      _table: table,
    };
    const store = () =>
      table === "whatsapp_followups" ? h.followups : h.messages;
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
      q._patch = patch;
      return q;
    };
    q.maybeSingle = async () => {
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
  h.messages = [];
  h.sends = [];
  h.sendBehavior = "ok";
  h.convId = "conv-1";
});

describe("isServiceWindowOpen", () => {
  it("is open with recent inbound, closed when stale or absent", async () => {
    const db = fakeDb();
    h.messages = [
      {
        conversation_id: "conv-1",
        sender_type: "customer",
        created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      },
    ];
    // Fake messages query: filter sender_type customer, newest first.
    await expect(isServiceWindowOpen(db as never, "conv-1", NOW)).resolves.toBe(true);
    h.messages = [
      {
        conversation_id: "conv-1",
        sender_type: "customer",
        created_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      },
    ];
    await expect(isServiceWindowOpen(db as never, "conv-1", NOW)).resolves.toBe(false);
    h.messages = [];
    await expect(isServiceWindowOpen(db as never, "conv-1", NOW)).resolves.toBe(false);
  });
});

describe("drainDueFollowups", () => {
  it("claims and sends a due follow-up exactly once", async () => {
    h.followups = [row({})];
    h.messages = [
      {
        conversation_id: "conv-1",
        sender_type: "customer",
        created_at: NOW.toISOString(),
      },
    ];
    const db = fakeDb();
    const first = await drainDueFollowups(db as never, NOW);
    expect(first).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      conversationId: "conv-1",
      messageType: "text",
    });
    const stored = h.followups[0] as Row;
    expect(stored.status).toBe("sent");
    expect(stored.whatsapp_message_id).toMatch(/^wamid-/);
    // Second drain finds nothing to do — no duplicate send.
    const second = await drainDueFollowups(db as never, NOW);
    expect(second).toMatchObject({ processed: 0, sent: 0 });
    expect(h.sends).toHaveLength(1);
  });

  it("skips cancelled follow-ups without sending", async () => {
    h.followups = [row({ status: "cancelled" })];
    // Cancelled rows never match the due scan in a real DB; force
    // the claim path by marking scheduled then cancelling mid-flight
    // is covered by processOne re-read — here assert no send occurs
    // for a row the scan would not return.
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(h.sends).toHaveLength(0);
    expect(out.sent).toBe(0);
  });

  it("fails loudly without a template outside the window", async () => {
    h.followups = [row({})];
    h.messages = [];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ processed: 1, failed: 1 });
    expect(h.sends).toHaveLength(0);
    expect(h.followups[0].status).toBe("failed");
    expect(String(h.followups[0].failure_reason)).toMatch(/24-hour|template/i);
  });

  it("sends the template when the window is closed", async () => {
    h.followups = [
      row({ template_name: "hello_world", template_language: "en_US" }),
    ];
    h.messages = [];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.sends[0]).toMatchObject({
      messageType: "template",
      templateName: "hello_world",
    });
  });

  it("marks Meta failures as failed with the reason stored", async () => {
    h.followups = [row({})];
    h.messages = [
      {
        conversation_id: "conv-1",
        sender_type: "customer",
        created_at: NOW.toISOString(),
      },
    ];
    h.sendBehavior = "meta-fail";
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out.failed).toBe(1);
    expect(h.followups[0].status).toBe("failed");
    expect(h.followups[0].failure_reason).toBeTruthy();
  });

  it("warns about possible double-send on DB-persist failure", async () => {
    h.followups = [row({})];
    h.messages = [
      {
        conversation_id: "conv-1",
        sender_type: "customer",
        created_at: NOW.toISOString(),
      },
    ];
    h.sendBehavior = "db-fail";
    const db = fakeDb();
    await drainDueFollowups(db as never, NOW);
    expect(String(h.followups[0].failure_reason)).toMatch(/already have been sent/i);
  });

  it("gives up after max attempts", async () => {
    h.followups = [row({ attempts: 3 })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out.failed).toBe(1);
    expect(h.sends).toHaveLength(0);
  });
});
