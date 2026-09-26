import { describe, expect, it } from "vitest";

import {
  TRAVEL_CRM_MAX_SERVICES,
  TRAVEL_CRM_SERVICE_LABELS,
  isOfferedServiceLabel,
  joinServiceLabels,
  normalizeServiceLabels,
  splitServiceLabels,
} from "./services";

describe("TRAVEL_CRM_SERVICE_LABELS", () => {
  it("offers exactly the six services in order", () => {
    expect([...TRAVEL_CRM_SERVICE_LABELS]).toEqual([
      "Cruise",
      "Flight",
      "Hotel",
      "Vehicle (disposal)",
      "Sightseeing",
      "Add-on Service (Rail, Passport, etc.)",
    ]);
  });
});

describe("normalizeServiceLabels", () => {
  it("trims, drops empties, dedupes case-insensitively preserving order", () => {
    expect(normalizeServiceLabels([" Hotel ", "hotel", "Flight", "", "  "])).toEqual([
      "Hotel",
      "Flight",
    ]);
    expect(normalizeServiceLabels([])).toEqual([]);
  });

  it("rejects non-lists, non-text, oversize input", () => {
    expect(() => normalizeServiceLabels("Hotel")).toThrow();
    expect(() => normalizeServiceLabels([42])).toThrow();
    expect(() =>
      normalizeServiceLabels(Array.from({ length: TRAVEL_CRM_MAX_SERVICES + 1 }, () => "Hotel")),
    ).toThrow();
    expect(() => normalizeServiceLabels(["x".repeat(81)])).toThrow();
  });
});

describe("isOfferedServiceLabel", () => {
  it("matches case-insensitively with trimming", () => {
    expect(isOfferedServiceLabel("hotel")).toBe(true);
    expect(isOfferedServiceLabel("  Vehicle (Disposal) ")).toBe(true);
    expect(isOfferedServiceLabel("Teleport")).toBe(false);
    expect(isOfferedServiceLabel("")).toBe(false);
  });
});

describe("split/joinServiceLabels (dialog value state)", () => {
  it("round-trips semicolon-joined values", () => {
    expect(splitServiceLabels("Hotel; Sightseeing")).toEqual(["Hotel", "Sightseeing"]);
    expect(splitServiceLabels("")).toEqual([]);
    expect(joinServiceLabels(["Hotel", "Flight"])).toBe("Hotel; Flight");
    expect(joinServiceLabels([])).toBe("");
  });
});
