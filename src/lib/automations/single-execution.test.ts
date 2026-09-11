// ============================================================
// runAutomationsForTrigger singularity documentation test.
//
// A single trigger dispatch must create exactly one automation log and
// one send. (Deliberately does NOT pin double-dispatch behavior: the
// automation layer has no cross-dispatch dedup by design, and adding an
// assertion for it here would enshrine the gap instead of fixing the
// upstream duplicate-advance race — see
// src/lib/flows/dispatch-concurrency.test.ts, which proves duplicates
// never reach this layer twice for one logical event.)
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    logInserts: 0,
    sends: 0,
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;
  function builder(table: string) {
    const ops = {
      type: "select" as string,
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: () => b,
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      order: () => b,
      gte: () => b,
      is: () => b,
      single: () => Promise.resolve(resolve()),
      maybeSingle: () => Promise.resolve(resolve()),
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF),
    };
    function resolve() {
      if (table === "contacts") {
        return {
          data: { id: "contact-1", account_id: "acct-1" },
          error: null,
        };
      }
      if (table === "automations") {
        return { data: state.automations, error: null };
      }
      if (table === "automation_logs") {
        if (ops.type === "insert") {
          state.logInserts += 1;
          return { data: { id: `log-${state.logInserts}` }, error: null };
        }
        return { data: { steps_executed: [], status: "success" }, error: null };
      }
      if (table === "automation_steps") {
        return { data: state.steps, error: null };
      }
      if (table === "conversations") {
        return { data: { id: "conv-1" }, error: null };
      }
      return { data: null, error: null };
    }
    return b;
  }
  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => {
    h.state.sends += 1;
    return { whatsapp_message_id: "wamid-1" };
  }),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "wamid-t" })),
}));

import { runAutomationsForTrigger } from "./engine";

beforeEach(() => {
  h.state.automations = [
    {
      id: "auto-1",
      account_id: "acct-1",
      user_id: "user-1",
      name: "Sing",
      status: "active",
      is_active: true,
      trigger_type: "tag_added",
      trigger_config: { tag_id: "tag-T" },
    },
  ];
  h.state.steps = [
    {
      id: "step-1",
      automation_id: "auto-1",
      parent_step_id: null,
      branch: null,
      step_type: "send_message",
      position: 0,
      step_config: { text: "hi" },
    },
  ];
  h.state.logInserts = 0;
  h.state.sends = 0;
  vi.clearAllMocks();
});

describe("runAutomationsForTrigger singularity (unchanged behavior)", () => {
  it("one tag_added dispatch creates exactly one log and one send", async () => {
    await runAutomationsForTrigger({
      accountId: "acct-1",
      triggerType: "tag_added",
      contactId: "contact-1",
      context: { tag_id: "tag-T" },
    });
    expect(h.state.logInserts).toBe(1);
    expect(h.state.sends).toBe(1);
  });
});
