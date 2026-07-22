import { describe, it, expect, beforeEach, vi } from "vitest";

// Self-contained mock for the resume path. Kept separate from engine.test.ts
// so the tag-presence guard can be exercised without reshaping that file's
// mock (which is tuned for runAutomationsForTrigger).
const h = vi.hoisted(() => ({
  state: {
    automation: null as Record<string, unknown> | null,
    steps: [] as Record<string, unknown>[],
    // How many contact_tags rows the guard's count query should see.
    tagCount: 0,
    pendingUpdates: [] as unknown[],
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: { table: string; type: string; payload?: unknown }) {
    const { table, type } = ops;
    if (table === "automations") return { data: state.automation, error: null };
    if (table === "contact_tags") return { count: state.tagCount, error: null };
    if (table === "automation_steps") return { data: state.steps, error: null };
    if (table === "automation_logs") return { data: null, error: null };
    if (table === "automation_pending_executions") {
      if (type === "update") state.pendingUpdates.push(ops.payload);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = { table, type: "select", payload: undefined as unknown };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      delete: () => ((ops.type = "delete"), b),
      upsert: (p: unknown) => ((ops.type = "upsert"), (ops.payload = p), b),
      eq: () => b,
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

const sendText = vi.fn(async () => ({ whatsapp_message_id: "m1" }));
vi.mock("./meta-send", () => ({
  engineSendText: (...args: unknown[]) => sendText(...args),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import { resumePendingExecution } from "./engine";

const TAG = "tag-singapore-incomplete";

function tagAddedAutomation() {
  return {
    id: "a1",
    account_id: "acct-1",
    user_id: "u1",
    trigger_type: "tag_added",
    trigger_config: { tag_id: TAG },
    is_active: true,
  };
}

function sendStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "send_message",
    position: 1,
    parent_step_id: null,
    step_config: { text: "It seems you got busy earlier." },
  };
}

function pending() {
  return {
    id: "p1",
    automation_id: "a1",
    user_id: "u1",
    account_id: "acct-1",
    contact_id: "c1",
    log_id: "log1",
    parent_step_id: null,
    branch: null,
    next_step_position: 1,
    context: { tag_id: TAG, conversation_id: "conv1" },
  };
}

beforeEach(() => {
  h.state.automation = tagAddedAutomation();
  h.state.steps = [sendStep()];
  h.state.tagCount = 0;
  h.state.pendingUpdates = [];
  sendText.mockClear();
});

describe("resumePendingExecution — tag_added guard", () => {
  it("skips the send when the triggering tag was removed during the wait", async () => {
    h.state.tagCount = 0; // flow's "Remove tag" node cleared it after completion

    await resumePendingExecution(pending());

    expect(sendText).not.toHaveBeenCalled();
    // The pending row is still resolved (not left dangling) so the cron won't
    // keep retrying it.
    expect(h.state.pendingUpdates).toContainEqual({ status: "done" });
  });

  it("sends when the tag is still present (contact never finished)", async () => {
    h.state.tagCount = 1; // still tagged "Singapore incomplete"

    await resumePendingExecution(pending());

    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
