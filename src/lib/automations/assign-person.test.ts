import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    owned: { id: "contact-1" } as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    logs: [] as Array<{ id: string; payload: Record<string, unknown> }>,
    logUpdates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
    picks: [] as Array<Record<string, unknown>>,
    contactTags: [] as Array<{ contact_id: string; tag_id: string }>,
    tagCountOverride: null as number | null,
    runs: [{ id: "run-1", account_id: "acct-1", contact_id: "contact-1" }] as Array<
      Record<string, unknown>
    >,
    conversations: [{ id: "conv-1" }] as Array<Record<string, unknown>>,
    pendingInserts: [] as Array<Record<string, unknown>>,
    sends: [] as Array<{ text: string }>,
    mediaSends: [] as Array<{ kind: string; link: string; caption?: string }>,
    sendShouldFail: false,
    failLogInsertWithFlowRunIdOnce: false,
    enrichCalls: [] as Array<{ accountId: string; flowRunId: string | null }>,
    logSeq: 0,
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;
  function rowsFor(table: string) {
    if (table === "automation_assignment_picks") return state.picks;
    if (table === "flow_runs") return state.runs;
    if (table === "contact_tags") return state.contactTags;
    if (table === "conversations") return state.conversations;
    return [] as Array<Record<string, unknown>>;
  }
  function builder(table: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    let inFilter: { col: string; vals: unknown[] } | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let pendingPayload: unknown = undefined;
    let pendingType = "select";
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.insert = vi.fn((p: unknown) => {
      pendingType = "insert";
      pendingPayload = p;
      return b;
    });
    b.update = vi.fn((p: unknown) => {
      pendingType = "update";
      pendingPayload = p;
      return b;
    });
    b.delete = vi.fn(() => {
      pendingType = "delete";
      return b;
    });
    b.upsert = vi.fn(async (p: unknown, o?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      if (table === "automation_assignment_picks") {
        const payload = p as Record<string, unknown>;
        const cols = (o?.onConflict ?? "").split(",").map((s) => s.trim());
        const clash = state.picks.find((r) => cols.every((c) => r[c] === payload[c]));
        if (clash) {
          if (o?.ignoreDuplicates) return { data: null, error: null };
          Object.assign(clash, payload);
          return { data: clash, error: null };
        }
        const row = { id: `pick-${state.picks.length + 1}`, created_at: "2026-01-01", ...payload };
        state.picks.push(row);
        return { data: row, error: null };
      }
      if (table === "contact_tags") {
        const payload = p as { contact_id: string; tag_id: string };
        const clash = state.contactTags.find(
          (r) => r.contact_id === payload.contact_id && r.tag_id === payload.tag_id,
        );
        if (clash) {
          if (o?.ignoreDuplicates) return { data: null, error: null };
          return { data: clash, error: null };
        }
        state.contactTags.push({ ...payload });
        return { data: payload, error: null };
      }
      return { data: null, error: null };
    });
    b.eq = vi.fn((col: string, val: unknown) => {
      filters.push({ col, val });
      return b;
    });
    b.gte = vi.fn((col: string, val: unknown) => {
      filters.push({ col: `gte:${col}`, val });
      return b;
    });
    b.is = vi.fn(() => b);
    b.order = vi.fn((col: string, o?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = o?.ascending ?? true;
      return b;
    });
    b.limit = vi.fn((n: number) => {
      limitN = n;
      return b;
    });
    b.in = vi.fn((col: string, vals: unknown[]) => {
      inFilter = { col, vals };
      return b;
    });
    const apply = () => {
      if (table === "contacts") return state.owned ? [state.owned] : [];
      // Emulate the engine's hot-path filter (account+trigger+active) —
      // otherwise tag fan-out would falsely re-run every automation.
      if (table === "automations") {
        return state.automations.filter((a) =>
          filters.every((f) => {
            if (f.col.startsWith("gte:")) return Number(a[f.col.slice(4)]) >= Number(f.val);
            return (a as Record<string, unknown>)[f.col] === f.val;
          }),
        );
      }
      if (table === "automation_steps") {
        return state.steps.filter((s) =>
          filters.every((f) => {
            if (f.col.startsWith("gte:")) return Number((s as Record<string, unknown>)[f.col.slice(4)]) >= Number(f.val);
            return (s as Record<string, unknown>)[f.col] === f.val;
          }),
        );
      }
      let rows: Array<Record<string, unknown>> = [...rowsFor(table)] as Array<
        Record<string, unknown>
      >;
      for (const f of filters) rows = rows.filter((r) => r[f.col] === f.val);
      if (inFilter) {
        const col = inFilter.col;
        const vals = inFilter.vals as unknown[];
        rows = rows.filter((r) => vals.includes(r[col]));
      }
      if (orderCol) {
        const col: string = orderCol;
        rows = [...rows].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return orderAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : av < bv ? 1 : av > bv ? -1 : 0;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    };
    b.single = vi.fn(async () => {
      if (table === "automation_logs" && pendingType === "insert") {
        // Pre-069 DB emulation: first insert carrying flow_run_id fails
        // with a missing-column error; the engine must retry legacy.
        if (
          state.failLogInsertWithFlowRunIdOnce &&
          (pendingPayload as Record<string, unknown>)?.flow_run_id !== undefined
        ) {
          state.failLogInsertWithFlowRunIdOnce = false;
          return {
            data: null,
            error: { message: "Could not find the 'flow_run_id' column of 'automation_logs'" },
          };
        }
        state.logSeq += 1;
        const id = `log-${state.logSeq}`;
        state.logs.push({ id, payload: pendingPayload as Record<string, unknown> });
        return { data: { id }, error: null };
      }
      if (table === "automation_logs" && pendingType === "select") {
        return { data: { steps_executed: [], status: "success" }, error: null };
      }
      if (table === "automations" && pendingType === "select") {
        return { data: state.automations[0] ?? null, error: null };
      }
      const rows = apply();
      return { data: rows[0] ?? null, error: null };
    });
    b.maybeSingle = vi.fn(async () => {
      if (table === "automation_logs" && pendingType === "insert") {
        state.logSeq += 1;
        const id = `log-${state.logSeq}`;
        state.logs.push({ id, payload: pendingPayload as Record<string, unknown> });
        return { data: { id }, error: null };
      }
      if (table === "contact_tags" && pendingType === "select") {
        const rows = apply();
        // count query shape: { count } — emulate via rows length unless overridden
        const count = state.tagCountOverride ?? rows.length;
        return { data: rows[0] ?? null, count, error: null };
      }
      if (table === "automation_assignment_picks" && pendingType === "select") {
        const rows = apply();
        return { data: rows[0] ?? null, error: null };
      }
      const rows = apply();
      return { data: rows[0] ?? null, error: null };
    });
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (pendingType === "insert") {
        if (table === "automation_logs") {
          state.logSeq += 1;
          const id = `log-${state.logSeq}`;
          state.logs.push({ id, payload: pendingPayload as Record<string, unknown> });
          return Promise.resolve({ data: { id }, error: null }).then(resolve);
        }
        if (table === "automation_pending_executions") {
          state.pendingInserts.push(pendingPayload as Record<string, unknown>);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        if (table === "contact_tags") {
          const payload = pendingPayload as { contact_id: string; tag_id: string };
          if (!state.contactTags.find((r) => r.contact_id === payload.contact_id && r.tag_id === payload.tag_id)) {
            state.contactTags.push({ ...payload });
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      if (pendingType === "update") {
        if (table === "automation_logs") {
          const id = filters.find((f) => f.col === "id")?.val as string;
          state.logUpdates.push({ id, payload: pendingPayload as Record<string, unknown> });
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      if (pendingType === "delete") {
        if (table === "contact_tags") {
          state.contactTags = state.contactTags.filter(
            (r) => !filters.every((f) => (r as Record<string, unknown>)[f.col] === f.val),
          );
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      return Promise.resolve({ data: apply(), error: null }).then(resolve);
    };
    return b;
  }
  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: async () => ({ error: null }),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async (args: { text: string }) => {
    if (h.state.sendShouldFail) throw new Error("meta rejected");
    h.state.sends.push({ text: args.text });
    return { whatsapp_message_id: `wamid-${h.state.sends.length}` };
  }),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "t1" })),
}));

vi.mock("../flows/meta-send", () => ({
  engineSendMedia: vi.fn(async (args: { kind: string; link: string; caption?: string }) => {
    if (h.state.sendShouldFail) throw new Error("meta rejected");
    h.state.mediaSends.push({ kind: args.kind, link: args.link, caption: args.caption });
    return { whatsapp_message_id: `wamid-media-${h.state.mediaSends.length}` };
  }),
}));

vi.mock("@/lib/sheets/assign-enrich", () => ({
  enrichAssignmentSheets: vi.fn(async (accountId: string, flowRunId: string | null) => {
    h.state.enrichCalls.push({ accountId, flowRunId });
  }),
}));

import { runAutomationsForTrigger, resumePendingExecution } from "./engine";
import { engineSendText } from "./meta-send";
import { enrichAssignmentSheets } from "@/lib/sheets/assign-enrich";

const ACCOUNT = "acct-1";
const PERSONS = [
  { name: "Rahul", percentage: 50, message: "Hi, I'm Rahul...", tag_id: "tag-rahul" },
  { name: "Priya", percentage: 25, message: "Hi, I'm Priya...", tag_id: "tag-priya" },
  { name: "Aman", percentage: 25, message: "Hi, I'm Aman...", tag_id: "tag-aman" },
];

function automation(id = "auto-A", trigger: Record<string, unknown> = {}, triggerType = "new_message_received") {
  return {
    id,
    account_id: ACCOUNT,
    user_id: "user-1",
    name: "A",
    trigger_type: triggerType,
    trigger_config: trigger,
    is_active: true,
  };
}

function assignStep() {
  return {
    id: "step-1",
    automation_id: "auto-A",
    parent_step_id: null,
    branch: null,
    step_type: "assign_person",
    step_config: { assignment_key: "assign-1", persons: PERSONS },
    position: 0,
  };
}

beforeEach(() => {
  h.state.owned = { id: "contact-1" };
  h.state.automations = [];
  h.state.steps = [];
  h.state.logs = [];
  h.state.logUpdates = [];
  h.state.picks = [];
  h.state.contactTags = [];
  h.state.tagCountOverride = null;
  h.state.runs = [{ id: "run-1", account_id: "acct-1", contact_id: "contact-1" }];
  h.state.conversations = [{ id: "conv-1" }];
  h.state.pendingInserts = [];
  h.state.sends = [];
  h.state.mediaSends = [];
  h.state.sendShouldFail = false;
  h.state.failLogInsertWithFlowRunIdOnce = false;
  h.state.enrichCalls = [];
  h.state.logSeq = 0;
  vi.clearAllMocks();
});

describe("assign_person step", () => {
  it("selects one person, persists pick with flow_run, sends their message, tags after success", async () => {
    h.state.automations = [automation()];
    h.state.steps = [assignStep()];
    // Force Rahul (rand 0.1 → first bucket).
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
      flowRunId: "run-1",
    });
    (Math.random as unknown as { mockRestore: () => void }).mockRestore?.();

    expect(h.state.picks).toHaveLength(1);
    const pick = h.state.picks[0]!;
    expect(pick.person_name).toBe("Rahul");
    expect(pick.flow_run_id).toBe("run-1");
    expect(pick.log_id).toBe("log-1");
    expect(pick.step_key).toBe("assign-1");
    expect(pick.message).toBe("Hi, I'm Rahul...");
    expect(pick.tag_id).toBe("tag-rahul");
    // Log carries the exact run.
    expect(h.state.logs[0]!.payload.flow_run_id).toBe("run-1");
    // Their message was sent via existing infra.
    expect(h.state.sends).toHaveLength(1);
    expect(h.state.sends[0]!.text).toBe("Hi, I'm Rahul...");
    // Tag added only after success.
    expect(h.state.contactTags).toEqual([{ contact_id: "contact-1", tag_id: "tag-rahul" }]);
    // Sheets enrichment keyed by exact run (NULL-safe).
    expect(h.state.enrichCalls).toEqual([{ accountId: ACCOUNT, flowRunId: "run-1" }]);
    expect(engineSendText).toHaveBeenCalledTimes(1);
  });

  it("sends image + caption via the existing media path for image persons, then tags", async () => {
    const IMG_PERSONS = [
      {
        name: "Rahul",
        percentage: 100,
        message_type: "image",
        message: "Hi, I'm Rahul...",
        media_url: "https://cdn.example/r.jpg",
        tag_id: "tag-rahul",
      },
    ];
    h.state.automations = [automation()];
    h.state.steps = [
      {
        ...assignStep(),
        step_config: { assignment_key: "assign-1", persons: IMG_PERSONS },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
      flowRunId: "run-1",
    });

    expect(h.state.picks).toHaveLength(1);
    expect(h.state.picks[0]!.message_type).toBe("image");
    expect(h.state.picks[0]!.media_url).toBe("https://cdn.example/r.jpg");
    // Image path used (not text), caption = person's message.
    expect(h.state.mediaSends).toHaveLength(1);
    expect(h.state.mediaSends[0]).toEqual({
      kind: "image",
      link: "https://cdn.example/r.jpg",
      caption: "Hi, I'm Rahul...",
    });
    expect(h.state.sends).toHaveLength(0);
    // Tag added only after the media send succeeded.
    expect(h.state.contactTags).toEqual([{ contact_id: "contact-1", tag_id: "tag-rahul" }]);
  });

  it("adds no tag when the image send fails", async () => {
    const IMG_PERSONS = [
      {
        name: "Rahul",
        percentage: 100,
        message_type: "image",
        message: "Hi, I'm Rahul...",
        media_url: "https://cdn.example/r.jpg",
        tag_id: "tag-rahul",
      },
    ];
    h.state.automations = [automation()];
    h.state.steps = [
      {
        ...assignStep(),
        step_config: { assignment_key: "assign-1", persons: IMG_PERSONS },
      },
    ];
    h.state.sendShouldFail = true;

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
      flowRunId: "run-1",
    });

    expect(h.state.picks).toHaveLength(1);
    expect(h.state.contactTags).toHaveLength(0);
  });

  it("still runs on a pre-069 DB by retrying the log insert without flow_run_id", async () => {
    h.state.automations = [automation()];
    h.state.steps = [assignStep()];
    h.state.failLogInsertWithFlowRunIdOnce = true;
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
      flowRunId: "run-1",
    });
    (Math.random as unknown as { mockRestore: () => void }).mockRestore?.();

    // Legacy log row created (no flow_run_id column); execution continued.
    expect(h.state.logs).toHaveLength(1);
    expect("flow_run_id" in h.state.logs[0]!.payload).toBe(false);
    expect(h.state.sends).toHaveLength(1);
    expect(h.state.contactTags).toHaveLength(1);
  });

  it("keeps the pick but adds no tag when the send fails", async () => {
    h.state.automations = [automation()];
    h.state.steps = [assignStep()];
    h.state.sendShouldFail = true;
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
      flowRunId: "run-1",
    });
    (Math.random as unknown as { mockRestore: () => void }).mockRestore?.();

    expect(h.state.picks).toHaveLength(1);
    expect(h.state.picks[0]!.person_name).toBe("Rahul");
    expect(h.state.contactTags).toHaveLength(0);
    // Step marked failed per existing failure behavior.
    const lastUpdate = h.state.logUpdates[h.state.logUpdates.length - 1]!;
    expect(lastUpdate.payload.status).toBe("failed");
  });

  it("does not insert or dispatch when the contact already has the tag", async () => {
    h.state.automations = [automation()];
    h.state.steps = [assignStep()];
    h.state.contactTags = [{ contact_id: "contact-1", tag_id: "tag-rahul" }];
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
      flowRunId: "run-1",
    });
    (Math.random as unknown as { mockRestore: () => void }).mockRestore?.();

    // No duplicate row, message still sent (pick exists).
    expect(h.state.contactTags).toHaveLength(1);
    expect(h.state.sends).toHaveLength(1);
  });

  it("never dispatches the automation's own trigger tag (self-loop guard)", async () => {
    h.state.automations = [
      automation("auto-A", { tag_id: "tag-rahul" }, "tag_added"),
    ];
    h.state.steps = [assignStep()];
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "contact-1",
      context: { conversation_id: "conv-1", tag_id: "tag-rahul" },
      flowRunId: "run-1",
    });
    (Math.random as unknown as { mockRestore: () => void }).mockRestore?.();
    // Flush fire-and-forget chains.
    await new Promise((r) => setTimeout(r, 10));

    // Tag row created once; no recursive second send.
    expect(h.state.contactTags).toHaveLength(1);
    expect(h.state.sends).toHaveLength(1);
  });

  it("falls back to independent mode when flow_run is foreign (no sheet guess)", async () => {
    h.state.automations = [automation()];
    h.state.steps = [assignStep()];
    h.state.runs = [{ id: "run-1", account_id: "acct-1", contact_id: "other-contact" }];
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
      flowRunId: "run-1",
    });
    (Math.random as unknown as { mockRestore: () => void }).mockRestore?.();

    expect(h.state.picks).toHaveLength(1);
    expect(h.state.picks[0]!.flow_run_id).toBeNull();
    expect(h.state.sends).toHaveLength(1);
    expect(h.state.contactTags).toHaveLength(1);
    expect(h.state.enrichCalls).toEqual([{ accountId: ACCOUNT, flowRunId: null }]);
    expect(enrichAssignmentSheets).toHaveBeenCalled();
  });

  it("resume after wait reuses the stored pick and flow_run", async () => {
    h.state.automations = [automation()];
    // Resume loads steps >= next_step_position (position filter
    // emulated above), so only the assign step is visible here.
    h.state.steps = [{ ...assignStep(), position: 1 }];
    // Pre-seed the pick as if the first attempt drew Rahul before waiting.
    h.state.picks = [
      {
        id: "pick-1",
        automation_id: "auto-A",
        account_id: ACCOUNT,
        contact_id: "contact-1",
        flow_run_id: "run-1",
        log_id: "log-9",
        step_key: "assign-1",
        person_name: "Rahul",
        person_index: 0,
        percentage: 50,
        message: "Hi, I'm Rahul...",
        tag_id: "tag-rahul",
        created_at: "2026-01-01",
      },
    ];
    // Resume must reuse Rahul even though rand now points at Aman.
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    await resumePendingExecution({
      id: "pend-1",
      automation_id: "auto-A",
      user_id: "user-1",
      account_id: ACCOUNT,
      contact_id: "contact-1",
      log_id: "log-9",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
      context: { conversation_id: "conv-1", flow_run_id: "run-1" },
      flow_run_id: "run-1",
    });
    (Math.random as unknown as { mockRestore: () => void }).mockRestore?.();

    expect(h.state.picks).toHaveLength(1);
    expect(h.state.sends).toHaveLength(1);
    expect(h.state.sends[0]!.text).toBe("Hi, I'm Rahul...");
  });
});
