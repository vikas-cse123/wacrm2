import { beforeEach, describe, expect, it } from "vitest";

import {
  loadWorkspaceLead,
  normalizeOwnerEmail,
} from "./lead";

type Row = Record<string, unknown>;

const h = {
  flows: [] as Row[],
  flow_runs: [] as Row[],
  contacts: [] as Row[],
  flow_nodes: [] as Row[],
  workspace_fields: [] as Row[],
  workspace_values: [] as Row[],
  profiles: [] as Row[],
  flow_overrides: [] as Row[],
};

function fakeDb() {
  const tables: Record<string, Row[]> = {
    flows: h.flows,
    flow_runs: h.flow_runs,
    contacts: h.contacts,
    flow_nodes: h.flow_nodes,
    workspace_fields: h.workspace_fields,
    workspace_values: h.workspace_values,
    profiles: h.profiles,
    workspace_flow_overrides: h.flow_overrides,
  };
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    q.maybeSingle = async () => ({
      data: (tables[table] ?? []).find((r) => filters.every((f) => f(r))) ?? null,
      error: null,
    });
    q.then = (resolve: (v: unknown) => void) =>
      resolve({
        data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))),
        error: null,
      });
    return q;
  };
  return api;
}

function seed() {
  h.flows = [{ id: "flow-1", account_id: "acct-1" }];
  h.flow_runs = [
    {
      id: "run-1",
      flow_id: "flow-1",
      user_id: "u-creator",
      contact_id: "c-1",
      vars: { travel_date: "2026-12-01", destination: "Goa", adults: "2" },
    },
  ];
  h.contacts = [{ id: "c-1", phone: "+911234567890", name: "Rahul", email: "a@b.co" }];
  h.flow_nodes = [{ node_key: "travel_date", flow_id: "flow-1", config: { header: "Travel Date" } }];
  h.workspace_fields = [
    { id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
    { id: "f-mail", flow_id: "flow-1", name: "Email", field_type: "text" },
  ];
  h.workspace_values = [
    { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
    { flow_run_id: "run-1", field_id: "f-mail", value_text: "x@y.co" },
  ];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-agent", email: " Agent@Acme.com ", full_name: "Agent A" },
  ];
  h.flow_overrides = [];
}

beforeEach(seed);

const args = { accountId: "acct-1", flowId: "flow-1", runId: "run-1" };

describe("normalizeOwnerEmail", () => {
  it("trims and lowercases; blanks become null", () => {
    expect(normalizeOwnerEmail("  Agent@Acme.COM ")).toBe("agent@acme.com");
    expect(normalizeOwnerEmail("   ")).toBeNull();
    expect(normalizeOwnerEmail(null)).toBeNull();
    expect(normalizeOwnerEmail(42)).toBeNull();
  });
});

describe("loadWorkspaceLead", () => {
  it("resolves the lead by flow_run_id with contact, answers, and custom values", async () => {
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead).not.toBeNull();
    expect(lead).toMatchObject({
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      createdBy: "u-creator",
      contact: { name: "Rahul", phone: "+911234567890", email: "a@b.co" },
      assignedUserId: "u-agent",
      assignedUserName: "Agent A",
      assignedOwnerEmail: "agent@acme.com",
      assignmentIssue: null,
    });
    expect(lead?.answers).toContainEqual({
      key: "travel_date",
      label: "Travel Date",
      value: "2026-12-01",
    });
    expect(lead?.custom).toContainEqual({
      id: "f-asg",
      name: "Assigned To",
      value: "u-agent",
      defaultValue: null,
    });
  });

  it("rejects cross-account flows and foreign runs (account isolation)", async () => {
    // Flow belongs to another account.
    h.flows = [{ id: "flow-1", account_id: "acct-2" }];
    expect(await loadWorkspaceLead(fakeDb() as never, args)).toBeNull();
    seed();
    // Run belongs to another flow.
    h.flow_runs[0].flow_id = "flow-9";
    expect(await loadWorkspaceLead(fakeDb() as never, args)).toBeNull();
    seed();
    // Missing run.
    expect(
      await loadWorkspaceLead(fakeDb() as never, { ...args, runId: "nope" })
    ).toBeNull();
  });

  it("missing assignment yields assignment-required", async () => {
    h.workspace_values = h.workspace_values.filter((v) => v.field_id !== "f-asg");
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.assignedUserId).toBeNull();
    expect(lead?.assignedOwnerEmail).toBeNull();
    expect(lead?.assignmentIssue).toBe("assignment-required");
  });

  it("explicit Unassigned yields assignment-required", async () => {
    h.workspace_values = [
      { flow_run_id: "run-1", field_id: "f-asg", value_text: "Unassigned" },
    ];
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.assignmentIssue).toBe("assignment-required");
  });

  it("assigned member without an owner email yields owner-email-missing", async () => {
    h.profiles = [{ account_id: "acct-1", user_id: "u-agent", email: null, full_name: "Agent A" }];
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.assignedUserId).toBe("u-agent");
    expect(lead?.assignedOwnerEmail).toBeNull();
    expect(lead?.assignmentIssue).toBe("owner-email-missing");
  });

  it("legacy display string cannot resolve to an owner email", async () => {
    h.workspace_values = [
      { flow_run_id: "run-1", field_id: "f-asg", value_text: "Agent A" },
    ];
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.assignmentIssue).toBe("owner-email-missing");
    expect(lead?.assignedOwnerEmail).toBeNull();
  });

  it("resolves profiles scoped to the same account only", async () => {
    h.profiles = [
      { account_id: "acct-9", user_id: "u-agent", email: "other@x.co", full_name: "X" },
    ];
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.assignmentIssue).toBe("owner-email-missing");
  });
});

describe("flow Name column identity (Travel CRM prefill key)", () => {
  function nameNodes(): typeof h.flow_nodes {
    return [
      {
        node_key: "start",
        node_type: "start",
        config: { next_node_key: "q0" },
        flow_id: "flow-1",
      },
      {
        node_key: "q0",
        node_type: "collect_input",
        config: {
          prompt_text: "What is your name?",
          var_key: "full_name",
          sheet_column_name: "Name",
          next_node_key: "end",
        },
        flow_id: "flow-1",
      },
      { node_key: "end", node_type: "end", config: {}, flow_id: "flow-1" },
    ];
  }

  it("resolves the exact flow Name column key via Workspace derivation", async () => {
    h.flows = [{ id: "flow-1", account_id: "acct-1", entry_node_id: "start" }];
    h.flow_nodes = nameNodes();
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.flowNameColumnKey).toBe("full_name");
  });

  it("is null when the flow has no Name column (legacy synonym path)", async () => {
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.flowNameColumnKey).toBeNull();
  });
});
describe("ad-source platform (Lead Source icon signal)", () => {
  it("derives instagram from the contact source_url", async () => {
    h.contacts = [
      {
        id: "c-1",
        phone: "+911234567890",
        name: "Rahul",
        email: "a@b.co",
        source_url: "https://instagram.com/p/abc123",
      },
    ];
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.adSourcePlatform).toBe("instagram");
  });

  it("derives facebook from fb.me links", async () => {
    h.contacts = [
      {
        id: "c-1",
        phone: "+911234567890",
        name: "Rahul",
        email: "a@b.co",
        source_url: "https://fb.me/xyz",
      },
    ];
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.adSourcePlatform).toBe("facebook");
  });

  it("is null for missing, unparseable, or non-social URLs", async () => {
    for (const source_url of [undefined, "", "not a url", "https://example.com/landing"]) {
      const row: Record<string, unknown> = {
        id: "c-1",
        phone: "+911234567890",
        name: "Rahul",
        email: "a@b.co",
      };
      if (source_url !== undefined) row.source_url = source_url;
      h.contacts = [row];
      const lead = await loadWorkspaceLead(fakeDb() as never, args);
      expect(lead?.adSourcePlatform).toBeNull();
    }
  });

  it("is null when the run has no contact", async () => {
    h.flow_runs = [
      {
        id: "run-1",
        flow_id: "flow-1",
        user_id: "u-creator",
        contact_id: null,
        vars: {},
      },
    ];
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.adSourcePlatform).toBeNull();
  });
});

describe("Workspace flow overrides (current values for Travel CRM)", () => {
  function answerNodes(): void {
    h.flows = [{ id: "flow-1", account_id: "acct-1", entry_node_id: "start" }];
    h.flow_nodes = [
      { node_key: "start", node_type: "start", flow_id: "flow-1", config: {} },
      {
        node_key: "adults",
        node_type: "collect_input",
        flow_id: "flow-1",
        config: { prompt_text: "How many adults?", var_key: "adults" },
      },
    ];
    h.flow_runs = [
      {
        id: "run-1",
        flow_id: "flow-1",
        user_id: "u-creator",
        contact_id: "c-1",
        vars: { adults: "2" },
      },
    ];
  }

  function override(fieldKey: string, value: string | null): void {
    h.flow_overrides = [
      {
        account_id: "acct-1",
        flow_id: "flow-1",
        flow_run_id: "run-1",
        field_key: fieldKey,
        value_text: value,
      },
    ];
  }

  it("applies the override answer while keeping vars intact", async () => {
    answerNodes();
    override("adults", "3");
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.answers).toContainEqual({
      key: "adults",
      label: "adults",
      value: "3",
    });
    // Original submission record untouched (history preserved).
    expect(h.flow_runs[0].vars).toEqual({ adults: "2" });
  });

  it("explicit empty override reads as a cleared (missing) answer", async () => {
    answerNodes();
    override("adults", null);
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.answers).toContainEqual({
      key: "adults",
      label: "adults",
      value: null,
    });
  });

  it("ignores overrides for keys outside the live answer columns", async () => {
    answerNodes();
    override("deleted_question", "X");
    const lead = await loadWorkspaceLead(fakeDb() as never, args);
    expect(lead?.answers).toEqual([
      expect.objectContaining({ key: "adults", value: "2" }),
    ]);
  });
});
