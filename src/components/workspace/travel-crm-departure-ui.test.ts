import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Departure Defaults UI wiring — the Travel CRM Settings dialog
// carries a Departure Defaults section driven by the COPIED Travel
// CRM catalog (never fetched, never hardcoded locally). Source-
// pattern assertions (repo convention): the dialog cannot be
// interacted with under node SSR.
// ---------------------------------------------------------------------------

const root = process.cwd();
const settingsSrc = readFileSync(
  `${root}/src/components/workspace/travel-crm-settings.tsx`,
  "utf8",
);

describe("Departure Defaults section (Workspace → Travel CRM Settings)", () => {
  it("renders country-first, city-second selects with dependent options", () => {
    expect(settingsSrc).toContain("Departure Defaults");
    expect(settingsSrc).toContain('aria-label="Departure Country"');
    expect(settingsSrc).toContain('aria-label="Departure City"');
    // City list depends on the selected country (copied catalog).
    expect(settingsSrc).toContain("departureCityOptions(departureCountry)");
    // City waits for a country first.
    expect(settingsSrc).toContain("Pick country first");
    expect(settingsSrc).toContain("disabled={!departureCountry}");
  });

  it("5. changing country clears an incompatible city (shared rule)", () => {
    expect(settingsSrc).toContain("isDepartureCityInCountry(value, prev)");
  });

  it("loads and saves departure per flow without touching services/itinerary logic", () => {
    expect(settingsSrc).toContain("json as { departure?: unknown }");
    expect(settingsSrc).toContain("body: JSON.stringify({ services: selected, itinerary, departure })");
  });

  it("uses the copied catalog — no fetch, no fake options", () => {
    expect(settingsSrc).toContain("departure-catalog");
    expect(settingsSrc).toContain("DEPARTURE_COUNTRIES");
    expect(settingsSrc).not.toContain("Loading Travel CRM countries");
  });

  it("rejects a city without a country before sending", () => {
    expect(settingsSrc).toContain("Select a departure country for the city.");
  });
});
