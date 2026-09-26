import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRAVEL_CRM_BASE_URL,
  getTravelCrmConfig,
  travelCrmLeadUrl,
} from "./config";

describe("getTravelCrmConfig", () => {
  it("defaults the base URL and reports unconfigured secret", () => {
    expect(getTravelCrmConfig({})).toEqual({
      baseUrl: DEFAULT_TRAVEL_CRM_BASE_URL,
      secret: null,
    });
  });

  it("trims and normalizes configured values", () => {
    expect(
      getTravelCrmConfig({
        TRAVEL_CRM_BASE_URL: "https://crm.example.com///",
        TRAVEL_CRM_INTEGRATION_SECRET: "  wacrm_abc123  ",
      }),
    ).toEqual({ baseUrl: "https://crm.example.com", secret: "wacrm_abc123" });
  });

  it("treats blank secret as unconfigured", () => {
    expect(
      getTravelCrmConfig({ TRAVEL_CRM_INTEGRATION_SECRET: "   " }).secret,
    ).toBeNull();
  });
});

describe("travelCrmLeadUrl", () => {
  it("builds the lead-detail URL without inventing patterns", () => {
    expect(
      travelCrmLeadUrl("https://app.travelagencycrm.in", "abc-123"),
    ).toBe("https://app.travelagencycrm.in/queries/abc-123");
  });
});
