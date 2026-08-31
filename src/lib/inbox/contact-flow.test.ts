import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { contactFlowRunsQuery, pickContactFlow, pickContactFlowRun, type ContactFlowRun } from "./contact-flow";

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

function makeRun(overrides: Partial<ContactFlowRun> = {}): ContactFlowRun {
  return {
    id: "run-1",
    status: "active",
    started_at: "2026-01-01T10:00:00Z",
    flow: { id: "flow-1", name: "Bali Automation" },
    ...overrides,
  };
}

// ------------------------------------------------------------
// pickContactFlow — selection rule
// ------------------------------------------------------------

describe("pickContactFlow", () => {
  it("returns the flow name for a single run", () => {
    expect(pickContactFlow([makeRun()])).toBe("Bali Automation");
  });

  it("returns null when there are no runs (empty state)", () => {
    expect(pickContactFlow([])).toBeNull();
  });

  it("returns null when no run has an embedded flow", () => {
    const runs = [
      makeRun({ id: "run-1", flow: null }),
      makeRun({ id: "run-2", flow: { id: "f2", name: "" } }),
    ];
    expect(pickContactFlow(runs)).toBeNull();
  });

  it("prefers the active run even when a newer completed run exists", () => {
    // The engine only starts a new run when none is active, but never
    // assume ordering — the active run must win regardless of position.
    const runs = [
      makeRun({
        id: "run-old-active",
        status: "active",
        started_at: "2026-01-01T10:00:00Z",
        flow: { id: "flow-active", name: "Active Flow" },
      }),
      makeRun({
        id: "run-newer-completed",
        status: "completed",
        started_at: "2026-01-02T10:00:00Z",
        flow: { id: "flow-biz", name: "Older Business Flow" },
      }),
    ];
    expect(pickContactFlow(runs)).toBe("Active Flow");
  });

  it("falls back to the most recent run when no run is active", () => {
    const runs = [
      makeRun({
        id: "run-old",
        status: "completed",
        started_at: "2026-01-01T10:00:00Z",
        flow: { id: "flow-old", name: "Old Flow" },
      }),
      makeRun({
        id: "run-new",
        status: "timed_out",
        started_at: "2026-01-03T10:00:00Z",
        flow: { id: "flow-new", name: "Recent Flow" },
      }),
    ];
    expect(pickContactFlow(runs)).toBe("Recent Flow");
  });

  it("shows the newest active run if multiple actives are returned", () => {
    const runs = [
      makeRun({
        id: "run-a",
        status: "active",
        started_at: "2026-01-01T10:00:00Z",
        flow: { id: "flow-a", name: "Older Active" },
      }),
      makeRun({
        id: "run-b",
        status: "active",
        started_at: "2026-01-02T10:00:00Z",
        flow: { id: "flow-b", name: "Newer Active" },
      }),
    ];
    expect(pickContactFlow(runs)).toBe("Newer Active");
  });
});

describe("pickContactFlowRun", () => {
  it("returns the selected run with its flow id for filter matching", () => {
    const run = pickContactFlowRun([makeRun()]);
    expect(run?.flow?.id).toBe("flow-1");
    expect(run?.flow?.name).toBe("Bali Automation");
  });

  it("returns null when there is nothing to select", () => {
    expect(pickContactFlowRun([])).toBeNull();
    expect(pickContactFlowRun([makeRun({ flow: null })])).toBeNull();
    expect(
      pickContactFlowRun([makeRun({ flow: { id: "f0", name: "" } })])
    ).toBeNull();
  });
});

// ------------------------------------------------------------
// contactFlowRunsQuery — single bounded, account-scoped query
// ------------------------------------------------------------

class FakeQuery {
  table: string;
  selectedCols = "";
  filters: string[] = [];
  orderArgs: unknown = null;
  limitArg: unknown = null;

  constructor(table: string) {
    this.table = table;
  }

  select(cols: unknown) {
    this.selectedCols = String(cols);
    return this;
  }

  eq(k: string, v: unknown) {
    this.filters.push(`eq:${k}=${String(v)}`);
    return this;
  }

  order(key: unknown, opts: unknown) {
    this.orderArgs = [key, opts];
    return this;
  }

  limit(n: unknown) {
    this.limitArg = n;
    return this;
  }
}

function makeFakeClient() {
  const queries: FakeQuery[] = [];
  const client = {
    from(table: string) {
      const q = new FakeQuery(table);
      queries.push(q);
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

describe("contactFlowRunsQuery", () => {
  it("builds a single bounded query joining the flow name", () => {
    const { client, queries } = makeFakeClient();
    contactFlowRunsQuery(client, "acc-1", "contact-1");

    expect(queries).toHaveLength(1);
    const q = queries[0];
    expect(q.table).toBe("flow_runs");
    expect(q.selectedCols).toBe("id, status, started_at, flow:flows(id, name)");
    expect(q.filters).toContain("eq:contact_id=contact-1");
    expect(q.orderArgs).toEqual(["started_at", { ascending: false }]);
    expect(q.limitArg).toBe(5);
  });

  it("is account-scoped: filters by account_id (cross-account proof)", () => {
    const { client, queries } = makeFakeClient();
    contactFlowRunsQuery(client, "acc-1", "contact-1");

    expect(queries[0].filters).toContain("eq:account_id=acc-1");
  });

  it("skips the account_id filter when accountId is not loaded (RLS still scopes)", () => {
    const { client, queries } = makeFakeClient();
    contactFlowRunsQuery(client, null, "contact-1");

    expect(queries[0].filters).not.toContain("eq:account_id=");
  });
});
