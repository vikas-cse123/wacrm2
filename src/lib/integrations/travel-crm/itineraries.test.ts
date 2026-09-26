import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  buildItineraryLookups,
  citiesForDestination,
  defaultsToDraftItinerary,
  draftToItineraryDefaults,
  extractCityOptions,
  extractDestinationOptions,
  isCompatibleCity,
  normalizeItineraryDefaults,
  validateNightsInput,
} from "./itineraries";

// ---------------------------------------------------------------------------
// Focused tests: Travel CRM Itinerary Defaults (lib layer).
// Covers: normalize/save shape, nights validation, stable IDs,
// lookup extraction from Travel CRM (never hardcoded), city
// dependency, destination-change clearing, draft/payload mapping.
// ---------------------------------------------------------------------------

describe("normalizeItineraryDefaults (storage shape)", () => {
  it("1. accepts per-flow rows with stable IDs + nights", () => {
    expect(
      normalizeItineraryDefaults([
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        { destination: "dest-sg", city: "city-sentosa", nights: "3" },
      ]),
    ).toEqual([
      { destination: "dest-sg", city: "city-marina", nights: 4 },
      { destination: "dest-sg", city: "city-sentosa", nights: 3 },
    ]);
  });

  it("drops empty rows so zero rows overall is savable", () => {
    expect(normalizeItineraryDefaults([])).toEqual([]);
    expect(
      normalizeItineraryDefaults([
        { destination: "", city: "", nights: "" },
        { destination: "  ", city: "", nights: "" },
      ]),
    ).toEqual([]);
  });

  it("drops rows missing destination/city but keeps complete ones", () => {
    expect(
      normalizeItineraryDefaults([
        { destination: "", city: "city-x", nights: 2 },
        { destination: "dest-a", city: "city-a", nights: 2 },
      ]),
    ).toEqual([{ destination: "dest-a", city: "city-a", nights: 2 }]);
  });

  it("rejects non-lists and non-object rows", () => {
    expect(() => normalizeItineraryDefaults("x" as unknown as never)).toThrow();
    expect(() => normalizeItineraryDefaults([42] as unknown as never)).toThrow();
  });
});

describe("11. nights validation", () => {
  it("accepts positive whole numbers only", () => {
    expect(validateNightsInput(4)).toBeNull();
    expect(validateNightsInput("3")).toBeNull();
    expect(validateNightsInput(" 2 ")).toBeNull();
  });

  it("rejects zero, negatives, fractions, text, blanks", () => {
    for (const v of [0, -1, 1.5, "0", "-2", "2.5", "two", "", "  "]) {
      expect(validateNightsInput(v)).not.toBeNull();
    }
  });

  it("normalize throws on invalid nights in a non-empty row", () => {
    expect(() =>
      normalizeItineraryDefaults([{ destination: "d", city: "c", nights: 0 }]),
    ).toThrow();
    expect(() =>
      normalizeItineraryDefaults([{ destination: "d", city: "c", nights: "two" }]),
    ).toThrow();
  });
});

describe("8. destination lookup comes from Travel CRM (never hardcoded)", () => {
  it("extracts destinations from the live lookups payload", () => {
    const lookups = {
      destinations: [
        { value: "dest-sg", label: "Singapore" },
        { value: "dest-bali", label: "Bali" },
      ],
    };
    expect(extractDestinationOptions(lookups)).toEqual([
      { value: "dest-sg", label: "Singapore" },
      { value: "dest-bali", label: "Bali" },
    ]);
  });

  it("supports countries-shaped payloads and id/name objects", () => {
    expect(
      extractDestinationOptions({
        countries: [{ id: "c-sg", name: "Singapore" }],
      }),
    ).toEqual([{ value: "c-sg", label: "Singapore" }]);
    expect(extractDestinationOptions({})).toEqual([]);
    expect(extractDestinationOptions(null)).toEqual([]);
  });

  it("contains no hardcoded destination values in WACRM source", () => {
    const lib = readFileSync(`${process.cwd()}/src/lib/integrations/travel-crm/itineraries.ts`, "utf8");
    for (const hardcoded of ["Singapore", "Marina Bay", "Sentosa"]) {
      expect(lib).not.toContain(hardcoded);
    }
    const settings = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
      "utf8",
    );
    for (const hardcoded of ["Singapore", "Marina Bay", "Sentosa"]) {
      expect(settings).not.toContain(hardcoded);
    }
    const action = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    for (const hardcoded of ["Singapore", "Marina Bay", "Sentosa"]) {
      expect(action).not.toContain(hardcoded);
    }
  });
});

describe("9. city options depend on the selected destination", () => {
  const lookups = {
    destinations: [
      { value: "dest-sg", label: "Singapore" },
      { value: "dest-bali", label: "Bali" },
    ],
    cities: [
      { value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" },
      { value: "city-sentosa", label: "Sentosa Island", destinationValue: "dest-sg" },
      { value: "city-kuta", label: "Kuta", destinationValue: "dest-bali" },
    ],
  };

  it("extracts cities with parent linkage", () => {
    const cities = extractCityOptions(lookups);
    expect(cities).toHaveLength(3);
    expect(cities.find((c) => c.value === "city-marina")).toMatchObject({
      destinationValue: "dest-sg",
    });
  });

  it("filters cities per destination", () => {
    const cities = extractCityOptions(lookups);
    expect(citiesForDestination(cities, "dest-sg").map((c) => c.value).sort()).toEqual(
      ["city-marina", "city-sentosa"],
    );
    expect(citiesForDestination(cities, "dest-bali").map((c) => c.value)).toEqual([
      "city-kuta",
    ]);
  });

  it("builds citiesByDestination for the dialog", () => {
    const built = buildItineraryLookups(lookups);
    expect(Object.keys(built.citiesByDestination).sort()).toEqual(["dest-bali", "dest-sg"]);
    expect(built.citiesByDestination["dest-sg"].map((o) => o.value).sort()).toEqual([
      "city-marina",
      "city-sentosa",
    ]);
  });

  it("supports nested cities on destinations", () => {
    const nested = {
      destinations: [
        {
          value: "dest-sg",
          label: "Singapore",
          cities: [
            { value: "city-marina", label: "Marina Bay" },
            { value: "city-sentosa", label: "Sentosa Island" },
          ],
        },
      ],
    };
    const cities = extractCityOptions(nested);
    expect(citiesForDestination(cities, "dest-sg")).toHaveLength(2);
  });
});

describe("10. changing destination clears an incompatible city", () => {
  const cities = [
    { value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" },
    { value: "city-kuta", label: "Kuta", destinationValue: "dest-bali" },
  ];

  it("compatible city is kept, incompatible is cleared", () => {
    expect(isCompatibleCity(cities, "dest-sg", "city-marina")).toBe(true);
    expect(isCompatibleCity(cities, "dest-sg", "city-kuta")).toBe(false);
  });

  it("no linkage means free pairing (server validates)", () => {
    const free = [
      { value: "city-a", label: "A", destinationValue: null },
      { value: "city-b", label: "B", destinationValue: null },
    ];
    expect(isCompatibleCity(free, "dest-x", "city-a")).toBe(true);
    expect(citiesForDestination(free, "dest-x")).toHaveLength(2);
  });
});

describe("12+13. stable IDs preserved + payload mapping", () => {
  it("preserves Travel CRM IDs verbatim through defaults → draft → payload", () => {
    const defaults = normalizeItineraryDefaults([
      { destination: "dest-sg", city: "city-marina", nights: 4 },
      { destination: "dest-bali", city: "city-kuta", nights: 3 },
    ]);
    const draft = defaultsToDraftItinerary(defaults);
    expect(draft).toEqual([
      { country: "dest-sg", destination: "city-marina", nights: 4 },
      { country: "dest-bali", destination: "city-kuta", nights: 3 },
    ]);
    // Final payload shape expected by Travel CRM (existing contract):
    const payload = draft.map((row, i) => ({
      country: row.country,
      destination: row.destination,
      nights: row.nights,
      sequence: i + 1,
    }));
    expect(payload).toEqual([
      { country: "dest-sg", destination: "city-marina", nights: 4, sequence: 1 },
      { country: "dest-bali", destination: "city-kuta", nights: 3, sequence: 2 },
    ]);
  });

  it("draft → defaults round-trips without inventing names", () => {
    const back = draftToItineraryDefaults([
      { country: "dest-sg", destination: "city-marina", nights: 4 },
    ]);
    expect(back).toEqual([{ destination: "dest-sg", city: "city-marina", nights: 4 }]);
    expect(draftToItineraryDefaults([])).toEqual([]);
  });
});
