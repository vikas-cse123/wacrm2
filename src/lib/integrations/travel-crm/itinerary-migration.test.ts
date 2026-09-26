import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Migration 102 content assertions — per-flow Travel CRM itinerary
// defaults. Mirrors the 101 pattern of asserting migration SQL text.
// ---------------------------------------------------------------------------

function readMigration102(): string {
  return readFileSync(
    `${process.cwd()}/supabase/migrations/102_travel_crm_itinerary_defaults.sql`,
    "utf8",
  );
}

describe("102_travel_crm_itinerary_defaults", () => {
  it("adds an itinerary JSONB column to the per-flow settings table", () => {
    const sql = readMigration102();
    expect(sql).toContain("ALTER TABLE travel_crm_flow_settings");
    expect(sql).toContain("itinerary JSONB");
  });

  it("stays idempotent", () => {
    const sql = readMigration102();
    expect(sql).toContain("IF NOT EXISTS");
  });

  it("stores stable IDs (no new foreign tables or enum types)", () => {
    const sql = readMigration102();
    expect(sql).not.toContain("CREATE TYPE");
    expect(sql).not.toContain("REFERENCES");
  });
});
