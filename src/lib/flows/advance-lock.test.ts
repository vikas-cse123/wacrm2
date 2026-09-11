// ============================================================
// withFlowAdvanceLock protocol tests.
//
// The lock is the serialization primitive behind duplicate-advance
// protection: INSERT is the atomic acquire (PK conflict = held), release
// is owner-scoped, crashed holders are taken over by age, waiters give up
// at a deadline. Deterministic via injected clock/sleeper/owner.
// ============================================================

import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  withFlowAdvanceLock,
  FLOW_ADVANCE_LOCK_STALE_MS,
  FLOW_ADVANCE_LOCK_WAIT_MS,
} from "./advance-lock";

interface LockRow {
  account_id: string;
  contact_id: string;
  owner: string;
  locked_at: string;
}

function conflictError() {
  return {
    message:
      'duplicate key value violates unique constraint "flow_advance_locks_pkey" (23505)',
    code: "23505",
  };
}

/** Minimal mock: scripted lock-table behavior + call recording.
 *
 * Faithful in one load-bearing way: selected columns are validated
 * against the real flow_advance_locks shape, PostgREST-style. A query
 * selecting an unknown column (e.g. a dropped/renamed column) fails
 * with 42703 exactly as production would — this is what pins the
 * takeover delete to real columns.
 */
const LOCK_COLUMNS = new Set([
  "account_id",
  "contact_id",
  "owner",
  "locked_at",
  "*",
]);

function makeDb(behavior: {
  onInsert?: (payload: Record<string, unknown>) => { error: unknown } | null;
  onSelect?: () => LockRow | null;
  onDelete?: (filters: [string, string, unknown][]) => unknown;
  now?: () => number;
}) {
  const calls = {
    inserts: [] as unknown[],
    selects: 0,
    deletes: [] as [string, string, unknown][][],
    sleeps: [] as number[],
  };
  let t = 0;
  const now = behavior.now ?? (() => t);
  const b: Record<string, unknown> = {};
  const filters: [string, string, unknown][] = [];
  let selectError: unknown = null;
  const checkColumns = (cols?: string) => {
    if (typeof cols !== "string") return;
    const bad = cols
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c && !LOCK_COLUMNS.has(c));
    if (bad.length > 0) {
      selectError = {
        code: "42703",
        message: `column ${bad[0]} does not exist`,
      };
    }
  };
  b.from = vi.fn(() => {
    filters.length = 0;
    selectError = null;
    return b;
  });
  b.insert = vi.fn((payload: unknown) => {
    calls.inserts.push(payload);
    const r = behavior.onInsert?.(payload as Record<string, unknown>);
    if (r) return Promise.resolve(r);
    return Promise.resolve({ error: null });
  });
  b.select = vi.fn((cols?: string) => {
    checkColumns(cols);
    return b;
  });
  b.eq = vi.fn((k: string, v: unknown) => {
    filters.push(["eq", k, v]);
    return b;
  });
  b.lt = vi.fn((k: string, v: unknown) => {
    filters.push(["lt", k, v]);
    return b;
  });
  b.maybeSingle = vi.fn(async () => {
    if (selectError) return { data: null, error: selectError };
    return {
      data: behavior.onSelect?.() ?? null,
      error: null,
    };
  });
  b.delete = vi.fn(() => b);
  b.then = (resolve: (v: unknown) => unknown) => {
    calls.deletes.push([...filters]);
    if (selectError) return resolve({ data: null, error: selectError });
    const r = behavior.onDelete?.([...filters]);
    return resolve(r ?? { data: null, error: null });
  };
  const db = { from: b.from } as unknown as SupabaseClient;
  const sleep = vi.fn(async (ms: number) => {
    calls.sleeps.push(ms);
    t += ms;
  });
  return { db, calls, now, sleep };
}

describe("withFlowAdvanceLock", () => {
  it("runs fn once and releases its own row when uncontended", async () => {
    const { db, calls } = makeDb({});
    const fn = vi.fn(async () => "done");
    const res = await withFlowAdvanceLock(db, "a", "c", fn, {
      owner: "owner-1",
    });
    expect(res).toEqual({ ok: true, value: "done" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.inserts).toHaveLength(1);
    expect(calls.deletes).toHaveLength(1);
    // Release is owner-scoped: it can never drop another holder's row.
    expect(calls.deletes[0]).toContainEqual(["eq", "owner", "owner-1"]);
  });

  it("waits while held, then acquires after release", async () => {
    let held: LockRow | null = {
      account_id: "a",
      contact_id: "c",
      owner: "other",
      locked_at: new Date(1_000).toISOString(),
    };
    let nowMs = 2_000;
    const { db, calls } = makeDb({
      now: () => nowMs,
      onInsert: () => (held ? { error: conflictError() } : null),
      onSelect: () => held,
    });
    const pending = withFlowAdvanceLock(db, "a", "c", async () => "late", {
      owner: "me",
      now: () => nowMs,
      sleep: async (ms: number) => {
        calls.sleeps.push(ms);
        nowMs += ms;
        // Holder releases mid-wait.
        if (nowMs >= 2_500) held = null;
      },
    });
    const res = await pending;
    expect(res).toEqual({ ok: true, value: "late" });
    expect(calls.sleeps.length).toBeGreaterThan(0);
  });

  it("takes over a stale lock instead of waiting it out", async () => {
    let held: LockRow | null = {
      account_id: "a",
      contact_id: "c",
      owner: "crashed",
      locked_at: new Date(0).toISOString(),
    };
    // Advancing clock so a regression here fails fast with !ok instead of
    // hanging: the mock below only honors deletes scoped to stale rows.
    let nowMs = FLOW_ADVANCE_LOCK_STALE_MS + 5_000;
    const { db, calls } = makeDb({
      now: () => nowMs,
      onInsert: () => (held ? { error: conflictError() } : null),
      onSelect: () => held,
      onDelete: (filters) => {
        // Faithful PostgREST emulation: only rows matching every filter
        // (including locked_at < cutoff) are removed.
        const ltCutoff = filters.find(([op]) => op === "lt")?.[2] as
          | string
          | undefined;
        if (
          held &&
          ltCutoff !== undefined &&
          held.locked_at < (ltCutoff as string)
        ) {
          held = null;
          return { data: [{ account_id: "a" }], error: null };
        }
        return { data: [], error: null };
      },
    });
    // Takeover deletes the stale row; next insert succeeds.
    const res = await withFlowAdvanceLock(
      db,
      "a",
      "c",
      async () => "took-over",
      {
        owner: "me",
        staleMs: 1_000,
        waitMs: 5_000,
        pollMs: 10,
        now: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      },
    );
    expect(res.ok).toBe(true);
    // The takeover delete was scoped to stale rows (lt locked_at cutoff):
    // an unscoped delete (or none at all) could never have removed it.
    const scoped = calls.deletes.find((f) =>
      f.some(([op, col]) => op === "lt" && col === "locked_at"),
    );
    expect(scoped).toBeDefined();
    expect(calls.deletes.length).toBeGreaterThanOrEqual(1);
  });

  it("gives up at the deadline without running fn", async () => {
    let nowMs = 0;
    const { db, calls } = makeDb({
      now: () => nowMs,
      onInsert: () => ({ error: conflictError() }),
      onSelect: () => ({
        account_id: "a",
        contact_id: "c",
        owner: "busy",
        locked_at: new Date(0).toISOString(),
      }),
    });
    const res = await withFlowAdvanceLock(db, "a", "c", async () => "x", {
      owner: "me",
      now: () => nowMs,
      sleep: async (ms: number) => {
        calls.sleeps.push(ms);
        nowMs += ms;
      },
      waitMs: 1_000,
      pollMs: 100,
      staleMs: FLOW_ADVANCE_LOCK_STALE_MS,
    });
    expect(res).toEqual({ ok: false });
    // It polled (waited) rather than failing fast.
    expect(calls.sleeps.length).toBeGreaterThan(0);
  });

  it("releases even when fn throws, and propagates the error", async () => {
    const { db, calls } = makeDb({});
    const boom = new Error("boom");
    await expect(
      withFlowAdvanceLock(
        db,
        "a",
        "c",
        async () => {
          throw boom;
        },
        { owner: "me" },
      ),
    ).rejects.toBe(boom);
    expect(calls.deletes).toHaveLength(1);
  });

  it("non-conflict insert errors fail closed without waiting", async () => {
    const { db } = makeDb({
      onInsert: () => ({ error: { code: "42501", message: "denied" } }),
    });
    let slept = 0;
    const res = await withFlowAdvanceLock(db, "a", "c", async () => "x", {
      owner: "me",
      sleep: async (ms: number) => {
        slept += ms;
      },
    });
    expect(res).toEqual({ ok: false });
    expect(slept).toBe(0);
  });

  it("exports sane default budgets", () => {
    expect(FLOW_ADVANCE_LOCK_WAIT_MS).toBeLessThanOrEqual(15_000);
    expect(FLOW_ADVANCE_LOCK_STALE_MS).toBeGreaterThan(
      FLOW_ADVANCE_LOCK_WAIT_MS,
    );
  });

  it("missing lock table (42P01) runs unlocked instead of blacking out", async () => {
    const missingTable = () => ({
      error: {
        code: "42P01",
        message: 'relation "public.flow_advance_locks" does not exist',
      },
    });
    let nowMs = 0;
    const { db, calls } = makeDb({
      now: () => nowMs,
      onInsert: () => missingTable(),
    });
    const fn = vi.fn(async () => "legacy-behavior");
    const res = await withFlowAdvanceLock(db, "a", "c", fn, {
      owner: "me",
      now: () => nowMs,
      sleep: async (ms: number) => {
        calls.sleeps.push(ms);
        nowMs += ms;
      },
    });
    // Status quo ante: the advance runs (race included) rather than every
    // inbound being skipped. No waiting, no release attempt.
    expect(res).toEqual({ ok: true, value: "legacy-behavior" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.sleeps).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  it("missing-table message match also fails open (no code field)", async () => {
    const { db } = makeDb({
      onInsert: () => ({
        error: {
          message:
            'relation "public.flow_advance_locks" does not exist (42P01)',
        },
      }),
    });
    const res = await withFlowAdvanceLock(db, "a", "c", async () => 7, {
      owner: "me",
    });
    expect(res).toEqual({ ok: true, value: 7 });
  });

  it("stale takeover never deletes a freshly replaced row", async () => {
    // Race simulation: our read saw a stale row, but before our
    // conditional delete lands, the old owner released and a new holder
    // acquired (fresh locked_at). The lt-cutoff delete must match zero
    // rows, and we must NOT assume ownership.
    let held: LockRow | null = {
      account_id: "a",
      contact_id: "c",
      owner: "crashed",
      locked_at: new Date(0).toISOString(),
    };
    let nowMs = FLOW_ADVANCE_LOCK_STALE_MS + 5_000;
    let replaced = false;
    const { db } = makeDb({
      now: () => nowMs,
      onInsert: () => (held ? { error: conflictError() } : null),
      onSelect: () => held,
      onDelete: (filters) => {
        if (!replaced) {
          // Concurrent release + re-acquire lands first.
          replaced = true;
          held = {
            account_id: "a",
            contact_id: "c",
            owner: "fresh-holder",
            locked_at: new Date(nowMs).toISOString(),
          };
        }
        const ltCutoff = filters.find(([op]) => op === "lt")?.[2] as
          | string
          | undefined;
        const matched =
          held &&
          (!ltCutoff || held.locked_at < (ltCutoff as string))
            ? [{ id: "gone" }]
            : [];
        if (matched.length > 0) held = null;
        return { data: matched, error: null };
      },
    });
    const fn = vi.fn(async () => "must-not-run");
    const res = await withFlowAdvanceLock(db, "a", "c", fn, {
      owner: "me",
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
      waitMs: 500,
      pollMs: 50,
      staleMs: 1_000,
    });
    expect(res).toEqual({ ok: false });
    expect(fn).not.toHaveBeenCalled();
    // The fresh holder's row survived our takeover attempt.
    expect(held).not.toBeNull();
    expect(held?.owner).toBe("fresh-holder");
  });
});
