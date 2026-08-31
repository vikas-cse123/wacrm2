import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as { table: string; filters: [string, string, unknown][] }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    pendingInserts: [] as { context?: unknown }[],
    contactTagCount: 1 as number | null,
    // Simulated automation_media_rotation counters, keyed
    // `${automation_id}:${contact_id}:${step_key}` — mirrors the claim /
    // release RPC behaviour the real DB provides.
    mediaRotation: new Map<string, number>(),
    mediaRotationReleases: 0,
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === "contacts") {
      if (type === "update") {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === "custom_fields") {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === "contact_custom_values") {
      if (type === "upsert") {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "automations") return { data: state.automations, error: null };
    if (table === "automation_logs") {
      if (type === "insert") return { data: { id: "log1" }, error: null };
      if (type === "update") return { data: null, error: null };
      return { data: { steps_executed: [], status: "success" }, error: null };
    }
    if (table === "automation_steps") return { data: state.steps, error: null };
    if (table === "automation_pending_executions") {
      if (type === "insert") {
        state.pendingInserts.push({ context: (ops.payload as { context?: unknown })?.context });
        return { data: null, error: null };
      }
      if (type === "update") return { data: null, error: null };
      return { data: null, error: null };
    }
    if (table === "contact_tags") {
      // count query for the resume tag guard: `select('id', { count, head })`
      return { count: state.contactTagCount ?? 0, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select",
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      delete: () => ((ops.type = "delete"), b),
      upsert: (p: unknown) => ((ops.type = "upsert"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
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
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: (fn: string, args?: Record<string, unknown>) => {
        if (fn === "claim_automation_media_index") {
          const key = `${args?.p_automation_id}:${args?.p_contact_id}:${args?.p_step_key}`;
          const count = Math.max(Number(args?.p_message_count) || 1, 1);
          const current = state.mediaRotation.get(key) ?? 0;
          const claimed = ((current % count) + count) % count;
          state.mediaRotation.set(key, (current + 1) % count);
          return Promise.resolve({ data: claimed, error: null });
        }
        if (fn === "release_automation_media_index") {
          const key = `${args?.p_automation_id}:${args?.p_contact_id}:${args?.p_step_key}`;
          const count = Math.max(Number(args?.p_message_count) || 1, 1);
          const current = state.mediaRotation.get(key) ?? 0;
          state.mediaRotation.set(key, (((current - 1) % count) + count) % count);
          state.mediaRotationReleases += 1;
          return Promise.resolve({ error: null });
        }
        if (fn === "claim_automation_media_index_global") {
          // Global scope: one shared counter per automation + step_key,
          // with NO contact dimension.
          const key = `${args?.p_automation_id}:shared:${args?.p_step_key}`;
          const count = Math.max(Number(args?.p_message_count) || 1, 1);
          const current = state.mediaRotation.get(key) ?? 0;
          const claimed = ((current % count) + count) % count;
          state.mediaRotation.set(key, (current + 1) % count);
          return Promise.resolve({ data: claimed, error: null });
        }
        if (fn === "release_automation_media_index_global") {
          const key = `${args?.p_automation_id}:shared:${args?.p_step_key}`;
          const count = Math.max(Number(args?.p_message_count) || 1, 1);
          const current = state.mediaRotation.get(key) ?? 0;
          state.mediaRotation.set(key, (((current - 1) % count) + count) % count);
          state.mediaRotationReleases += 1;
          return Promise.resolve({ error: null });
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

vi.mock("../flows/meta-send", () => ({
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "media-1" })),
}));

import { runAutomationsForTrigger, resumePendingExecution } from "./engine";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.mediaRotation = new Map();
  h.state.mediaRotationReleases = 0;
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("automations");
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(["eq", "id", "c1"]);
    expect(filters).toContainEqual(["eq", "account_id", ACCOUNT]);
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: "c1",
      custom_field_id: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(
      (h.state.upsertCalls[0].payload as { value: string }).value,
    ).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe("send_media", () => {
  const engineSendMediaMock = async () =>
    import("../flows/meta-send").then((m) =>
      (m as unknown as { engineSendMedia: ReturnType<typeof vi.fn> }).engineSendMedia,
    )

  it("sends media and logs a success detail", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "send_media",
        position: 0,
        parent_step_id: null,
        step_config: {
          media_type: "document",
          media_url: "https://x.supabase.co/storage/v1/object/public/flow-media/account-acct-1/invoice.pdf",
          caption: "Here is your invoice",
          filename: "invoice.pdf",
        },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    const sendMedia = await engineSendMediaMock();
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      contactId: "c1",
      conversationId: "conv-1",
      kind: "document",
      link: "https://x.supabase.co/storage/v1/object/public/flow-media/account-acct-1/invoice.pdf",
      caption: "Here is your invoice",
      filename: "invoice.pdf",
    });
  });

  it("interpolates {{ vars.* }} into the caption", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "send_media",
        position: 0,
        parent_step_id: null,
        step_config: {
          media_type: "image",
          media_url: "https://x.supabase.co/storage/v1/object/public/flow-media/account-acct-1/img.png",
          caption: "Order {{ vars.order_id }} ready",
        },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1", vars: { order_id: "ORD-7" } },
    });

    const sendMedia = await engineSendMediaMock();
    expect(sendMedia.mock.calls[0][0].caption).toBe("Order ORD-7 ready");
  });
});

describe("send_media rotation", () => {
  const engineSendMediaMock = async () =>
    import("../flows/meta-send").then((m) =>
      (m as unknown as { engineSendMedia: ReturnType<typeof vi.fn> }).engineSendMedia,
    );

  function rotateAutomation() {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      trigger_type: "new_message_received",
      trigger_config: {},
      is_active: true,
    };
  }

  function rotateStep(rotationKey = "rk-1", rotationScope?: string) {
    return {
      id: "s1",
      automation_id: "a1",
      step_type: "send_media",
      position: 0,
      parent_step_id: null,
      step_config: {
        media_type: "image",
        media_url: "",
        selection_mode: "rotate",
        rotation_key: rotationKey,
        ...(rotationScope ? { rotation_scope: rotationScope } : {}),
        messages: [
          {
            media_type: "image",
            media_url: "https://x.example/flow-media/a.png",
            caption: "Message A",
          },
          {
            media_type: "document",
            media_url: "https://x.example/flow-media/b.pdf",
            caption: "Message B",
            filename: "b.pdf",
          },
        ],
      },
    };
  }

  const trigger = (contactId: string) =>
    runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId,
      context: { conversation_id: "conv-1" },
    });

  it("rotates messages sequentially for the same contact (A, B, A)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [rotateAutomation()];
    h.state.steps = [rotateStep()];

    await trigger("c1");
    await trigger("c1");
    await trigger("c1");

    const sendMedia = await engineSendMediaMock();
    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(sendMedia.mock.calls[0][0]).toMatchObject({
      contactId: "c1",
      link: "https://x.example/flow-media/a.png",
      caption: "Message A",
    });
    expect(sendMedia.mock.calls[1][0]).toMatchObject({
      contactId: "c1",
      link: "https://x.example/flow-media/b.pdf",
      caption: "Message B",
      filename: "b.pdf",
    });
    expect(sendMedia.mock.calls[2][0].link).toBe("https://x.example/flow-media/a.png");
  });

  it("keeps rotation independent per contact (contact 2 starts at message 1)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [rotateAutomation()];
    h.state.steps = [rotateStep()];

    await trigger("c1");
    await trigger("c2");

    const sendMedia = await engineSendMediaMock();
    expect(sendMedia.mock.calls[0][0].contactId).toBe("c1");
    expect(sendMedia.mock.calls[0][0].link).toBe("https://x.example/flow-media/a.png");
    expect(sendMedia.mock.calls[1][0].contactId).toBe("c2");
    // NOT B — each contact's rotation starts from its own counter.
    expect(sendMedia.mock.calls[1][0].link).toBe("https://x.example/flow-media/a.png");
  });

  it("global scope rotates ACROSS contacts (c1 → A, c2 → B)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [rotateAutomation()];
    h.state.steps = [rotateStep("rk-1", "global")];

    await trigger("c1");
    await trigger("c2");
    await trigger("c3");

    const sendMedia = await engineSendMediaMock();
    expect(sendMedia.mock.calls.map((c) => c[0].link)).toEqual([
      "https://x.example/flow-media/a.png",
      "https://x.example/flow-media/b.pdf",
      "https://x.example/flow-media/a.png",
    ]);
  });

  it("global scope never touches per-contact rotation state", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [rotateAutomation()];
    h.state.steps = [rotateStep("rk-1", "global")];

    await trigger("c1");
    await trigger("c2");

    // Only the shared counter exists — no per-contact rows were claimed.
    expect([...h.state.mediaRotation.keys()].every((k) => k.includes(":shared:"))).toBe(true);
  });

  it("global scope rolls the shared counter back after a failed send", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [rotateAutomation()];
    h.state.steps = [rotateStep("rk-1", "global")];

    const sendMedia = await engineSendMediaMock();
    sendMedia.mockImplementationOnce(async () => {
      throw new Error("Meta 500");
    });

    await trigger("c1"); // fails — shared index must stay on message 1
    await trigger("c2"); // must retry message 1, not skip to message 2

    expect(sendMedia.mock.calls[0][0].link).toBe("https://x.example/flow-media/a.png");
    expect(sendMedia.mock.calls[1][0].link).toBe("https://x.example/flow-media/a.png");
    expect(h.state.mediaRotationReleases).toBe(1);
  });

  it("rolls the counter back after a failed send (failed message is retried)", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [rotateAutomation()];
    h.state.steps = [rotateStep()];

    const sendMedia = await engineSendMediaMock();
    sendMedia.mockImplementationOnce(async () => {
      throw new Error("Meta 500");
    });

    await trigger("c1"); // fails — index must stay on message 1
    await trigger("c1"); // must retry message 1, not skip to message 2

    expect(sendMedia).toHaveBeenCalledTimes(2);
    expect(sendMedia.mock.calls[0][0].link).toBe("https://x.example/flow-media/a.png");
    expect(sendMedia.mock.calls[1][0].link).toBe("https://x.example/flow-media/a.png");
    expect(h.state.mediaRotationReleases).toBe(1);
  });

  it("keeps two rotate nodes independent via distinct rotation keys", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [rotateAutomation()];
    h.state.steps = [rotateStep("node-a"), { ...rotateStep("node-b"), id: "s2", position: 1 }];

    await trigger("c1");
    await trigger("c1");

    const sendMedia = await engineSendMediaMock();
    // Both nodes claim from their own counter: each run sends A from
    // node-a AND A from node-b (0-indexed claims per key).
    expect(sendMedia.mock.calls.map((c) => c[0].link)).toEqual([
      "https://x.example/flow-media/a.png",
      "https://x.example/flow-media/a.png",
      "https://x.example/flow-media/b.pdf",
      "https://x.example/flow-media/b.pdf",
    ]);
  });

  it("fixed mode never touches rotation state", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [rotateAutomation()];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "send_media",
        position: 0,
        parent_step_id: null,
        step_config: {
          media_type: "image",
          media_url: "https://x.example/flow-media/a.png",
          caption: "Message A",
        },
      },
    ];

    await trigger("c1");
    await trigger("c1");
    await trigger("c1");

    const sendMedia = await engineSendMediaMock();
    expect(sendMedia).toHaveBeenCalledTimes(3);
    for (const call of sendMedia.mock.calls) {
      expect(call[0].link).toBe("https://x.example/flow-media/a.png");
    }
    // No claim / release RPC traffic for fixed mode.
    expect(h.state.mediaRotation.size).toBe(0);
    expect(h.state.mediaRotationReleases).toBe(0);
  });
});

// ------------------------------------------------------------
// Flow → tag_added vars bridge
//
// `dispatchTagAdded` now forwards the Flow run's `vars` into the
// automation context (`context.vars`), so a Tag Added automation can
// resolve `{{vars.Name}}` captured earlier by the Flow's Collect Input.
// These tests drive the same `runAutomationsForTrigger(tag_added, {vars})`
// path that `dispatchTagAdded` invokes.
// ------------------------------------------------------------

describe("flow → tag_added vars bridge", () => {
  function tagAddedAutomation() {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      trigger_type: "tag_added",
      trigger_config: { tag_id: "tag-1" },
      is_active: true,
    };
  }

  function sendMessageStep(text: string) {
    return {
      id: "s1",
      automation_id: "a1",
      step_type: "send_message",
      position: 0,
      parent_step_id: null,
      step_config: { text },
    };
  }

  const engineSendTextMock = async () =>
    import("./meta-send").then((m) =>
      (m as unknown as { engineSendText: ReturnType<typeof vi.fn> }).engineSendText,
    )

  it("TEST 1 — resolves {{vars.Name}} from a Flow's vars into a Tag Added send_message", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [sendMessageStep("Hello {{vars.Name}}")];

    // dispatchTagAdded now passes vars: run.vars from the Flow's set_tag.
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "tag-1", conversation_id: "conv-1", vars: { Name: "Tarun" } },
    });

    const sendText = await engineSendTextMock();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0].text).toBe("Hello Tarun");
  });

  it("TEST 3 — no flow vars: {{vars.Name}} stays empty without error", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [sendMessageStep("Hello {{vars.Name}}")];

    // A direct/manual Tag Added trigger carries no vars (dispatchTagAdded
    // omits `vars` when the caller passes none — backward compatible).
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "tag-1", conversation_id: "conv-1" },
    });

    const sendText = await engineSendTextMock();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0].text).toBe("Hello ");
  });

  it("TEST 4 — no {{vars.*}} in the message: unchanged plain text", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [sendMessageStep("Thanks for reaching out")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "tag-1", conversation_id: "conv-1", vars: { Name: "Tarun" } },
    });

    const sendText = await engineSendTextMock();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0].text).toBe("Thanks for reaching out");
  });

  it("TEST 5 — resolves {{vars.Name}} into a Send Media caption", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "send_media",
        position: 0,
        parent_step_id: null,
        step_config: {
          media_type: "image",
          media_url: "https://x.supabase.co/storage/v1/object/public/flow-media/account-acct-1/img.png",
          caption: "🎉 Great News, {{vars.Name}}",
        },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "tag-1", conversation_id: "conv-1", vars: { Name: "Tarun" } },
    });

    const sendMedia = await (async () =>
      import("../flows/meta-send").then((m) =>
        (m as unknown as { engineSendMedia: ReturnType<typeof vi.fn> }).engineSendMedia,
      ))();
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia.mock.calls[0][0].caption).toBe("🎉 Great News, Tarun");
  });

  it("TEST 2 — vars survive the Wait/Resume scheduler", async () => {
    h.state.owned = { id: "c1" };
    h.state.contactTagCount = 1;
    h.state.automations = [tagAddedAutomation()];
    h.state.steps = [
      { id: "s1", automation_id: "a1", step_type: "wait", position: 0, parent_step_id: null, step_config: { amount: 2, unit: "minutes" } },
      { id: "s2", automation_id: "a1", step_type: "send_message", position: 1, parent_step_id: null, step_config: { text: "Hello {{vars.Name}}" } },
    ];

    // dispatch with vars: the wait step parks `context: args.context` (incl. vars).
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "tag-1", conversation_id: "conv-1", vars: { Name: "Tarun" } },
    });

    // The pending row must carry the vars so the scheduler can restore them.
    expect(h.state.pendingInserts).toHaveLength(1);
    const parked = h.state.pendingInserts[0]!.context as { vars?: Record<string, unknown> };
    expect(parked.vars).toEqual({ Name: "Tarun" });

    // Resume the parked run (cron path) — context restored from pending.context.
    h.state.steps = [h.state.steps[1]!]; // resume fetches steps at position >= 1
    await resumePendingExecution({
      id: "pending-1",
      automation_id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      contact_id: "c1",
      log_id: "log1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: parked,
    });

    const sendText = await (async () =>
      import("./meta-send").then((m) =>
        (m as unknown as { engineSendText: ReturnType<typeof vi.fn> }).engineSendText,
      ))();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0].text).toBe("Hello Tarun");
  });
});
