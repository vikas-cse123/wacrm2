import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  choiceOptionsByKey,
  resolveFlowAnswers,
} from "./flow-tables";
import type { FlowNodeLite } from "./sheet-columns";

// ---------------------------------------------------------------------------
// Workspace flow-answer overrides — display resolution + choice
// extraction + migration contract. Originals are never mutated;
// displayValue = override ?? original; restore = delete the row.
// ---------------------------------------------------------------------------

function q(
  node_key: string,
  config: Record<string, unknown>,
  node_type = "collect_input",
): FlowNodeLite {
  return { node_key, node_type, config };
}

describe("resolveFlowAnswers (display = override ?? original)", () => {
  const answers = { Hotel: "5 Star Hotel", City: "Goa", Empty: null };

  it("shows originals when no overrides exist", () => {
    expect(resolveFlowAnswers(answers, undefined)).toEqual(answers);
    expect(resolveFlowAnswers(answers, null)).toEqual(answers);
    expect(resolveFlowAnswers(answers, {})).toEqual(answers);
  });

  it("override wins, including explicit null (cleared stays blank)", () => {
    expect(
      resolveFlowAnswers(answers, { Hotel: "4 Star Hotel" }),
    ).toMatchObject({ Hotel: "4 Star Hotel", City: "Goa" });
    expect(resolveFlowAnswers(answers, { City: null })).toMatchObject({
      City: null,
    });
  });

  it("never mutates the originals object", () => {
    const before = { ...answers };
    resolveFlowAnswers(answers, { Hotel: "X" });
    expect(answers).toEqual(before);
  });

  it("ignores overrides for unknown/deleted keys", () => {
    expect(
      resolveFlowAnswers(answers, { Deleted: "Y", Hotel: "4 Star Hotel" }),
    ).toEqual({ Hotel: "4 Star Hotel", City: "Goa", Empty: null });
  });

  it("an override equal to the original is a no-op for display", () => {
    expect(resolveFlowAnswers(answers, { Hotel: "5 Star Hotel" })).toEqual(
      answers,
    );
  });
});

describe("choiceOptionsByKey (buttons/list titles by question identity)", () => {
  it("collects button titles keyed by node_key", () => {
    const out = choiceOptionsByKey([
      q("start", {}, "start"),
      {
        node_key: "q0",
        node_type: "send_buttons",
        config: {
          text: "Pick",
          buttons: [{ title: "A" }, { title: "B" }, { title: " " }],
        },
      },
    ]);
    expect(out.get("q0")).toEqual(["A", "B"]);
  });

  it("collects list row titles across sections, deduped", () => {
    const out = choiceOptionsByKey([
      {
        node_key: "q0",
        node_type: "send_list",
        config: {
          text: "Pick",
          sections: [
            { rows: [{ title: "X" }, { title: "Y" }] },
            { rows: [{ title: "X" }, {}] },
          ],
        },
      },
    ]);
    expect(out.get("q0")).toEqual(["X", "Y"]);
  });

  it("skips non-questions, sheet-excluded nodes, and duplicates", () => {
    const out = choiceOptionsByKey([
      q("q0", { var_key: "A" }),
      q("q0dup", { var_key: "A" }),
      {
        node_key: "q1",
        node_type: "send_buttons",
        config: { text: "Pick", buttons: [{ title: "Z" }], sheet_include: false },
      },
    ]);
    expect(out.has("A")).toBe(false);
    expect(out.has("q1")).toBe(false);
    expect(out.size).toBe(0);
  });
});

describe("104_workspace_flow_overrides migration contract", () => {
  const sql = readFileSync(
    `${process.cwd()}/supabase/migrations/104_workspace_flow_overrides.sql`,
    "utf8",
  );

  it("creates an override table keyed by account+flow+run+field", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS workspace_flow_overrides");
    expect(sql).toContain("UNIQUE (account_id, flow_id, flow_run_id, field_key)");
    expect(sql).toContain("value_text TEXT");
    expect(sql).toContain("REFERENCES flow_runs(id) ON DELETE CASCADE");
  });

  it("scopes reads to members and writes to agents, idempotently", () => {
    expect(sql).toContain("is_account_member(account_id)");
    expect(sql).toContain("is_account_member(account_id, 'agent')");
    expect(sql).toContain("IF NOT EXISTS");
  });

  it("touches no existing table (additive only)", () => {
    // The only ALTERs target the new table itself (RLS + trigger).
    const alters = [...sql.matchAll(/ALTER TABLE\s+(\S+)/gi)].map((m) => m[1]);
    expect(alters.length).toBeGreaterThan(0);
    expect(new Set(alters)).toEqual(new Set(["workspace_flow_overrides"]));
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS (?!workspace_flow_overrides)\w/);
  });
});

describe("contracts: originals stay authoritative elsewhere", () => {
  const root = process.cwd();
  const sheetsFiles = [
    "src/lib/sheets/assign-enrich.ts",
    "src/lib/flows/sheet-columns.ts",
    "src/lib/flows/sheet-layout.ts",
    "src/app/api/flows/[id]/sheet/backfill/route.ts",
    "src/app/api/flows/[id]/incomplete-sheet/route.ts",
  ];

  it("22. Google Sheets paths never read the overrides table", () => {
    for (const rel of sheetsFiles) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src, rel).not.toContain("workspace_flow_overrides");
    }
  });

  it("flow_runs.vars has no write path from Workspace editing", () => {
    const page = readFileSync(
      `${root}/src/app/(dashboard)/workspace/page.tsx`,
      "utf8",
    );
    expect(page).not.toMatch(/flow_runs.*update|update.*flow_runs/);
    const route = readFileSync(
      `${root}/src/app/api/flows/[id]/flow-overrides/route.ts`,
      "utf8",
    );
    // flow_runs is read once for scope + originals; every write
    // targets workspace_flow_overrides and nothing else.
    expect(route.match(/\.from\("flow_runs"\)/g)).toHaveLength(1);
    expect(route).toContain('from("workspace_flow_overrides")');
    expect(route).not.toContain(".update(");
  });
});
