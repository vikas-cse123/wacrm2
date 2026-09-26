import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Migration 101 content assertions — per-flow Travel CRM service
// defaults. Mirrors the workspace-defaults pattern of asserting
// migration SQL text rather than live DDL.
// ---------------------------------------------------------------------------

function readMigration101(): string {
  return readFileSync(
    `${process.cwd()}/supabase/migrations/101_travel_crm_flow_settings.sql`,
    "utf8",
  );
}

describe("101_travel_crm_flow_settings", () => {
  it("creates an account+flow scoped settings table", () => {
    const sql = readMigration101();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS travel_crm_flow_settings");
    expect(sql).toContain("account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE");
    expect(sql).toContain("flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE");
    expect(sql).toContain("services JSONB NOT NULL");
  });

  it("enforces one row per account+flow", () => {
    const sql = readMigration101();
    expect(sql).toContain("UNIQUE (account_id, flow_id)");
  });

  it("scopes reads to members and writes to agents", () => {
    const sql = readMigration101();
    expect(sql).toContain("is_account_member(account_id)");
    expect(sql).toContain("is_account_member(account_id, 'agent')");
  });

  it("keeps updated_at fresh and stays idempotent", () => {
    const sql = readMigration101();
    expect(sql).toContain("set_updated_at");
    expect(sql).toContain("IF NOT EXISTS");
  });

  it("stores labels, never Travel CRM database IDs", () => {
    const sql = readMigration101();
    expect(sql).not.toContain("CREATE TYPE");
    const references = [...sql.matchAll(/REFERENCES\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(references.sort()).toEqual(["accounts", "flows"]);
  });
});
