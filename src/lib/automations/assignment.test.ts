import { describe, expect, it, vi } from "vitest";

import {
  ASSIGN_HEADER,
  ASSIGN_KEY,
  claimAssignmentPick,
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

/** Minimal in-memory Supabase double for picks + flow_runs reads. */
function makeDb(opts?: {
  picks?: Array<Record<string, unknown>>;
  runs?: Array<Record<string, unknown>>;
}) {
  const picks: Array<Record<string, unknown>> = [...(opts?.picks ?? [])];
  const runs: Array<Record<string, unknown>> = [...(opts?.runs ?? [])];
  const db = {
    picks,
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
