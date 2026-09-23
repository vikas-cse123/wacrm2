import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Regression coverage for migration 085 (historical message search).
//
// There is no live-DB harness in this repo (all vitest suites are pure
// unit tests), so the RPC itself cannot be executed here. These tests
// pin the migration's structural contract instead: the EXISTS branch,
// account scoping, preserved filters/pagination/ordering, and the
// unchanged security posture. A behavioural matrix lives in the
// migration header; execute it against a real database on deploy.

function loadSearchMigrations(): { file: string; sql: string }[] {
  const dir = join(process.cwd(), "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => /inbox_search/.test(f))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(dir, f), "utf8") }));
}

function latestSearchMigration(): { file: string; sql: string } {
  const all = loadSearchMigrations();
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

describe("inbox search history migration", () => {
  it("a newer search migration exists on top of 078", () => {
    const all = loadSearchMigrations();
    expect(all.map((m) => m.file)).toContain("078_inbox_search.sql");
    const latest = all[all.length - 1];
    expect(latest.file).not.toBe("078_inbox_search.sql");
    // 078 itself is untouched: still last-message-only, no messages branch.
    const base = all.find((m) => m.file === "078_inbox_search.sql")!;
    expect(base.sql).not.toMatch(/FROM messages/i);
  });

  it("adds an EXISTS branch over messages.content_text", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM messages m[\s\S]*?m\.content_text ILIKE '%' \|\| v_qesc \|\| '%' ESCAPE '\\'/i,
    );
  });

  it("correlates messages via the conversation (no messages.account_id)", () => {
    // messages carries no account_id column (see 074) — scoping must
    // ride on m.conversation_id = c.id under the outer account filter.
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/m\.conversation_id\s*=\s*c\.id/i);
    expect(sql).not.toMatch(/m\.account_id/i);
    expect(sql).not.toMatch(/messages\s*\(\s*account_id/i);
  });

  it("retains every existing text branch", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/c\.last_message_text ILIKE/i);
    expect(sql).toMatch(/ct\.name ILIKE/i);
    expect(sql).toMatch(/ct\.phone ILIKE/i);
    expect(sql).toMatch(/ct\.phone_normalized ILIKE/i);
  });

  it("reuses the escaped LIKE variable (%, _, \\ safe; ? literal)", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/v_qesc\s*:=.*replace.*%.*\\%/i);
    // The messages branch must use the escaped variable, not raw input.
    expect(sql).not.toMatch(/m\.content_text ILIKE '%' \|\| v_q \|\| '%'/i);
  });

  it("keeps SECURITY INVOKER and never DEFINER", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/SECURITY INVOKER/i);
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
  });

  it("keeps grants: authenticated only, revoked from PUBLIC", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.search_inbox_conversations[\s\S]*?TO authenticated/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.search_inbox_conversations/i);
  });

  it("preserves signature, filters, ordering, and keyset pagination", () => {
    const { sql } = latestSearchMigration();
    // Signature identical to 078 (11 params, same order).
    expect(sql).toMatch(
      /search_inbox_conversations\(\s*p_search TEXT,\s*p_status TEXT[^)]*p_limit INT DEFAULT 25\s*\)/i,
    );
    for (const facet of [
      "p_status",
      "p_tag_ids",
      "p_company",
      "p_flow_id",
      "p_member_ids",
      "p_from",
      "p_to",
    ]) {
      expect(sql).toContain(facet);
    }
    expect(sql).toMatch(
      /ORDER BY c\.last_message_at DESC NULLS FIRST, c\.id DESC/i,
    );
    expect(sql).toMatch(/LIMIT v_limit \+ 1/i);
    expect(sql).toMatch(/p_cur_id IS NULL/i);
  });

  it("enables pg_trgm and adds a GIN trigram index on content_text", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_messages_content_text_trgm\s+ON messages USING gin\s*\(\s*content_text gin_trgm_ops\s*\)/i,
    );
  });

  it("uses EXISTS (dedup-safe) rather than a messages JOIN", () => {
    const { sql } = latestSearchMigration();
    expect(sql).not.toMatch(/JOIN messages/i);
    expect(sql).not.toMatch(/FROM messages m,/i);
  });
});
