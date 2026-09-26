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
  flowOverrides: [] as Row[],
  travelCalls: [] as Array<{ url: string; body: unknown }>,
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
    case "workspace_flow_overrides":
      return h.flowOverrides;
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
    q.then = (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null });
    q.insert = (obj: Row) => {
      storeFor(table).push({ ...obj });
      return { select: () => ({ single: async () => ({ data: obj, error: null }) }) };
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
      return new Response(JSON.stringify({ success: true, data: LOOKUPS }), { status: 200 });
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

function seed() {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
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
      vars: {
        travel_date: "2026-12-01",
        destination: "Goa",
        city: "Panaji",
        nights: "3",
        adults: "2",
        service: "Flight",
      },
    },
  ];
  h.contacts = [{ id: "c-1", phone: "+911234567890", name: "Rahul", email: "a@b.co" }];
  h.workspace_fields = [{ id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" }];
  h.workspace_values = [{ flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" }];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-agent", email: "agent@acme.com", full_name: "Agent" },
  ];
  h.links = [];
  h.flowSettings = [];
  h.flowOverrides = [];
  h.travelCalls = [];
}

const FUNNEL = { leadSource: "WHATSAPP", leadType: "FRESH", leadStage: "NEW_LEAD" };

beforeEach(() => {
  seed();
  mockTravel();
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Travel CRM uses current Workspace values (overrides win)", () => {
  it("19. an agent override reaches the payload instead of the original", async () => {
    h.flowOverrides = [
      {
        account_id: "acct-1",
        flow_id: "flow-1",
        flow_run_id: "run-1",
        field_key: "adults",
        value_text: "3",
      },
    ];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ adults: 3 });
  });

  it("20. after restore, Travel CRM uses the original value again", async () => {
    h.flowOverrides = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ adults: 2 });
  });

  it("21. original flow-run vars are unchanged by override reads", async () => {
    h.flowOverrides = [
      {
        account_id: "acct-1",
        flow_id: "flow-1",
        flow_run_id: "run-1",
        field_key: "adults",
        value_text: "3",
      },
    ];
    await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(h.flow_runs[0].vars).toMatchObject({ adults: "2" });
  });
});
