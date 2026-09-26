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
  leadTypes: [
    { value: "FRESH", label: "Fresh" },
    { value: "HOT", label: "Hot" },
    { value: "WARM", label: "Warm" },
    { value: "COLD", label: "Cold" },
    { value: "PROSPECT", label: "Prospect" },
  ],
  leadStages: [
    { value: "NEW_LEAD", label: "New Lead" },
    { value: "CONTACTED", label: "Contacted" },
    { value: "QUALIFIED", label: "Qualified" },
  ],
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

function seed() {
  h.flows = [{ id: "flow-1", account_id: "acct-1" }];
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
  h.contacts = [{ id: "c-1", phone: "+911234567890", name: "Rahul Sharma", email: "a@b.co" }];
  h.flow_nodes = [];
  h.workspace_fields = [{ id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" }];
  h.workspace_values = [{ flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" }];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-agent", email: "agent@acme.com", full_name: "Agent" },
  ];
  h.links = [];
  h.flowSettings = [];
}

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.travelCalls = [];
  h.lookupsOverride = null;
  seed();
  mockTravel();
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Type/Stage business defaults in Travel CRM lead creation", () => {
  it("7. payload receives Fresh/New Lead when nothing was previously set", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        // Received stays explicitly chosen (it has no default);
        // Type/Stage fall back to Fresh/New Lead.
        overrides: { leadSource: "WHATSAPP" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({
      leadType: "FRESH",
      leadStage: "NEW_LEAD",
    });
  });

  it("prefill carries the resolved defaults for the pre-selected dialog", async () => {
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      code: string;
      prefill: { leadType: unknown; leadStage: unknown };
    };
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.prefill.leadType).toBe("FRESH");
    expect(json.prefill.leadStage).toBe("NEW_LEAD");
    expect(h.travelCalls).toHaveLength(0);
  });

  it("8. user-selected Type/Stage win over the defaults", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { leadSource: "WHATSAPP", leadType: "HOT", leadStage: "QUALIFIED" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      leadType: "HOT",
      leadStage: "QUALIFIED",
    });
  });

  it("unresolvable defaults still prefill the dialog from the row, but never reach the payload", async () => {
    h.lookupsOverride = {
      ...LOOKUPS,
      leadTypes: [{ value: "HOT", label: "Hot" }],
      leadStages: [{ value: "CONTACTED", label: "Contacted" }],
    };
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      code: string;
      prefill: { leadType: unknown; leadStage: unknown };
    };
    expect(json.code).toBe("MISSING_FIELDS");
    // The dialog opens showing the Workspace row defaults even
    // though live lookups lack a match for them.
    expect(json.prefill.leadType).toBe("Fresh");
    expect(json.prefill.leadStage).toBe("New Lead");
    expect(h.travelCalls).toHaveLength(0);
    // …but submitting those unresolvable labels never invents a
    // payload enum: rejected with no side effects, Travel CRM
    // validates authoritatively.
    const bad = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { leadType: "Fresh", leadStage: "New Lead" },
      }),
    );
    const badJson = (await bad.json()) as Record<string, unknown>;
    expect(badJson).toMatchObject({ success: false, code: "INVALID_OVERRIDES" });
    expect(h.travelCalls).toHaveLength(0);
    expect(badJson).not.toHaveProperty("workspaceSync");
  });

  it("9. lead creation performs zero writes to Workspace settings/values", async () => {
    const settingsBefore = JSON.stringify(h.flowSettings);
    await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(JSON.stringify(h.flowSettings)).toBe(settingsBefore);
    expect(h.workspace_fields).toHaveLength(1);
    expect(h.workspace_values).toHaveLength(1);
  });
});
