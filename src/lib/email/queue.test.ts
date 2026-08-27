import { describe, expect, it, vi, beforeEach } from "vitest";

import type { FlowEmailNotificationRow } from "./types";
import {
  enqueueFlowEmailNotification,
  drainFlowEmailNotifications,
  hasAttemptsLeft,
  nextRetryDelayMs,
  resolveRecipient,
  renderEmailContent,
} from "./queue";
import { sendEmailViaSmtp } from "./send";

vi.mock("./send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send")>();
  return { ...actual, sendEmailViaSmtp: vi.fn() };
});

const sendMock = vi.mocked(sendEmailViaSmtp);

// ------------------------------------------------------------
// Minimal chainable Supabase fake — records operations, returns
// configured results. Enough to exercise the queue lifecycle.
// ------------------------------------------------------------

interface FakeConfig {
  dueRows?: FlowEmailNotificationRow[];
  accounts?: { owner_user_id?: string } | null;
  ownerProfile?: { email?: string } | null;
  authorProfile?: { email?: string } | null;
  contact?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    company?: string | null;
  } | null;
  flow?: { name?: string } | null;
  claimSucceeds?: boolean;
}

interface RecordedUpdate {
  table: string;
  patch: Record<string, unknown>;
  filters: string[];
}

class FakeQuery {
  table: string;
  config: FakeConfig;
  filters: string[] = [];
  patch: Record<string, unknown> | null = null;
  insertRow: Record<string, unknown> | null = null;
  insertReturnId: string;
  selectedCols = "";

  constructor(table: string, config: FakeConfig, insertReturnId: string) {
    this.table = table;
    this.config = config;
    this.insertReturnId = insertReturnId;
  }

  select(cols: unknown) {
    this.selectedCols = String(cols);
    return this;
  }

  eq(k: string, v: unknown) {
    this.filters.push(`eq:${k}=${String(v)}`);
    return this;
  }

  lte(k: string, v: unknown) {
    this.filters.push(`lte:${k}=${String(v)}`);
    return this;
  }

  in(k: string, v: unknown) {
    this.filters.push(`in:${k}=${JSON.stringify(v)}`);
    return this;
  }

  order(key: unknown, opts: unknown) {
    this.filters.push(`order:${String(key)}:${String(opts)}`);
    return this;
  }

  limit(n: unknown) {
    this.filters.push(`limit:${String(n)}`);
    return this;
  }

  update(patch: Record<string, unknown>) {
    this.patch = patch;
    return this;
  }

  insert(row: Record<string, unknown>) {
    this.insertRow = row;
    return this;
  }

  // Terminal reads -------------------------------------------------
  async maybeSingle() {
    if (this.table === "accounts") {
      return { data: this.config.accounts ?? null, error: null };
    }
    if (this.table === "profiles") {
      const byUser = this.filters.find((f) => f.startsWith("eq:user_id="));
      const userId = byUser ? byUser.split("=")[1] : "";
      const ownerId = this.config.accounts?.owner_user_id ?? "";
      const profile =
        userId === ownerId && this.config.ownerProfile
          ? this.config.ownerProfile
          : this.config.authorProfile;
      return { data: profile ?? null, error: null };
    }
    if (this.table === "contacts") {
      return { data: this.config.contact ?? null, error: null };
    }
    if (this.table === "flows") {
      return { data: this.config.flow ?? null, error: null };
    }
    // claim on flow_email_notifications
    const isClaim = this.filters.some((f) => f.startsWith("eq:id="));
    if (isClaim) {
      const id = this.filters.find((f) => f.startsWith("eq:id="))!.split("=")[1];
      return this.config.claimSucceeds === false
        ? { data: null, error: null }
        : { data: { id }, error: null };
    }
    return { data: null, error: null };
  }

  async single() {
    if (this.table === "flow_email_notifications" && this.insertRow) {
      return { data: { id: this.insertReturnId }, error: null };
    }
    return { data: null, error: null };
  }

  // Awaited chain without a terminal read (the due scan) ------------
  then(resolve: (v: { data: unknown; error: null }) => void) {
    if (this.table === "flow_email_notifications" && this.patch === null) {
      return Promise.resolve({
        data: this.config.dueRows ?? [],
        error: null,
      }).then(resolve);
    }
    // update chains (stale reset, sent/failed writes) resolve empty.
    return Promise.resolve({ data: null, error: null }).then(resolve);
  }
}

function makeDb(config: FakeConfig = {}) {
  const updates: RecordedUpdate[] = [];
  const inserts: Record<"table" | "row", unknown>[] = [];
  const db = {
    updates,
    inserts,
    _calls: [] as string[],
    from(table: string) {
      this._calls.push(table);
      const q = new FakeQuery(table, config, "job-123");
      // record updates / inserts on terminal call
      const origMaybeSingle = q.maybeSingle.bind(q);
      q.maybeSingle = async () => {
        if (q.patch) {
          updates.push({ table, patch: q.patch, filters: q.filters });
        }
        return origMaybeSingle();
      };
      const origSingle = q.single.bind(q);
      q.single = async () => {
        if (q.insertRow) inserts.push({ table, row: q.insertRow });
        return origSingle();
      };
      const origThen = q.then.bind(q);
      q.then = (resolve) => {
        if (q.patch) updates.push({ table, patch: q.patch, filters: q.filters });
        return origThen(resolve);
      };
      return q;
    },
  };
  return db;
}

function runRow(over: Partial<FlowRunRowLike> = {}): FlowRunRowLike {
  return {
    id: "run-1",
    account_id: "acct-1",
    user_id: "user-1",
    flow_id: "flow-1",
    contact_id: "contact-1",
    vars: { name: "Priya", answer: "pricing" },
    ...over,
  };
}

type FlowRunRowLike = {
  id: string;
  account_id: string;
  user_id: string;
  flow_id: string;
  contact_id: string | null;
  vars: Record<string, unknown>;
};

function node(over: Partial<Record<string, unknown>> = {}): { node_key: string; config: Record<string, unknown> } {
  return {
    node_key: "notify",
    config: {
      recipient_mode: "custom",
      recipient_email: "sales@agency.com",
      subject: "New lead: {{contact.name}}",
      body: "Name: {{contact.name}}\nPhone: {{contact.phone}}\nFlow: {{flow.name}}\nStage: {{vars.answer}}",
      next_node_key: "next",
      ...over,
    },
  };
}

function jobRow(over: Partial<FlowEmailNotificationRow> = {}): FlowEmailNotificationRow {
  return {
    id: "job-1",
    account_id: "acct-1",
    user_id: "user-1",
    flow_id: "flow-1",
    flow_run_id: "run-1",
    contact_id: "contact-1",
    node_key: "notify",
    recipient_mode: "custom",
    recipient: "sales@agency.com",
    subject: "New lead: {{contact.name}}",
    body: "Name: {{contact.name}}\nPhone: {{contact.phone}}\nFlow: {{flow.name}}\nStage: {{vars.answer}}",
    vars: { name: "Priya", answer: "pricing" },
    status: "queued",
    attempt: 0,
    max_attempts: 3,
    last_error: null,
    queued_at: "2026-01-01T00:00:00.000Z",
    next_attempt_at: "2026-01-01T00:00:00.000Z",
    sent_at: null,
    failed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
});

// ------------------------------------------------------------
// Retry policy
// ------------------------------------------------------------

describe("retry policy", () => {
  it("backs off exponentially: 1m, 2m, 4m, capped at 15m", () => {
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(120_000);
    expect(nextRetryDelayMs(3)).toBe(240_000);
    expect(nextRetryDelayMs(4)).toBe(480_000);
    expect(nextRetryDelayMs(5)).toBe(900_000);
    expect(nextRetryDelayMs(10)).toBe(900_000);
  });

  it("hasAttemptsLeft respects max_attempts", () => {
    expect(hasAttemptsLeft({ attempt: 0, max_attempts: 3 })).toBe(true);
    expect(hasAttemptsLeft({ attempt: 2, max_attempts: 3 })).toBe(true);
    expect(hasAttemptsLeft({ attempt: 3, max_attempts: 3 })).toBe(false);
  });
});

// ------------------------------------------------------------
// Enqueue (the flow engine's non-blocking path)
// ------------------------------------------------------------

describe("enqueueFlowEmailNotification", () => {
  it("inserts a durable job with a vars snapshot and returns its id", async () => {
    const db = makeDb();
    const result = await enqueueFlowEmailNotification(db as never, runRow() as never, node() as never);

    expect(result).toEqual({ ok: true, jobId: "job-123" });
    expect(db.inserts).toHaveLength(1);
    const row = db.inserts[0].row as Record<string, unknown>;
    expect(row.recipient_mode).toBe("custom");
    expect(row.recipient).toBe("sales@agency.com");
    expect(row.account_id).toBe("acct-1");
    expect(row.flow_run_id).toBe("run-1");
    expect(row.subject).toContain("{{contact.name}}");
    expect(row.vars).toEqual({ name: "Priya", answer: "pricing" });
  });

  it("rejects an invalid custom recipient without inserting", async () => {
    const db = makeDb();
    const result = await enqueueFlowEmailNotification(
      db as never,
      runRow() as never,
      node({ recipient_email: "not-an-email" }) as never,
    );
    expect(result.ok).toBe(false);
    expect(db.inserts).toHaveLength(0);
  });

  it("stores my_email mode with a null recipient", async () => {
    const db = makeDb();
    const result = await enqueueFlowEmailNotification(
      db as never,
      runRow() as never,
      node({ recipient_mode: "my_email", recipient_email: "" }) as never,
    );
    expect(result.ok).toBe(true);
    const row = db.inserts[0].row as Record<string, unknown>;
    expect(row.recipient_mode).toBe("my_email");
    expect(row.recipient).toBeNull();
  });
});

// ------------------------------------------------------------
// Recipient + content resolution
// ------------------------------------------------------------

describe("resolveRecipient", () => {
  it("uses the custom address", async () => {
    const db = makeDb();
    expect(await resolveRecipient(db as never, jobRow() as never)).toBe(
      "sales@agency.com",
    );
  });

  it("resolves my_email to the account owner's email", async () => {
    const db = makeDb({
      accounts: { owner_user_id: "owner-1" },
      ownerProfile: { email: "owner@agency.com" },
      authorProfile: { email: "author@agency.com" },
    });
    expect(
      await resolveRecipient(db as never, jobRow({ recipient_mode: "my_email", recipient: null }) as never),
    ).toBe("owner@agency.com");
  });

  it("falls back to the flow author's email when the owner has none", async () => {
    const db = makeDb({
      accounts: { owner_user_id: "owner-1" },
      ownerProfile: null,
      authorProfile: { email: "author@agency.com" },
    });
    expect(
      await resolveRecipient(db as never, jobRow({ recipient_mode: "my_email", recipient: null }) as never),
    ).toBe("author@agency.com");
  });

  it("returns null when no email resolves", async () => {
    const db = makeDb({ accounts: null, authorProfile: null });
    expect(
      await resolveRecipient(db as never, jobRow({ recipient_mode: "my_email", recipient: null }) as never),
    ).toBeNull();
  });
});

describe("renderEmailContent", () => {
  it("interpolates contact + flow + vars", async () => {
    const db = makeDb({
      contact: { name: "Priya Sharma", phone: "+919876543210" },
      flow: { name: "New Lead Intake" },
    });
    const { subject, body } = await renderEmailContent(db as never, jobRow() as never);
    expect(subject).toBe("New lead: Priya Sharma");
    expect(body).toContain("Name: Priya Sharma");
    expect(body).toContain("Phone: +919876543210");
    expect(body).toContain("Flow: New Lead Intake");
    expect(body).toContain("Stage: pricing");
  });

  it("renders empty strings when contact/flow are missing", async () => {
    const db = makeDb({ contact: null, flow: null });
    const { subject, body } = await renderEmailContent(db as never, jobRow() as never);
    expect(subject).toBe("New lead: ");
    expect(body).toContain("Name: ");
  });
});

// ------------------------------------------------------------
// Drain lifecycle
// ------------------------------------------------------------

describe("drainFlowEmailNotifications", () => {
  it("sends a due job and marks it sent", async () => {
    const db = makeDb({
      dueRows: [jobRow()],
      contact: { name: "Priya Sharma", phone: "+919876543210" },
      flow: { name: "New Lead Intake" },
    });
    const result = await drainFlowEmailNotifications(db as never);

    expect(result).toEqual({ sent: 1, failed: 0, finalFailures: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArg = sendMock.mock.calls[0][0];
    expect(sendArg.to).toBe("sales@agency.com");
    expect(sendArg.subject).toBe("New lead: Priya Sharma");
    expect(sendArg.text).toContain("Flow: New Lead Intake");

    const sentUpdate = db.updates.find(
      (u) => u.table === "flow_email_notifications" && u.patch.status === "sent",
    );
    expect(sentUpdate).toBeTruthy();
    expect(sentUpdate!.patch.sent_at).toBeTruthy();
    expect(sentUpdate!.patch.next_attempt_at).toBeNull();
  });

  it("schedules a retry with backoff on a failed send (attempt < max)", async () => {
    sendMock.mockRejectedValueOnce(new Error("SMTP timeout"));
    const db = makeDb({ dueRows: [jobRow()] });
    const result = await drainFlowEmailNotifications(db as never);

    expect(result).toEqual({ sent: 0, failed: 1, finalFailures: 0 });
    const failedUpdate = db.updates.find(
      (u) => u.table === "flow_email_notifications" && u.patch.status === "failed",
    );
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate!.patch.attempt).toBe(1);
    expect(failedUpdate!.patch.last_error).toBe("SMTP timeout");
    // first retry = +1 minute into the future
    const nextAt = new Date(
      failedUpdate!.patch.next_attempt_at as string,
    ).getTime();
    expect(nextAt).toBeGreaterThan(Date.now() - 5_000);
    expect(nextAt).toBeGreaterThanOrEqual(Date.now() + 55_000);
  });

  it("terminal-fails a job once attempts are exhausted", async () => {
    sendMock.mockRejectedValue(new Error("provider down"));
    const db = makeDb({ dueRows: [jobRow({ attempt: 2 })] });
    const result = await drainFlowEmailNotifications(db as never);

    expect(result).toEqual({ sent: 0, failed: 1, finalFailures: 1 });
    const finalUpdate = db.updates.find(
      (u) =>
        u.table === "flow_email_notifications" &&
        u.patch.status === "failed" &&
        u.patch.failed_at,
    );
    expect(finalUpdate).toBeTruthy();
    expect(finalUpdate!.patch.attempt).toBe(3);
    expect(finalUpdate!.patch.next_attempt_at).toBeNull();
    expect(finalUpdate!.patch.last_error).toBe("provider down");
  });

  it("skips a job it loses the claim race on", async () => {
    const db = makeDb({ dueRows: [jobRow()], claimSucceeds: false });
    const result = await drainFlowEmailNotifications(db as never);
    expect(result).toEqual({ sent: 0, failed: 0, finalFailures: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not advance a run when the job fails — a drained failure only touches the job row", async () => {
    // The drain never touches flow_runs; assert no flow_runs update.
    sendMock.mockRejectedValue(new Error("SMTP not configured"));
    const db = makeDb({ dueRows: [jobRow()] });
    await drainFlowEmailNotifications(db as never);
    expect(db.updates.every((u) => u.table !== "flow_runs")).toBe(true);
  });
});