import { describe, expect, it, vi } from "vitest";

import {
  createTravelCrmLead,
  fetchTravelCrmLookups,
  TravelCrmError,
  type TravelCrmCreatePayload,
} from "./client";

const SECRET = "wacrm_test_secret_value";
const BASE = "https://crm.example.com";

function payload(): TravelCrmCreatePayload {
  return {
    wacrmAccountId: "acct-1",
    flowRunId: "run-1",
    customerName: "Rahul",
    phone: "+911234567890",
    leadSource: "WHATSAPP",
    leadType: "HOT",
    leadStage: "NEW_LEAD",
    assignedToEmail: "agent@acme.com",
    travelStartDate: "2026-12-01",
    adults: 2,
    services: ["FLIGHT"],
    itinerary: [{ country: "Thailand", destination: "Bangkok", nights: 3, sequence: 1 }],
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createTravelCrmLead", () => {
  it("sends the exact contract with the Bearer secret and parses success", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(201, {
        success: true,
        data: { leadId: "tcrm-1", alreadyExists: false },
      });
    }) as typeof fetch;
    const out = await createTravelCrmLead(BASE, SECRET, payload(), fake);
    expect(out).toEqual({ leadId: "tcrm-1", alreadyExists: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/integrations/wacrm/leads`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    const sent = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      customerName: "Rahul",
      assignedToEmail: "agent@acme.com",
      services: ["FLIGHT"],
    });
  });

  it("maps 401/400/409/timeout/network to stable codes", async () => {
    const at = async (status: number, body: unknown) =>
      createTravelCrmLead(
        BASE,
        SECRET,
        payload(),
        (async () => jsonResponse(status, body)) as typeof fetch,
      ).catch((e) => e);
    expect(((await at(401, { success: false, error: { code: "UNAUTHORIZED" } })) as TravelCrmError).code).toBe(
      "TRAVEL_CRM_UNAUTHORIZED",
    );
    const assignee = (await at(400, {
      success: false,
      error: { code: "ASSIGNED_USER_NOT_FOUND", message: "No match." },
    })) as TravelCrmError;
    expect(assignee.code).toBe("ASSIGNED_USER_NOT_FOUND");
    const bad = (await at(400, {
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Bad.", fields: { phone: ["short"] } },
    })) as TravelCrmError;
    expect(bad.code).toBe("TRAVEL_CRM_VALIDATION_FAILED");
    expect(bad.fields).toEqual({ phone: ["short"] });
    expect(
      ((await at(409, { success: false, error: { code: "CONFLICT" } })) as TravelCrmError).code,
    ).toBe("TRAVEL_CRM_CONFLICT");
    const down = (await createTravelCrmLead(
      BASE,
      SECRET,
      payload(),
      (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    ).catch((e) => e)) as TravelCrmError;
    expect(down.code).toBe("TRAVEL_CRM_UNAVAILABLE");
  });

  it("rejects unreadable success bodies instead of inventing an ID", async () => {
    const err = (await createTravelCrmLead(
      BASE,
      SECRET,
      payload(),
      (async () => jsonResponse(201, { success: true, data: {} })) as typeof fetch,
    ).catch((e) => e)) as TravelCrmError;
    expect(err.code).toBe("TRAVEL_CRM_ERROR");
  });

  it("never leaks the secret in errors", async () => {
    const err = (await createTravelCrmLead(
      BASE,
      SECRET,
      payload(),
      (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    ).catch((e) => e)) as Error;
    expect(`${err.message}${err.stack ?? ""}`).not.toContain(SECRET);
  });
});

describe("fetchTravelCrmLookups", () => {
  it("returns lookup data with the Bearer credential", async () => {
    const out = await fetchTravelCrmLookups(
      BASE,
      SECRET,
      (async () =>
        jsonResponse(200, { success: true, data: { leadSources: [] } })) as typeof fetch,
    );
    expect(out).toEqual({ leadSources: [] });
  });

  it("maps auth failures without leaking the secret", async () => {
    const err = (await fetchTravelCrmLookups(
      BASE,
      SECRET,
      (async () => jsonResponse(401, {})) as typeof fetch,
    ).catch((e) => e)) as TravelCrmError;
    expect(err.code).toBe("TRAVEL_CRM_UNAUTHORIZED");
    expect(err.message).not.toContain(SECRET);
  });
});
