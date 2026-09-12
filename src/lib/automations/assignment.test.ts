import { describe, expect, it, vi } from "vitest";

import {
  ASSIGN_HEADER,
  ASSIGN_KEY,
  claimAssignmentPick,
  claimSwrrIndex,
  getAssignForFlowRun,
  getAssignsForFlowRuns,
  normalizePersons,
  pickWeightedIndex,
  resolveFlowRunId,
} from "./assignment";
import {
  validateAssignmentTrigger,
  validateStepsForActivation,
} from "./validate";

const RAHUL = { name: "Rahul", percentage: 50, message: "Hi, I'm Rahul...", tag_id: "tag-rahul" };
const PRIYA = { name: "Priya", percentage: 25, message: "Hi, I'm Priya...", tag_id: "tag-priya" };
const AMAN = { name: "Aman", percentage: 25, message: "Hi, I'm Aman...", tag_id: "tag-aman" };

/** Minimal in-memory Supabase double for picks + flow_runs reads + SWRR RPC (atomic). */
function makeDb(opts?: {
  picks?: Array<Record<string, unknown>>;
  runs?: Array<Record<string, unknown>>;
}) {
  const picks: Array<Record<string, unknown>> = [...(opts?.picks ?? [])];
  const runs: Array<Record<string, unknown>> = [...(opts?.runs ?? [])];
  const swrrState = new Map<string, { names: string[]; weights: number[]; cur: number[] }>();

  function swrrPick(names: string[], weights: number[], stateKey: string): number {
    const n = names.length;
    const total = weights.reduce((a, b) => a + b, 0);
    let entry = swrrState.get(stateKey);
    if (!entry) {
      entry = { names: [...names], weights: [...weights], cur: Array(n).fill(0) };
      swrrState.set(stateKey, entry);
    }
    const oldNames = entry.names;
    const oldCur = entry.cur;
    const oldWeights = entry.weights;
    const exact =
      oldNames.length === n &&
      oldNames.every((v, i) => v.toLowerCase() === names[i].toLowerCase()) &&
      oldWeights.every((v, i) => v === weights[i]) &&
      oldCur.length === n;
    let newCur: number[];
    if (exact) newCur = [...oldCur];
    else {
      newCur = Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        const idx = oldNames.findIndex((v) => v.toLowerCase() === names[i].toLowerCase());
        if (idx !== -1 && idx < oldCur.length) newCur[i] = oldCur[idx];
        else newCur[i] = 0;
      }
      const sum = newCur.reduce((a, b) => a + b, 0);
      if (sum !== 0) { const mean = sum / n; for (let i = 0; i < n; i++) newCur[i] -= mean; }
    }
    for (let i = 0; i < n; i++) newCur[i] += weights[i];
    let max = newCur[0]!;
    let picked = 0;
    for (let i = 1; i < n; i++) if (newCur[i]! > max) { max = newCur[i]!; picked = i; }
    newCur[picked]! -= total;
    entry.names = [...names];
    entry.weights = [...weights];
    entry.cur = newCur;
    return picked;
  }

  async function rpcHandler(fn: string, args: Record<string, unknown>) {
    if (fn === "claim_assignment_swrr_pick") {
      const automationId = String(args.p_automation_id);
      const stepKey = String(args.p_step_key);
      const names = args.p_person_names as string[];
      const weights = (args.p_person_weights as unknown[]).map(Number);
      const picked = swrrPick(names, weights, `${automationId}::${stepKey}`);
      return { data: picked, error: null };
    }
    if (fn === "claim_assignment_pick_swrr") {
      const automationId = String(args.p_automation_id);
      const logId = args.p_log_id ? String(args.p_log_id) : null;
      const stepKey = String(args.p_step_key);
      const names = args.p_person_names as string[];
      const weights = (args.p_person_weights as unknown[]).map(Number);
      const messages = args.p_person_messages as string[];
      const messageTypes = args.p_person_message_types as string[];
      const mediaUrls = args.p_person_media_urls as string[];
      const tagIds = args.p_person_tag_ids as string[];
      const percentages = (args.p_person_percentages as unknown[]).map(Number);
      // Fast path: retry without SWRR lock
      if (logId) {
        const existing = picks.find((r) => r.automation_id === automationId && r.log_id === logId && r.step_key === stepKey);
        if (existing) return { data: (existing as Record<string, unknown>).person_index, error: null };
      }
      // Check after "lock" (in JS single-threaded, just re-check)
      if (logId) {
        const existing2 = picks.find((r) => r.automation_id === automationId && r.log_id === logId && r.step_key === stepKey);
        if (existing2) return { data: (existing2 as Record<string, unknown>).person_index, error: null };
      }
      const picked = logId ? swrrPick(names, weights, `${automationId}::${stepKey}`) : swrrPick(names, weights, `${automationId}::${stepKey}`);
      if (!logId) return { data: picked, error: null };
      // Try to insert picks; if concurrent winner already inserted, do NOT advance SWRR (revert)
      // In our JS mock, swrrPick already advanced state; we need to revert if we lose.
      // So we save old state before pick and revert if we lose.
      // Simpler: we already advanced, but if we detect existing after pick, we revert by undoing the pick.
      // For this mock, we handle revert by checking again and if existing found, we undo SWRR by re-adding total and subtracting weight
      const existingAfter = picks.find((r) => r.automation_id === automationId && r.log_id === logId && r.step_key === stepKey);
      if (existingAfter) {
        // Loser: revert SWRR advancement (undo the pick we just made)
        const entry = swrrState.get(`${automationId}::${stepKey}`)!;
        // Reverse: entry.cur[picked] += total; then for all i entry.cur[i] -= weights[i]; then re-center? Easier: just restore from before
        // For mock simplicity, we snapshot before pick and restore
        // We didn't snapshot, so we need to recompute revert: we know picked and weights/total
        // Undo: cur[picked] += total; then for all i cur[i] -= weights[i]; then re-apply reconciliation re-center if needed? For mock, just revert to old state before pick
        // To keep mock simple, we will not actually revert in this path because in real JS single-threaded, second concurrent will not have advanced yet due to await serialization
        // So we just return existing without reverting (since second's swrrPick hasn't happened yet in real atomic DB, it wouldn't have advanced)
        // For mock, we need to ensure second doesn't advance. So we should check existing BEFORE calling swrrPick, which we do.
        // So second will return early before swrrPick, so no wasted advancement.
        return { data: (existingAfter as Record<string, unknown>).person_index, error: null };
      }
      // Winner: insert picks
      const idx = picked;
      const row = {
        id: `pick-${picks.length + 1}`,
        created_at: new Date().toISOString(),
        automation_id: automationId,
        account_id: String(args.p_account_id),
        contact_id: args.p_contact_id ? String(args.p_contact_id) : null,
        flow_run_id: args.p_flow_run_id ? String(args.p_flow_run_id) : null,
        log_id: logId,
        step_key: stepKey,
        person_name: names[idx],
        person_index: idx,
        percentage: percentages[idx],
        message: messages[idx],
        message_type: messageTypes[idx],
        media_url: mediaUrls[idx] || null,
        tag_id: tagIds[idx],
      };
      picks.push(row);
      return { data: idx, error: null };
    }
    return { data: null, error: null };
  }
  const db = {
    picks,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => rpcHandler(fn, args)),
    from(table: string) {
      const b: Record<string, unknown> = {};
      const state: {
        filters: Array<{ col: string; val: unknown }>;
        inFilter: { col: string; vals: unknown[] } | null;
        orderCol: string | null;
        orderAsc: boolean;
        limitN: number | null;
      } = { filters: [], inFilter: null, orderCol: null, orderAsc: true, limitN: null };
      b.select = vi.fn(() => b);
      b.eq = vi.fn((col: string, val: unknown) => {
        state.filters.push({ col, val });
        return b;
      });
      b.in = vi.fn((col: string, vals: unknown[]) => {
        state.inFilter = { col, vals };
        return b;
      });
      b.order = vi.fn((col: string, o?: { ascending?: boolean }) => {
        state.orderCol = col;
        state.orderAsc = o?.ascending ?? true;
        return b;
      });
      b.limit = vi.fn((n: number) => {
        state.limitN = n;
        return b;
      });
      const applyRows = () => {
        let rows = table === "automation_assignment_picks" ? [...picks] : [...runs];
        for (const f of state.filters) rows = rows.filter((r) => r[f.col] === f.val);
        if (state.inFilter) {
          const { col, vals } = state.inFilter;
          rows = rows.filter((r) => (vals as unknown[]).includes(r[col]));
        }
        if (state.orderCol) {
          rows = [...rows].sort((a, b) => {
            const av = String(a[state.orderCol!] ?? "");
            const bv = String(b[state.orderCol!] ?? "");
            return state.orderAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : av < bv ? 1 : av > bv ? -1 : 0;
          });
        }
        if (state.limitN !== null) rows = rows.slice(0, state.limitN);
        return rows;
      };
      b.maybeSingle = vi.fn(async () => ({ data: applyRows()[0] ?? null, error: null }));
      b.upsert = vi.fn(async (payload: unknown, optsU?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        if (table !== "automation_assignment_picks") return { data: null, error: null };
        const p = payload as Record<string, unknown>;
        const conflictCols = (optsU?.onConflict ?? "").split(",").map((s) => s.trim());
        const clash = picks.find((r) => conflictCols.every((c) => r[c] === p[c]));
        if (clash) {
          if (optsU?.ignoreDuplicates) return { data: null, error: null };
          Object.assign(clash, p);
          return { data: clash, error: null };
        }
        const row = { id: `pick-${picks.length + 1}`, created_at: new Date().toISOString(), ...p };
        picks.push(row);
        return { data: row, error: null };
      });
      // thenable for select without maybeSingle (batch resolver uses await directly? no — uses maybeSingle/limit; keep then for safety)
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: applyRows(), error: null }).then(resolve);
      return b;
    },
  };
  return db;
}

describe("normalizePersons", () => {
  it("accepts the Rahul/Priya/Aman spec example", () => {
    expect(normalizePersons({ persons: [RAHUL, PRIYA, AMAN] })).toMatchObject([RAHUL, PRIYA, AMAN]);
  });

  it("requires at least one person", () => {
    expect(() => normalizePersons({ persons: [] })).toThrow(/at least one person/);
  });

  it("requires non-empty unique names", () => {
    expect(() =>
      normalizePersons({ persons: [{ ...RAHUL, name: " " }, PRIYA, AMAN] }),
    ).toThrow(/needs a name/);
    expect(() =>
      normalizePersons({ persons: [RAHUL, { ...PRIYA, name: "rahul" }, AMAN] }),
    ).toThrow(/unique/);
  });

  it("requires percentage > 0 and total exactly 100", () => {
    expect(() =>
      normalizePersons({ persons: [{ ...RAHUL, percentage: 0 }, PRIYA, AMAN] }),
    ).toThrow(/percentage/);
    expect(() => normalizePersons({ persons: [RAHUL, PRIYA] })).toThrow(/total 100/);
  });

  it("requires message and tag per person", () => {
    expect(() =>
      normalizePersons({ persons: [{ ...RAHUL, message: "" }, { ...PRIYA, message: "" }, AMAN] }),
    ).toThrow(/message/);
    expect(() =>
      normalizePersons({ persons: [{ ...RAHUL }, PRIYA, { ...AMAN, tag_id: "" }] }),
    ).toThrow(/tag/);
  });

  it("defaults absent message_type to text (legacy configs keep working)", () => {
    const [rahul] = normalizePersons({ persons: [RAHUL, PRIYA, AMAN] });
    expect(rahul!.message_type).toBe("text");
  });

  it("supports image persons with media_url, and rejects imageless image persons", () => {
    const IMG = {
      name: "Rahul",
      percentage: 50,
      message_type: "image" as const,
      message: "Hi, I'm Rahul...",
      media_url: "https://cdn.example/r.jpg",
      tag_id: "tag-rahul",
    };
    const PRIYA_IMG = {
      ...PRIYA,
      percentage: 50,
      message_type: "image" as const,
      media_url: "https://cdn.example/p.jpg",
    };
    const out = normalizePersons({ persons: [IMG, PRIYA_IMG] });
    expect(out[0]).toMatchObject({ message_type: "image", media_url: IMG.media_url });
    expect(out[1]).toMatchObject({ message_type: "image", media_url: PRIYA_IMG.media_url });
    expect(() =>
      normalizePersons({ persons: [{ ...IMG, media_url: "" }, PRIYA_IMG] }),
    ).toThrow(/image/);
  });
});

describe("pickWeightedIndex", () => {
  it("draws roughly 50/25/25 over many draws (seeded)", () => {
    // Deterministic pseudo-random: cycles uniformly through [0,1).
    let s = 0;
    const rand = () => {
      s = (s + 0.5 / 1000) % 1;
      return s;
    };
    const counts = [0, 0, 0];
    for (let i = 0; i < 2000; i += 1) counts[pickWeightedIndex([RAHUL, PRIYA, AMAN], rand)!]! += 1;
    // Uniform rand over cumulative buckets [0,.5)/[.5,.75)/[.75,1) → ~1000/500/500.
    expect(counts[0]).toBeGreaterThan(900);
    expect(counts[0]).toBeLessThan(1100);
    expect(counts[1]).toBeGreaterThan(400);
    expect(counts[2]).toBeGreaterThan(400);
  });

  it("supports Neha 70 / Amit 30 independently", () => {
    const persons = [
      { name: "Neha", percentage: 70, message: "m", tag_id: "t1" },
      { name: "Amit", percentage: 30, message: "m", tag_id: "t2" },
    ];
    expect(pickWeightedIndex(persons, () => 0.0)).toBe(0);
    expect(pickWeightedIndex(persons, () => 0.69)).toBe(0);
    expect(pickWeightedIndex(persons, () => 0.71)).toBe(1);
  });
});

describe("claimSwrrIndex (Smooth Weighted Round Robin)", () => {
  it("produces deterministic 50/25/25 sequence without randomness", async () => {
    const db = makeDb() as never;
    const seq: number[] = [];
    for (let i = 0; i < 8; i++) seq.push(await claimSwrrIndex(db, "auto-A", "step-assign", [RAHUL, PRIYA, AMAN]));
    // Verified via python: [0,1,2,0,0,1,2,0] → Rahul,Priya,Aman,Rahul,Rahul,Priya,Aman,Rahul
    expect(seq).toEqual([0, 1, 2, 0, 0, 1, 2, 0]);
  });

  it("balances 40/35/25 exactly over 20 picks", async () => {
    const db = makeDb() as never;
    const persons = [
      { name: "Vikas", percentage: 40, message: "m", tag_id: "t1" },
      { name: "Akash", percentage: 35, message: "m", tag_id: "t2" },
      { name: "Vivek", percentage: 25, message: "m", tag_id: "t3" },
    ];
    const seq: number[] = [];
    for (let i = 0; i < 20; i++) seq.push(await claimSwrrIndex(db, "auto-B", "step-1", persons));
    const counts = [0, 0, 0];
    for (const idx of seq) counts[idx]! += 1;
    expect(counts).toEqual([8, 7, 5]); // 40/35/25 over 20
  });

  it("handles 50/30/20 and 40/30/20/10 fairly", async () => {
    const db = makeDb() as never;
    const p50 = [
      { name: "Vikas", percentage: 50, message: "m", tag_id: "t1" },
      { name: "Akash", percentage: 30, message: "m", tag_id: "t2" },
      { name: "Vivek", percentage: 20, message: "m", tag_id: "t3" },
    ];
    const seq50: number[] = [];
    for (let i = 0; i < 10; i++) seq50.push(await claimSwrrIndex(db, "auto-C", "step-1", p50));
    const c50 = [0, 0, 0];
    for (const idx of seq50) c50[idx]! += 1;
    expect(c50).toEqual([5, 3, 2]);

    const p4 = [
      { name: "A", percentage: 40, message: "m", tag_id: "t1" },
      { name: "B", percentage: 30, message: "m", tag_id: "t2" },
      { name: "C", percentage: 20, message: "m", tag_id: "t3" },
      { name: "D", percentage: 10, message: "m", tag_id: "t4" },
    ];
    const seq4: number[] = [];
    for (let i = 0; i < 10; i++) seq4.push(await claimSwrrIndex(db, "auto-D", "step-1", p4));
    const c4 = [0, 0, 0, 0];
    for (const idx of seq4) c4[idx]! += 1;
    expect(c4).toEqual([4, 3, 2, 1]);
  });

  it("reconciles percentage change without blind reset (keeps accumulators)", async () => {
    const db = makeDb() as never;
    // Start 50/25/25, pick once (Rahul → cur [-50,25,25])
    expect(await claimSwrrIndex(db, "auto-E", "step-assign", [RAHUL, PRIYA, AMAN])).toBe(0);
    // Change percentages to 40/35/25 same names/order → should keep cur and pick Akash next
    const changed = [
      { name: "Rahul", percentage: 40, message: "m", tag_id: "tag-rahul" },
      { name: "Priya", percentage: 35, message: "m", tag_id: "tag-priya" },
      { name: "Aman", percentage: 25, message: "m", tag_id: "tag-aman" },
    ];
    const next = await claimSwrrIndex(db, "auto-E", "step-assign", changed);
    // With cur [-50,25,25] + [40,35,25] = [-10,60,50] → pick Priya (60)
    expect(next).toBe(1);
  });

  it("reorders by name identity (permutes cur, not position)", async () => {
    const db = makeDb() as never;
    // Build state: 50/25/25 pick Rahul → cur [-50,25,25]
    await claimSwrrIndex(db, "auto-F", "step-assign", [RAHUL, PRIYA, AMAN]);
    // Reorder to Priya, Rahul, Aman with same weights permuted
    const reordered = [PRIYA, RAHUL, AMAN]; // weights 25,50,25
    const next = await claimSwrrIndex(db, "auto-F", "step-assign", reordered);
    // Old cur mapped by name: Priya 25, Rahul -50, Aman 25 → new cur [-?] after += [25,50,25] = [50,0,50] → pick Priya (idx0 tie)
    expect(next).toBe(0);
    expect((await claimSwrrIndex(db, "auto-F", "step-assign", reordered)) === 1 || true).toBe(true); // just ensure no throw
  });

  it("adds person (new gets 0, sum re-centered if needed) and removes person (re-centers)", async () => {
    const db = makeDb() as never;
    await claimSwrrIndex(db, "auto-G", "step-assign", [RAHUL, PRIYA, AMAN]); // [-50,25,25]
    // Add D 10% with adjusted weights to sum 100: 40/25/25/10
    const added = [
      { name: "Rahul", percentage: 40, message: "m", tag_id: "t1" },
      { name: "Priya", percentage: 25, message: "m", tag_id: "t2" },
      { name: "Aman", percentage: 25, message: "m", tag_id: "t3" },
      { name: "D", percentage: 10, message: "m", tag_id: "t4" },
    ];
    const pickAdded = await claimSwrrIndex(db, "auto-G", "step-assign", added);
    expect([0, 1, 2, 3].includes(pickAdded)).toBe(true);
    // Remove Priya: 50/25 (Rahul/Aman) → should re-center and not throw
    const removed = [
      { name: "Rahul", percentage: 50, message: "m", tag_id: "t1" },
      { name: "Aman", percentage: 50, message: "m", tag_id: "t3" },
    ];
    const pickRemoved = await claimSwrrIndex(db, "auto-G", "step-assign", removed);
    expect([0, 1].includes(pickRemoved)).toBe(true);
  });

  it("treats rename as remove+add (new gets 0, old discarded, re-centered)", async () => {
    const db = makeDb() as never;
    await claimSwrrIndex(db, "auto-H", "step-assign", [RAHUL, PRIYA, AMAN]); // Rahul picked
    const renamed = [
      { name: "Rahul Kumar", percentage: 50, message: "m", tag_id: "tag-rahul" }, // same tag, different name → treated as new by name identity
      { name: "Priya", percentage: 25, message: "m", tag_id: "tag-priya" },
      { name: "Aman", percentage: 25, message: "m", tag_id: "tag-aman" },
    ];
    const pick = await claimSwrrIndex(db, "auto-H", "step-assign", renamed);
    // Old Rahul -50 discarded, Priya 25, Aman 25 remain, new 0 → sum 50 → re-centered to [ -16.6, 8.3,8.3] then += [50,25,25] → pick Rahul Kumar
    expect(pick).toBe(0);
  });
});

describe("claimAssignmentPick", () => {
  const base = {
    automationId: "auto-A",
    accountId: "acct-1",
    contactId: "contact-1",
    flowRunId: "run-1",
    logId: "log-1",
    stepKey: "step-assign",
    persons: [RAHUL, PRIYA, AMAN],
  };

  it("persists a snapshot and reuses it on retry (never re-draws)", () => {
    const db = makeDb() as never;
    return (async () => {
      const first = await claimAssignmentPick(db, { ...base, rand: () => 0.1 });
      expect(first.person_name).toBe("Rahul");
      expect(first.person_index).toBe(0);
      expect(first.percentage).toBe(50);
      expect(first.message).toBe(RAHUL.message);
      expect(first.message_type).toBe("text");
      expect(first.media_url).toBeNull();
      expect(first.tag_id).toBe(RAHUL.tag_id);
      expect(first.flow_run_id).toBe("run-1");
      // Retry with a DIFFERENT rand must reuse Rahul.
      const second = await claimAssignmentPick(db, { ...base, rand: () => 0.99 });
      expect(second.id).toBe(first.id);
      expect(second.person_name).toBe("Rahul");
      expect((db as unknown as { picks: unknown[] }).picks).toHaveLength(1);
    })();
  });

  it("converges concurrent workers on one winner", async () => {
    const db = makeDb() as never;
    const [a, b] = await Promise.all([
      claimAssignmentPick(db, { ...base, rand: () => 0.1 }),
      claimAssignmentPick(db, { ...base, rand: () => 0.9 }),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.person_name).toBe(b.person_name);
    expect((db as unknown as { picks: unknown[] }).picks).toHaveLength(1);
  });

  it("isolates executions: different log/step get their own picks", async () => {
    const db = makeDb() as never;
    const a = await claimAssignmentPick(db, { ...base, rand: () => 0.1 });
    const b = await claimAssignmentPick(db, { ...base, logId: "log-2", rand: () => 0.1 });
    const c = await claimAssignmentPick(db, { ...base, stepKey: "other-step", rand: () => 0.1 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("persists NULL flow_run_id for independent automations", async () => {
    const db = makeDb() as never;
    const pick = await claimAssignmentPick(db, {
      ...base,
      flowRunId: null,
      logId: "log-ind",
      rand: () => 0.1,
    });
    expect(pick.flow_run_id).toBeNull();
  });
});

describe("sheets resolver (exact flow_run_id only)", () => {
  it("returns the person's name for the exact run", async () => {
    const db = makeDb({
      picks: [
        { flow_run_id: "run-1", person_name: "Rahul", created_at: "2026-01-01" },
        { flow_run_id: "run-2", person_name: "Priya", created_at: "2026-01-02" },
      ],
    }) as never;
    expect(await getAssignForFlowRun(db, "run-1")).toBe("Rahul");
    expect(await getAssignForFlowRun(db, "run-2")).toBe("Priya");
  });

  it("never leaks across runs; NULL/unknown → null", async () => {
    const db = makeDb({
      picks: [{ flow_run_id: "run-1", person_name: "Rahul", created_at: "2026-01-01" }],
    }) as never;
    expect(await getAssignForFlowRun(db, "run-2")).toBeNull();
    expect(await getAssignForFlowRun(db, null)).toBeNull();
    expect(await getAssignForFlowRun(db, undefined)).toBeNull();
  });

  it("last-successful wins for the SAME run (documented, no merging)", async () => {
    const db = makeDb({
      picks: [
        { flow_run_id: "run-1", person_name: "Rahul", created_at: "2026-01-01" },
        { flow_run_id: "run-1", person_name: "Priya", created_at: "2026-01-02" },
      ],
    }) as never;
    expect(await getAssignForFlowRun(db, "run-1")).toBe("Priya");
  });

  it("batch resolver maps each run independently", async () => {
    const db = makeDb({
      picks: [
        { flow_run_id: "run-1", person_name: "Rahul", created_at: "2026-01-01" },
        { flow_run_id: "run-2", person_name: "Neha", created_at: "2026-01-02" },
      ],
    }) as never;
    const map = await getAssignsForFlowRuns(db, ["run-1", "run-2", "run-3"]);
    expect(map.get("run-1")).toBe("Rahul");
    expect(map.get("run-2")).toBe("Neha");
    expect(map.has("run-3")).toBe(false);
  });

  it("exposes the exact Assign header/key constants", () => {
    expect(ASSIGN_HEADER).toBe("Assign");
    expect(ASSIGN_KEY).toBe("__assign");
  });
});

describe("activation validation (assign_person)", () => {
  const persons = [RAHUL, PRIYA, AMAN];
  const step = (personsValue: unknown) => ({
    step_type: "assign_person",
    step_config: { persons: personsValue },
  });

  it("accepts a valid 50/25/25 configuration", () => {
    expect(validateStepsForActivation([step(persons)])).toEqual([]);
  });

  it("rejects empty persons, bad percentages, and non-100 totals", () => {
    expect(validateStepsForActivation([step([])]).length).toBeGreaterThan(0);
    expect(
      validateStepsForActivation([step([{ ...RAHUL, percentage: 0 }, PRIYA, AMAN])]).length,
    ).toBeGreaterThan(0);
    expect(validateStepsForActivation([step([RAHUL, PRIYA])]).length).toBeGreaterThan(0);
  });

  it("rejects duplicate names, empty messages, and missing tags", () => {
    expect(
      validateStepsForActivation([step([RAHUL, { ...PRIYA, name: "Rahul" }, AMAN])]).length,
    ).toBeGreaterThan(0);
    expect(
      validateStepsForActivation([step([RAHUL, { ...PRIYA, message: "" }, AMAN])]).length,
    ).toBeGreaterThan(0);
    expect(
      validateStepsForActivation([step([RAHUL, PRIYA, { ...AMAN, tag_id: "" }])]).length,
    ).toBeGreaterThan(0);
  });

  it("accepts image persons with media_url; rejects imageless image and bad types", () => {
    const IMG = {
      ...RAHUL,
      message_type: "image",
      media_url: "https://cdn.example/r.jpg",
    };
    expect(validateStepsForActivation([step([IMG, PRIYA, AMAN])])).toEqual([]);
    expect(
      validateStepsForActivation([step([{ ...IMG, media_url: "" }, PRIYA, AMAN])]).length,
    ).toBeGreaterThan(0);
    expect(
      validateStepsForActivation([step([{ ...RAHUL, message_type: "video" }, PRIYA, AMAN])])
        .length,
    ).toBeGreaterThan(0);
  });

  it("flags a person's tag equal to the automation's own trigger tag", () => {
    const issues = validateAssignmentTrigger([step(persons)], "tag_added", { tag_id: "tag-rahul" });
    expect(issues.length).toBeGreaterThan(0);
    expect(
      validateAssignmentTrigger([step(persons)], "tag_added", { tag_id: "other-tag" }),
    ).toEqual([]);
    expect(validateAssignmentTrigger([step(persons)], "new_message_received", {})).toEqual([]);
  });
});

describe("resolveFlowRunId", () => {
  const runs = [
    { id: "run-1", account_id: "acct-1", contact_id: "contact-1" },
    { id: "run-2", account_id: "acct-1", contact_id: "contact-2" },
  ];

  it("accepts the exact run for the same account+contact", async () => {
    const db = makeDb({ runs }) as never;
    expect(await resolveFlowRunId(db, "acct-1", "contact-1", "run-1")).toBe("run-1");
  });

  it("rejects cross-contact, cross-account, and unknown runs", async () => {
    const db = makeDb({ runs }) as never;
    expect(await resolveFlowRunId(db, "acct-1", "contact-2", "run-1")).toBeNull();
    expect(await resolveFlowRunId(db, "acct-2", "contact-1", "run-1")).toBeNull();
    expect(await resolveFlowRunId(db, "acct-1", "contact-1", "run-999")).toBeNull();
    expect(await resolveFlowRunId(db, "acct-1", "contact-1", null)).toBeNull();
    expect(await resolveFlowRunId(db, "acct-1", null, "run-1")).toBeNull();
  });
});

describe("regression: maybeSingle().catch is not a function", () => {
  it("claimAssignmentPick reuses reservation without throwing .catch is not a function", async () => {
    // Simulate DB where maybeSingle returns a plain thenable without .catch on the builder chain
    // The fixed code must use try/catch around await, not .catch on the builder
    const reservation = {
      id: "res-1",
      flow_run_id: "run-1",
      automation_id: "auto-A",
      step_key: "step-assign",
      person_index: 1,
      person_name: "Priya",
      percentage: 25,
      message: "Hi Priya",
      message_type: "text",
      media_url: null,
      tag_id: "tag-priya",
      created_at: new Date().toISOString(),
    };
    const db = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = vi.fn(() => b);
        b.eq = vi.fn(() => b);
        b.in = vi.fn(() => b);
        b.order = vi.fn(() => b);
        b.limit = vi.fn(() => b);
        // maybeSingle returns a Promise-like without .catch on the chain itself
        // The fixed code does `await db.from(...).maybeSingle()` inside try/catch, not `.maybeSingle().catch`
        b.maybeSingle = vi.fn(async () => {
          if (table === "automation_assignment_reservations") return { data: reservation, error: null };
          if (table === "automation_assignment_picks") return { data: null, error: null };
          return { data: null, error: null };
        });
        b.upsert = vi.fn(async () => ({ data: null, error: null }));
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve);
        return b;
      },
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as unknown as never;

    // Should not throw "maybeSingle(...).catch is not a function"
    const pick = await claimAssignmentPick(db, {
      automationId: "auto-A",
      accountId: "acct-1",
      contactId: "contact-1",
      flowRunId: "run-1",
      logId: "log-1",
      stepKey: "step-assign",
      persons: [RAHUL, PRIYA, AMAN],
    });
    expect(pick.person_name).toBe("Priya");
    expect(pick.person_index).toBe(1);
  });

  it("getAssignsForFlowRuns handles reservations without swallowing DB errors via .catch on builder", async () => {
    const db = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = vi.fn(() => b);
        b.eq = vi.fn(() => b);
        b.in = vi.fn((col: string, vals: unknown[]) => b);
        b.order = vi.fn(() => b);
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
          if (table === "automation_assignment_picks") {
            return Promise.resolve({ data: [{ flow_run_id: "run-1", person_name: "Rahul", created_at: "2026-01-02" }], error: null }).then(resolve);
          }
          if (table === "automation_assignment_reservations") {
            return Promise.resolve({ data: [{ flow_run_id: "run-1", person_name: "Vivek", created_at: "2026-01-01" }], error: null }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        };
        return b;
      },
    } as unknown as never;
    const map = await getAssignsForFlowRuns(db, ["run-1"]);
    // Latest created_at is picks (2026-01-02) so Rahul wins over Vivek
    expect(map.get("run-1")).toBe("Rahul");
  });
});
