import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const SECRET = "wacrm_secret_123";
const BASE = "https://crm.example.com";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-1",
  flows: [] as Row[],
  flow_runs: [] as Row[],
  contacts: [] as Row[],
  flow_nodes: [] as Row[],
  workspace_fields: [] as Row[],
  workspace_values: [] as Row[],
  profiles: [] as Row[],
  links: [] as Row[],
  flowSettings: [] as Row[],
  travelCalls: [] as Array<{ url: string; body: unknown }>,
  lookupsOverride: null as null | Record<string, unknown>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

function storeFor(table: string): Row[] {
  switch (table) {
    case "flows":
      return h.flows;
    case "flow_runs":
      return h.flow_runs;
    case "contacts":
      return h.contacts;
    case "flow_nodes":
      return h.flow_nodes;
    case "workspace_fields":
      return h.workspace_fields;
    case "workspace_values":
      return h.workspace_values;
    case "profiles":
      return h.profiles;
    case "travel_crm_lead_links":
      return h.links;
    case "travel_crm_flow_settings":
      return h.flowSettings;
    default:
      return [];
  }
}

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    const matched = () => storeFor(table).filter((r) => filters.every((f) => f(r)));
    q.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    q.single = async () => {
      const hit = matched()[0] ?? null;
      return hit
        ? { data: hit, error: null }
        : { data: null, error: { message: "no row", code: "PGRST116" } };
    };
    q.then = (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null });
    q.insert = (obj: Row) => {
      const rows = storeFor(table);
      const dup = rows.find(
        (r) =>
          r.account_id === obj.account_id &&
          r.flow_run_id === obj.flow_run_id &&
          r.integration_type === obj.integration_type,
      );
      if (dup) {
        const err = { message: "duplicate", code: "23505" };
        return { select: () => ({ single: async () => ({ data: null, error: err }) }) };
      }
      const created = { id: `link-${rows.length + 1}`, external_lead_id: null, ...obj };
      rows.push(created);
      return {
        select: () => ({ single: async () => ({ data: created, error: null }) }),
      };
    };
    q.update = (patch: Row) => {
      const chain: Record<string, unknown> = {};
      chain.eq = () => chain;
      chain.then = (resolve: (v: unknown) => void) => {
        for (const r of matched()) Object.assign(r, patch);
        resolve({ error: null });
      };
      return chain;
    };
    return q;
  };
  return api;
}

const LOOKUPS = {
  leadSources: [{ value: "WHATSAPP", label: "WhatsApp" }],
  leadTypes: [{ value: "FRESH", label: "Fresh" }],
  leadStages: [{ value: "NEW_LEAD", label: "New Lead" }],
  serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
};

function mockTravel() {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/integrations/wacrm/lookups")) {
      const data = h.lookupsOverride ?? LOOKUPS;
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    }
    if (u.endsWith("/api/integrations/wacrm/leads")) {
      const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
      h.travelCalls.push({ url: u, body });
      return new Response(
        JSON.stringify({ success: true, data: { leadId: "tcrm-xyz", alreadyExists: false } }),
        { status: 201 },
      );
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch);
}

const { POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/integrations/travel-crm/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const WA_NAME = "राधे राधे🙏🌸";
const FLOW_NAME = "Ritika Singh";
const WA_PHONE = "+918917378479";

function nameNodes(): Row[] {
  return [
    {
      node_key: "start",
      node_type: "start",
      flow_id: "flow-1",
      config: { next_node_key: "q0" },
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      node_key: "q0",
      node_type: "collect_input",
      flow_id: "flow-1",
      config: {
        prompt_text: "What is your name?",
        var_key: "full_name",
        sheet_column_name: "Name",
        next_node_key: "q1",
      },
      created_at: "2026-01-01T00:00:01.000Z",
    },
    {
      node_key: "q1",
      node_type: "collect_input",
      flow_id: "flow-1",
      config: {
        prompt_text: "Travel date?",
        var_key: "travel_date",
        next_node_key: "end",
      },
      created_at: "2026-01-01T00:00:02.000Z",
    },
    {
      node_key: "end",
      node_type: "end",
      flow_id: "flow-1",
      config: {},
      created_at: "2026-01-01T00:00:03.000Z",
    },
  ];
}

function seedWithName() {
  h.flows = [{ id: "flow-1", account_id: "acct-1", entry_node_id: "start" }];
  h.flow_nodes = nameNodes();
  h.flow_runs = [
    {
      id: "run-1",
      flow_id: "flow-1",
      user_id: "u-creator",
      contact_id: "c-1",
      vars: {
        full_name: FLOW_NAME,
        travel_date: "2026-12-01",
        destination: "Goa",
        city: "Panaji",
        nights: "3",
        adults: "2",
        service: "Flight",
      },
    },
  ];
  h.contacts = [{ id: "c-1", phone: WA_PHONE, name: WA_NAME, email: "a@b.co" }];
  h.workspace_fields = [
    { id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
    { id: "f-cn", flow_id: "flow-1", name: "Customer Name", field_type: "text" },
    { id: "f-pn", flow_id: "flow-1", name: "Parent Name", field_type: "text" },
    { id: "f-fn", flow_id: "flow-1", name: "Full Name", field_type: "text" },
  ];
  h.workspace_values = [
    { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
    { flow_run_id: "run-1", field_id: "f-cn", value_text: "Decoy Customer" },
    { flow_run_id: "run-1", field_id: "f-pn", value_text: "Decoy Parent" },
    { flow_run_id: "run-1", field_id: "f-fn", value_text: "Decoy Full" },
  ];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-agent", email: "agent@acme.com", full_name: "Agent" },
  ];
  h.links = [];
  h.flowSettings = [];
}

function seedWithoutName() {
  seedWithName();
  h.flow_nodes = [
    {
      node_key: "start",
      node_type: "start",
      flow_id: "flow-1",
      config: { next_node_key: "q1" },
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      node_key: "q1",
      node_type: "collect_input",
      flow_id: "flow-1",
      config: { prompt_text: "Travel date?", var_key: "travel_date", next_node_key: "end" },
      created_at: "2026-01-01T00:00:02.000Z",
    },
    {
      node_key: "end",
      node_type: "end",
      flow_id: "flow-1",
      config: {},
      created_at: "2026-01-01T00:00:03.000Z",
    },
  ];
  const vars = { ...(h.flow_runs[0].vars as Record<string, unknown>) };
  delete vars.full_name;
  h.flow_runs[0].vars = vars;
}

const FUNNEL = { leadSource: "WHATSAPP", leadType: "FRESH", leadStage: "NEW_LEAD" };

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.travelCalls = [];
  h.lookupsOverride = null;
  mockTravel();
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TEST 1+3. flow Name column prefills Travel CRM Name (WhatsApp ignored, no ambiguity)", () => {
  it("prefill.customerName is the flow answer, never the WhatsApp name", async () => {
    seedWithName();
    h.workspace_values = h.workspace_values.filter((v) => v.field_id === "f-asg");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      code: string;
      mapping: { missing: string[]; ambiguous: Array<{ field: string }> };
      prefill: { customerName: unknown; phone: unknown };
    };
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.prefill.customerName).toBe(FLOW_NAME);
    expect(json.prefill.customerName).not.toBe(WA_NAME);
    expect(json.mapping.ambiguous.map((a) => a.field)).not.toContain("customerName");
    expect(h.travelCalls).toHaveLength(0);
  });
});

describe("TEST 2. no flow Name column falls back to WhatsApp name", () => {
  it("prefill.customerName is the WhatsApp contact name", async () => {
    seedWithoutName();
    h.contacts = [{ id: "c-1", phone: "+911234567890", name: "nikitajoshi464", email: "a@b.co" }];
    h.workspace_values = h.workspace_values.filter((v) => v.field_id === "f-asg");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      code: string;
      prefill: { customerName: unknown };
    };
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.prefill.customerName).toBe("nikitajoshi464");
  });
});

describe("TEST 4. other name-containing fields never win", () => {
  it("Customer/Parent/Full Name customs are ignored next to the exact column", async () => {
    seedWithName();
    const res = await POST(
      post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ customerName: FLOW_NAME });
  });
});

describe("TEST 5+6+7. phone prefill and agent edits", () => {
  it("phone prefills from the WhatsApp contact phone", async () => {
    seedWithName();
    h.workspace_values = h.workspace_values.filter((v) => v.field_id === "f-asg");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as { prefill: { phone: unknown } };
    expect(json.prefill.phone).toBe(WA_PHONE);
  });

  it("edited Name sends as customerName; edited Phone sends as phone", async () => {
    seedWithName();
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, customerName: "Edited Name", phone: "+911111111111" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      customerName: "Edited Name",
      phone: "+911111111111",
    });
  });

  it("unedited flow creates with the flow answer as customerName", async () => {
    seedWithName();
    const res = await POST(
      post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      customerName: FLOW_NAME,
      phone: WA_PHONE,
    });
  });
});
