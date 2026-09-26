import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  normalizeDepartureDefaults,
  validateDepartureCatalog,
} from "./departures";
import {
  DEPARTURE_COUNTRIES,
  departureCityOptions,
  INDIAN_DEPARTURE_CITIES,
  isDepartureCityInCountry,
  isDepartureCountry,
  OTHER_DEPARTURE_CITIES,
} from "./departure-catalog";

// ---------------------------------------------------------------------------
// Focused tests: Travel CRM departure defaults.
// 1. Country list available from the copied Travel CRM source.
// 2. City list depends on country (India vs curated, like the form).
// ---------------------------------------------------------------------------

describe("1. country list comes from the copied Travel CRM source", () => {
  it("carries all 250 world-countries names", () => {
    expect(DEPARTURE_COUNTRIES).toHaveLength(250);
    expect(DEPARTURE_COUNTRIES).toContain("India");
    expect(DEPARTURE_COUNTRIES).toContain("United Arab Emirates");
    expect(DEPARTURE_COUNTRIES).toContain("United States");
    expect(new Set(DEPARTURE_COUNTRIES).size).toBe(250);
  });

  it("isDepartureCountry matches catalog names case-insensitively", () => {
    expect(isDepartureCountry("India")).toBe(true);
    expect(isDepartureCountry("  united arab emirates ")).toBe(true);
    expect(isDepartureCountry("Atlantis")).toBe(false);
    expect(isDepartureCountry("")).toBe(false);
  });
});

describe("2. city list depends on country (Travel CRM form rule)", () => {
  it("India yields the INDIAN departure cities with airport labels", () => {
    const cities = departureCityOptions("India");
    expect(cities.length).toBeGreaterThan(50);
    expect(cities).toContainEqual({ value: "Delhi", label: "Delhi (DEL)" });
    expect(cities).toContainEqual({ value: "Mumbai", label: "Mumbai (BOM)" });
    expect(INDIAN_DEPARTURE_CITIES.length).toBeGreaterThan(50);
  });

  it("other countries yield the curated cities", () => {
    const cities = departureCityOptions("United Arab Emirates");
    expect(cities).toEqual(OTHER_DEPARTURE_CITIES);
    expect(cities.map((c) => c.value)).toContain("Dubai");
  });

  it("isDepartureCityInCountry enforces belonging per country", () => {
    expect(isDepartureCityInCountry("India", "Delhi")).toBe(true);
    expect(isDepartureCityInCountry("india", "delhi")).toBe(true);
    expect(isDepartureCityInCountry("India", "Dubai")).toBe(false);
    expect(isDepartureCityInCountry("India", "Atlantis")).toBe(false);
    expect(isDepartureCityInCountry("United Arab Emirates", "Dubai")).toBe(true);
    expect(isDepartureCityInCountry("United Arab Emirates", "")).toBe(false);
  });
});

describe("normalizeDepartureDefaults (storage shape)", () => {
  it("accepts country + city catalog values", () => {
    expect(
      normalizeDepartureDefaults({ country: "India", city: "Delhi" }),
    ).toEqual({ country: "India", city: "Delhi" });
  });

  it("accepts country-only (city null)", () => {
    expect(normalizeDepartureDefaults({ country: "India", city: "" })).toEqual({
      country: "India",
      city: null,
    });
  });

  it("empty/absent normalizes to null (cleared — dialog stays empty)", () => {
    expect(normalizeDepartureDefaults(null)).toBeNull();
    expect(normalizeDepartureDefaults(undefined)).toBeNull();
    expect(normalizeDepartureDefaults({ country: "", city: "" })).toBeNull();
    expect(normalizeDepartureDefaults({})).toBeNull();
  });

  it("rejects a city without a country and non-objects", () => {
    expect(() =>
      normalizeDepartureDefaults({ country: "", city: "Delhi" }),
    ).toThrow();
    expect(() => normalizeDepartureDefaults("India")).toThrow();
    expect(() => normalizeDepartureDefaults([1])).toThrow();
  });
});

describe("validateDepartureCatalog (copied Travel CRM data)", () => {
  it("accepts India/Delhi and UAE/Dubai", () => {
    expect(() =>
      validateDepartureCatalog({ country: "India", city: "Delhi" }),
    ).not.toThrow();
    expect(() =>
      validateDepartureCatalog({ country: "United Arab Emirates", city: "Dubai" }),
    ).not.toThrow();
  });

  it("accepts country-only defaults", () => {
    expect(() =>
      validateDepartureCatalog({ country: "India", city: null }),
    ).not.toThrow();
  });

  it("11. rejects unknown countries, unknown cities, and mismatched pairs", () => {
    expect(() =>
      validateDepartureCatalog({ country: "Atlantis", city: null }),
    ).toThrow(/country/i);
    expect(() =>
      validateDepartureCatalog({ country: "India", city: "Atlantis" }),
    ).toThrow(/city/i);
    expect(() =>
      validateDepartureCatalog({ country: "India", city: "Dubai" }),
    ).toThrow(/belong/i);
  });
});

describe("4. no hardcoded country/city catalog outside the copied source", () => {
  it("only departure-catalog.ts carries place names; logic files reference the copy", () => {
    const logicFiles = [
      `${process.cwd()}/src/lib/integrations/travel-crm/departures.ts`,
      `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
      `${process.cwd()}/src/app/api/flows/[id]/travel-crm-settings/route.ts`,
      `${process.cwd()}/src/app/api/integrations/travel-crm/leads/route.ts`,
    ];
    for (const file of logicFiles) {
      const text = readFileSync(file, "utf8");
      for (const hardcoded of [
        "Marina Bay",
        "Sentosa",
        "Ahmedabad",
        "Bengaluru",
        "Vijayawada",
      ]) {
        expect(text, `${file} must not hardcode ${hardcoded}`).not.toContain(hardcoded);
      }
    }
    // Countries as bare words (India/Delhi/Dubai) legitimately appear
    // in comments/tests — the catalog file itself is the single copy.
    const catalog = readFileSync(
      `${process.cwd()}/src/lib/integrations/travel-crm/departure-catalog.ts`,
      "utf8",
    );
    expect(catalog).toContain('"India"');
    expect(catalog).toContain('"Delhi"');
  });

  it("catalog values match the Travel CRM sources exactly", () => {
    // Spot-checks against the audited Travel CRM form values.
    expect(INDIAN_DEPARTURE_CITIES).toContainEqual({
      value: "Delhi",
      label: "Delhi (DEL)",
    });
    expect(INDIAN_DEPARTURE_CITIES).toContainEqual({
      value: "Mumbai",
      label: "Mumbai (BOM)",
    });
    expect(OTHER_DEPARTURE_CITIES.map((c) => c.value)).toEqual([
      "Delhi",
      "Mumbai",
      "Bengaluru",
      "Dubai",
      "Bangkok",
      "Singapore",
      "Bali",
      "Malé",
      "London",
      "Paris",
    ]);
  });
});
