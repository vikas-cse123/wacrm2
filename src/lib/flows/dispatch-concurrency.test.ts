// ============================================================
// dispatchInboundToFlows serialization regression tests.
//
// Production incident: two Meta deliveries seconds apart (different
// message ids — redelivery or double-tap) were both processed as full
// advances of the same suspended run, executing every side effect twice
// (notably set_tag automation dispatches → duplicate automation runs).
//
// These tests drive the REAL dispatchInboundToFlows (real advance loop,
// real idempotency checks) against a stateful in-memory Supabase double
// that faithfully emulates conditional updates and the lock table, with
// real timers so waiter/winner interleavings are genuine. Meta sends and
// automation dispatch are spies (assert side-effect counts, the thing
// that duplicated in production).
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  interface Row {
    [k: string]: unknown;
  }
  const state = {
    contacts: {} as Record<string, Row>,
    flows: {} as Record<string, Row>,
    nodes: {} as Record<string, Row[]>,
    runs: {} as Record<string, Row>,
    events: [] as Row[],
    messages: [] as Row[],
    locks: new Map<string, { owner: string; locked_at: string }>(),
    runSeq: 0,
    tagUpserts: [] as unknown[],
    dispatches: [] as { accountId: string; contactId: string; tagId: string }[],
    lockConflicts: [] as string[],
    sends: { text: [] as unknown[], buttons: [] as unknown[] },
  };

  function matchFilters(rows: Row[], filters: [string, string, unknown][]) {
    return rows.filter((r) =>
      filters.every(([op, col, val]) => {
        if (col.includes(".")) return true;
        if (op === "eq") return r[col] === val;
        if (op === "in") return (val as unknown[]).includes(r[col]);
        if (op === "is") return val === null ? r[col] == null : r[col] === val;
        if (op === "not") return true;
        return true;
      }),
    );
  }

  function builder(table: string) {
    const ops = {
      type: "select" as string,
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
      orderBy: null as { col: string; asc: boolean } | null,
      limitN: null as number | null,
      selectCols: null as string | null,
      countHead: false,
    };
    const b: Record<string, unknown> = {
      select: (cols?: string, opts?: { count?: string }) => {
        if (typeof cols === "string") ops.selectCols = cols;
        if (opts?.count === "exact") ops.countHead = true;
        return b;
      },
      insert: (p: unknown) => {
        ops.type = "insert";
        ops.payload = p;
        return b;
      },
      update: (p: unknown) => {
        ops.type = "update";
        ops.payload = p;
        return b;
      },
      upsert: (p: unknown) => {
        ops.type = "upsert";
        ops.payload = p;
        return b;
      },
      delete: () => {
        ops.type = "delete";
        return b;
      },
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(["in", k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(["is", k, v]), b),
      gte: () => b,
      lt: () => b,
      lte: () => b,
      not: (k: string, v: unknown) => (ops.filters.push(["not", k, v]), b),
      filter: (k: string, o: string, v: unknown) => (ops.filters.push(["filter", `${k}|${o}`, v]), b),
      order: (col: string, o?: { ascending?: boolean }) => {
        ops.orderBy = { col, asc: o?.ascending !== false };
        return b;
      },
      limit: (n: number) => {
        ops.limitN = n;
        return b;
      },
    };

    const tableRows = (): Row[] => {
      switch (table) {
        case "contacts":
          return Object.values(state.contacts);
        case "flows":
          return Object.values(state.flows);
        case "flow_nodes":
          return Object.values(state.nodes).flat();
        case "flow_runs":
          return Object.values(state.runs);
        case "flow_run_events":
          return state.events;
        case "messages":
          return state.messages;
        case "flow_advance_locks":
          return [...state.locks.entries()].map(([k, v]) => {
            const [account_id, contact_id] = k.split("|");
            return { account_id, contact_id, ...v };
          });
        default:
          return [];
      }
    };

    const resolve = () => {
      // --- flow_advance_locks: real PK semantics (the lock under test) ---
      if (table === "flow_advance_locks") {
        if (ops.type === "insert") {
          const p = ops.payload as Row;
          const k = `${p.account_id}|${p.contact_id}`;
          if (state.locks.has(k)) {
            // A genuine contention event: someone tried to acquire while
            // held. Counted so tests can prove waiting actually happened
            // (rather than both calls merely running sequentially).
            state.lockConflicts.push(k);
            return {
              error: {
                code: "23505",
                message: 'duplicate key value violates unique constraint "flow_advance_locks_pkey" (23505)',
              },
            };
          }
          state.locks.set(k, {
            owner: p.owner as string,
            locked_at: new Date().toISOString(),
          });
          return { error: null };
        }
        if (ops.type === "delete") {
          for (const [k, v] of [...state.locks.entries()]) {
            const row = { account_id: k.split("|")[0], contact_id: k.split("|")[1], ...v };
            if (matchFilters([row], ops.filters).length > 0) state.locks.delete(k);
          }
          return { error: null };
        }
        const rows = matchFilters(tableRows(), ops.filters);
        return { data: rows[0] ?? null, error: null };
      }
      if (table === "contacts") {
        const rows = matchFilters(tableRows(), ops.filters);
        return { data: rows[0] ?? null, error: null };
      }
      if (table === "flows") {
        return { data: matchFilters(tableRows(), ops.filters), error: null };
      }
      if (table === "flow_nodes") {
        // Real rows always carry flow_id; fixtures omit it for brevity —
        // stamp from the query's own eq filter (explicit values win).
        const fid = ops.filters.find(([op, c]) => op === "eq" && c === "flow_id")?.[2];
        const rows = Object.values(state.nodes)
          .flat()
          .map((r) => ({ flow_id: fid, ...r }));
        return { data: matchFilters(rows, ops.filters), error: null };
      }
      if (table === "flow_runs") {
        if (ops.type === "insert") {
          const p = ops.payload as Row;
          const clash = Object.values(state.runs).some(
            (r) =>
              r.status === "active" &&
              r.account_id === p.account_id &&
              r.contact_id === p.contact_id,
          );
          if (clash) {
            return {
              error: {
                message:
                  'duplicate key value violates unique constraint "idx_one_active_run_per_contact" (23505)',
              },
            };
          }
          const id = `run-${++state.runSeq}`;
          const row = { id, ...p };
          state.runs[id] = row;
          return { data: row, error: null };
        }
        if (ops.type === "update") {
          const matched = matchFilters(tableRows(), ops.filters);
          for (const m of matched) Object.assign(m, ops.payload);
          if (ops.selectCols) return { data: matched, error: null };
          return { data: null, error: null };
        }
        let rows = matchFilters(tableRows(), ops.filters);
        if (ops.orderBy) {
          const { col, asc } = ops.orderBy;
          rows = [...rows].sort((a, b) => {
            const x = String(a[col] ?? "");
            const y = String(b[col] ?? "");
            return asc ? (x < y ? -1 : 1) : x > y ? -1 : 1;
          });
        }
        if (ops.limitN != null) rows = rows.slice(0, ops.limitN);
        return { data: rows, error: null };
      }
      if (table === "flow_run_events") {
        if (ops.type === "insert") {
          const payloads = Array.isArray(ops.payload) ? ops.payload : [ops.payload];
          for (const p of payloads as Row[]) {
            state.events.push({ ...p, created_at: new Date().toISOString() });
          }
          return { data: null, error: null };
        }
        let rows = [...state.events];
        for (const [op, col, val] of ops.filters) {
          if (op === "in" && col === "flow_run_id") {
            rows = rows.filter((r) => (val as unknown[]).includes(r.flow_run_id));
          } else if (op === "eq") {
            rows = rows.filter((r) => r[col] === val);
          } else if (op === "filter" && typeof col === "string" && col.startsWith("payload->>")) {
            // Encoded as `${col}|${op}` by the builder above.
            const k = col.slice("payload->>".length).split("|")[0];
            rows = rows.filter(
              (r) => ((r.payload as Row) ?? {})[k as string] === val,
            );
          }
        }
        if (ops.countHead) return { count: rows.length, error: null };
        return { data: rows, error: null };
      }
      if (table === "messages") {
        return { data: matchFilters(tableRows(), ops.filters)[0] ?? null, error: null };
      }
      if (table === "contact_tags") {
        if (ops.type === "upsert") {
          state.tagUpserts.push(ops.payload);
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };

    b.single = () => Promise.resolve(resolve());
    b.maybeSingle = () => Promise.resolve(resolve());
    b.then = (onF: (v: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF);
    return b;
  }

  return { state, builder };
});

vi.mock("./admin-client", () => ({
  supabaseAdmin: () => ({
    from: (t: string) => h.builder(t),
    rpc: () => Promise.resolve({ error: null }),
  }),
}));

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async (a: { text: string }) => {
    h.state.sends.text.push(a.text);
    return { whatsapp_message_id: `wamid-text-${h.state.sends.text.length}` };
  }),
  engineSendInteractiveButtons: vi.fn(async () => {
    h.state.sends.buttons.push(true);
    return { whatsapp_message_id: `wamid-btn-${h.state.sends.buttons.length}` };
  }),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: "wamid-list-1",
  })),
  engineSendCtaUrl: vi.fn(async () => ({ whatsapp_message_id: "wamid-cta-1" })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid-media-1" })),
}));

vi.mock("./webhook-dispatch", () => ({
  dispatchNodeWebhook: vi.fn(),
}));

vi.mock("@/lib/automations/engine", () => ({
  dispatchTagAdded: vi.fn(
    (accountId: string, contactId: string, tagId: string) => {
      h.state.dispatches.push({ accountId, contactId, tagId });
    },
  ),
}));

import { dispatchInboundToFlows } from "./engine";
import { dispatchTagAdded } from "@/lib/automations/engine";

const ACCT = "acct-1";
const CONTACT = "contact-1";
const CONV = "conv-1";
const USER = "user-1";

function seedTapFlow() {
  h.state.flows["flow-1"] = {
    id: "flow-1",
    account_id: ACCT,
    user_id: USER,
    name: "Tap",
    status: "active",
    trigger_type: "keyword",
    trigger_config: { keywords: ["zzz"] },
    entry_node_id: "start",
    fallback_policy: { on_unknown_reply: "ignore", max_reprompts: 0 },
  };
  h.state.nodes["flow-1"] = [
    { node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
    {
      node_key: "menu",
      node_type: "send_buttons",
      config: {
        text: "Pick",
        buttons: [
          { reply_id: "yes", title: "Yes", next_node_key: "tagged" },
          { reply_id: "no", title: "No", next_node_key: "other" },
        ],
      },
    },
    {
      node_key: "tagged",
      node_type: "set_tag",
      config: { mode: "add", tag_id: "tag-T", next_node_key: "end" },
    },
    {
      node_key: "other",
      node_type: "set_tag",
      config: { mode: "add", tag_id: "tag-T2", next_node_key: "end" },
    },
    { node_key: "end", node_type: "end", config: {} },
  ];
  h.state.contacts[CONTACT] = { id: CONTACT, account_id: ACCT };
}

function seedRun(nodeKey: string, vars: Record<string, unknown> = {}) {
  h.state.runs["run-1"] = {
    id: "run-1",
    flow_id: "flow-1",
    account_id: ACCT,
    user_id: USER,
    contact_id: CONTACT,
    conversation_id: CONV,
    status: "active",
    current_node_key: nodeKey,
    vars,
    reprompt_count: 0,
    started_at: "2026-01-01T00:00:00.000Z",
    last_advanced_at: "2026-01-01T00:00:00.000Z",
  };
}

function tapInput(replyId: string, meta: string, title = "Yes") {
  return {
    accountId: ACCT,
    userId: USER,
    contactId: CONTACT,
    conversationId: CONV,
    message: {
      kind: "interactive_reply" as const,
      reply_id: replyId,
      reply_title: title,
      meta_message_id: meta,
    },
    isFirstInboundMessage: false,
  };
}

beforeEach(() => {
  h.state.contacts = {};
  h.state.flows = {};
  h.state.nodes = {};
  h.state.runs = {};
  h.state.events = [];
  h.state.messages = [];
  h.state.locks = new Map();
  h.state.runSeq = 0;
  h.state.tagUpserts = [];
  h.state.dispatches = [];
  h.state.lockConflicts = [];
  h.state.sends = { text: [], buttons: [] };
  vi.clearAllMocks();
});

describe("concurrent duplicate tap (production Pooja shape)", () => {
  it("advances once: one set_tag, one dispatch, loser sees completion", async () => {
    seedTapFlow();
    seedRun("menu");

    const [a, b] = await Promise.all([
      dispatchInboundToFlows(tapInput("yes", "meta-A")),
      dispatchInboundToFlows(tapInput("yes", "meta-B")),
    ]);
    expect(h.state.tagUpserts).toHaveLength(1);
    // The engine records the tapped choice into vars (pre-existing
    // behavior feeding sheet columns), so the dispatch carries it.
    expect(dispatchTagAdded).toHaveBeenCalledTimes(1);
    expect(dispatchTagAdded).toHaveBeenCalledWith(ACCT, CONTACT, "tag-T", CONV, {
      menu: "Yes",
    });
    // Exactly one branch completed the run; the loser found nothing to advance.
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["completed", "no_match"]);
    expect(h.state.runs["run-1"]?.status).toBe("completed");
    // No second run was started behind the first.
    expect(Object.keys(h.state.runs)).toHaveLength(1);
    // The loser genuinely contended (did not just run sequentially after
    // release): its first acquire attempt hit the winner's live row.
    expect(h.state.lockConflicts.length).toBeGreaterThanOrEqual(1);
    // No lock rows leak afterwards.
    expect(h.state.locks.size).toBe(0);
  });
});

describe("lock wait budget exceeded", () => {
  it("maps to advance_busy_skipped with zero side effects", async () => {
    vi.useFakeTimers();
    try {
      seedTapFlow();
      seedRun("menu");
      // Pre-hold the lock with a fresh timestamp so every acquire attempt
      // conflicts until the waiter budget expires.
      h.state.locks.set(`${ACCT}|${CONTACT}`, {
        owner: "other-worker",
        locked_at: new Date().toISOString(),
      });
      const pending = dispatchInboundToFlows(tapInput("yes", "meta-busy"));
      await vi.advanceTimersByTimeAsync(9_000);
      const res = await pending;
      expect(res).toEqual({ consumed: true, outcome: "advance_busy_skipped" });
      expect(h.state.tagUpserts).toHaveLength(0);
      expect(dispatchTagAdded).not.toHaveBeenCalled();
      // The foreign row is untouched (we never own it).
      expect(h.state.locks.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("concurrent different taps", () => {
  it("serializes: winner completes, loser is evaluated against fresh state", async () => {
    seedTapFlow();
    seedRun("menu");

    const [a, b] = await Promise.all([
      dispatchInboundToFlows(tapInput("yes", "meta-A")),
      dispatchInboundToFlows(tapInput("no", "meta-B", "No")),
    ]);

    // Only the winner's tag fired; the loser never advanced anything.
    expect(h.state.tagUpserts).toHaveLength(1);
    expect(dispatchTagAdded).toHaveBeenCalledTimes(1);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["completed", "no_match"]);
    expect(Object.keys(h.state.runs)).toHaveLength(1);
  });
});

describe("rapid text replies (no duplicate prompt chain)", () => {
  it("captures each text once, in order, with single sends", async () => {
    h.state.flows["flow-2"] = {
      id: "flow-2",
      account_id: ACCT,
      user_id: USER,
      name: "Q",
      status: "active",
      trigger_type: "keyword",
      trigger_config: { keywords: ["zzz"] },
      entry_node_id: "start",
      fallback_policy: { on_unknown_reply: "ignore", max_reprompts: 0 },
    };
    h.state.nodes["flow-2"] = [
      { node_key: "start", node_type: "start", config: { next_node_key: "q1" } },
      {
        node_key: "q1",
        node_type: "collect_input",
        config: { var_key: "a", prompt_text: "Q1?", next_node_key: "q2" },
      },
      {
        node_key: "q2",
        node_type: "collect_input",
        config: { var_key: "b", prompt_text: "Q2?", next_node_key: "end" },
      },
      { node_key: "end", node_type: "end", config: {} },
    ];
    h.state.contacts[CONTACT] = { id: CONTACT, account_id: ACCT };
    h.state.runs["run-2"] = {
      id: "run-2",
      flow_id: "flow-2",
      account_id: ACCT,
      user_id: USER,
      contact_id: CONTACT,
      conversation_id: CONV,
      status: "active",
      current_node_key: "q1",
      vars: {},
      reprompt_count: 0,
      started_at: "2026-01-01T00:00:00.000Z",
      last_advanced_at: "2026-01-01T00:00:00.000Z",
    };

    const text = (t: string, m: string) => ({
      accountId: ACCT,
      userId: USER,
      contactId: CONTACT,
      conversationId: CONV,
      message: { kind: "text" as const, text: t, meta_message_id: m },
      isFirstInboundMessage: false,
    });
    const [a, b] = await Promise.all([
      dispatchInboundToFlows(text("text1", "m-1")),
      dispatchInboundToFlows(text("text2", "m-2")),
    ]);

    // Q2's prompt went out exactly once (no duplicate prompt chain).
    expect(h.state.sends.text).toEqual(["Q2?"]);
    expect((h.state.runs["run-2"]?.vars as Record<string, unknown>)).toEqual({
      a: "text1",
      b: "text2",
    });
    expect(h.state.runs["run-2"]?.status).toBe("completed");
    expect([a.outcome, b.outcome].sort()).toEqual(["advanced", "completed"]);
  });
});

describe("Meta message-id idempotency (unchanged)", () => {
  it("ignores a redelivered message id", async () => {
    seedTapFlow();
    seedRun("menu");
    // Retarget yes -> q1x (collect) so the first advance suspends instead
    // of completing: the redelivery must hit the duplicate path, not the
    // no-run path.
    h.state.nodes["flow-1"].push({
      node_key: "q1x",
      node_type: "collect_input",
      config: { var_key: "a", prompt_text: "Q?", next_node_key: "end" },
    });
    const menu = h.state.nodes["flow-1"].find((n) => (n as Record<string, unknown>).node_key === "menu") as Record<string, unknown>;
    (menu.config as Record<string, unknown[]>).buttons = [
      { reply_id: "yes", title: "Yes", next_node_key: "q1x" },
    ] as unknown[];

    const first = await dispatchInboundToFlows(tapInput("yes", "meta-same"));
    expect(first.outcome).toBe("advanced");
    const sendsAfterFirst = h.state.sends.text.length;
    const second = await dispatchInboundToFlows(tapInput("yes", "meta-same"));
    expect(second).toEqual({
      consumed: true,
      flow_run_id: "run-1",
      outcome: "duplicate_inbound_ignored",
    });
    // No further sends from the redelivery.
    expect(h.state.sends.text.length).toBe(sendsAfterFirst);
  });
});

describe("cycle termination (unchanged)", () => {
  it("still terminates via the advance-loop safety cap", async () => {
    h.state.flows["flow-3"] = {
      id: "flow-3",
      account_id: ACCT,
      user_id: USER,
      name: "Loop",
      status: "active",
      trigger_type: "keyword",
      trigger_config: { keywords: ["zzz"] },
      entry_node_id: "start",
      fallback_policy: { on_unknown_reply: "ignore", max_reprompts: 0 },
    };
    h.state.nodes["flow-3"] = [
      { node_key: "start", node_type: "start", config: { next_node_key: "m1" } },
      { node_key: "m1", node_type: "send_message", config: { text: "x", next_node_key: "m2" } },
      { node_key: "m2", node_type: "send_message", config: { text: "y", next_node_key: "m1" } },
    ];
    h.state.contacts[CONTACT] = { id: CONTACT, account_id: ACCT };
    h.state.runs["run-3"] = {
      id: "run-3",
      flow_id: "flow-3",
      account_id: ACCT,
      user_id: USER,
      contact_id: CONTACT,
      conversation_id: CONV,
      status: "active",
      current_node_key: "m1",
      vars: {},
      reprompt_count: 0,
      started_at: "2026-01-01T00:00:00.000Z",
      last_advanced_at: "2026-01-01T00:00:00.000Z",
    };
    // Drive the loop directly through a text reply at a collect node is
    // impossible here (no collect in the cycle), so seed at m1 and send a
    // text that falls to fallback... instead start a fresh run is also
    // wrong. Simplest deadlock-free driver: put the run at a collect node
    // feeding the cycle.
    h.state.nodes["flow-3"].unshift({
      node_key: "gate",
      node_type: "collect_input",
      config: { var_key: "g", prompt_text: "G?", next_node_key: "m1" },
    });
    (h.state.runs["run-3"] as Record<string, unknown>).current_node_key = "gate";
    (h.state.flows["flow-3"] as Record<string, unknown>).entry_node_id = "gate";

    const res = await dispatchInboundToFlows({
      accountId: ACCT,
      userId: USER,
      contactId: CONTACT,
      conversationId: CONV,
      message: { kind: "text" as const, text: "go", meta_message_id: "m-cycle" },
      isFirstInboundMessage: false,
    });

    expect(res.outcome).toBe("completed");
    expect(h.state.runs["run-3"]?.status).toBe("failed");
    // Bounded: 64 loop iterations of send_message, then the safety break.
    expect(h.state.sends.text.length).toBe(64);
    // Lock released: a follow-up dispatch still processes (starts a new
    // run here since the old one failed and taps never match entries —
    // the point is it proceeds instead of hanging on a stuck guard).
    const again = await dispatchInboundToFlows({
      accountId: ACCT,
      userId: USER,
      contactId: CONTACT,
      conversationId: CONV,
      message: { kind: "text" as const, text: "zzz", meta_message_id: "m-after" },
      isFirstInboundMessage: false,
    });
    expect(again.outcome).toBe("started");
    expect(again.consumed).toBe(true);
  });
});
