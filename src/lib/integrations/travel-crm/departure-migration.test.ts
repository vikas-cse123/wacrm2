import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Migration 103 content assertions — per-flow Travel CRM departure
// defaults. Mirrors the 101/102 pattern of asserting migration SQL
// text rather than live DDL.
// ---------------------------------------------------------------------------

function readMigration103(): string {
  return readFileSync(
    `${process.cwd()}/supabase/migrations/103_travel_crm_departure_defaults.sql`,
    "utf8",
  );
}

describe("103_travel_crm_departure_defaults", () => {
  it("adds nullable departure columns to the per-flow settings table", () => {
    const sql = readMigration103();
    expect(sql).toContain("ALTER TABLE travel_crm_flow_settings");
    expect(sql).toContain("departure_country");
    expect(sql).toContain("departure_city");
  });

  it("stays idempotent and stores identifiers (no new tables or enums)", () => {
    const sql = readMigration103();
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).not.toContain("CREATE TABLE");
    expect(sql).not.toContain("CREATE TYPE");
  });
});
