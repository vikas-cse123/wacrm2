import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ASSIGNED_TO_CLEAR_SENTINEL,
  ASSIGNED_TO_UNASSIGNED,
  assigneeDisplayName,
  buildAssigneeOptions,
  isAssigneeField,
  resolveAssigneeDisplay,
  validateAssigneeValue,
} from "./workspace-assignee";

// ---------------------------------------------------------------------------
// Workspace "Assigned To" — dynamic team-member binding.
//
// Proves the 9 required behaviors without hardcoding any member:
//   1. members load dynamically from the current account roster
//   2. no hardcoded names/UUIDs
//   3. newly added members appear automatically
//   4. removed members stop being selectable
//   5. only current-account members validate
//   6. selection stores the stable user_id
//   7. existing assignments are preserved on read
//   8. Clear works
//   9. Unassigned works
// ---------------------------------------------------------------------------

const M_A = { user_id: "11111111-1111-4111-8111-111111111111", full_name: "Asha Rao" };
const M_B = { user_id: "22222222-2222-4222-8222-222222222222", full_name: "Dev Patel" };

describe("isAssigneeField", () => {
  it("recognizes the Assigned To column case-insensitively", () => {
    expect(isAssigneeField({ name: "Assigned To" })).toBe(true);
    expect(isAssigneeField({ name: "  assigned to  " })).toBe(true);
    expect(isAssigneeField({ name: "ASSIGNED TO" })).toBe(true);
    expect(isAssigneeField({ name: "Call Status" })).toBe(false);
    expect(isAssigneeField({ name: "Assigned To 2" })).toBe(false);
  });
});

describe("1. dynamic roster — options derive from the input list", () => {
  it("builds Clear + Unassigned + one row per current member", () => {
    const opts = buildAssigneeOptions([M_A, M_B], null);
    expect(opts.slice(0, 2).map((o) => o.value)).toEqual([
      ASSIGNED_TO_CLEAR_SENTINEL,
      ASSIGNED_TO_UNASSIGNED,
    ]);
    expect(opts.filter((o) => o.kind === "member").map((o) => o.value)).toEqual([
      M_A.user_id,
      M_B.user_id,
    ]);
    expect(opts.filter((o) => o.kind === "member").map((o) => o.label)).toEqual([
      "Asha Rao",
      "Dev Patel",
    ]);
  });

  it("different rosters yield different dropdowns (no static list)", () => {
    const before = buildAssigneeOptions([M_A], null).map((o) => o.value);
    const after = buildAssigneeOptions([M_A, M_B], null).map((o) => o.value);
    expect(before).not.toContain(M_B.user_id);
    expect(after).toContain(M_B.user_id);
  });

  it("falls back to Unnamed for blank names (matches Members tab)", () => {
    expect(assigneeDisplayName({ user_id: "x", full_name: "  " })).toBe("Unnamed");
    expect(assigneeDisplayName({ user_id: "x", full_name: null })).toBe("Unnamed");
  });
});

describe("2. no hardcoded team members", () => {
  const root = process.cwd();
  const files = [
    "src/lib/flows/workspace-assignee.ts",
    "src/components/workspace/custom-cell.tsx",
    "src/app/(dashboard)/workspace/page.tsx",
    "src/app/api/flows/[id]/workspace-values/route.ts",
  ];
  // Distinctive names from the issue's example roster — these must
  // never appear in source (roster comes from /api/account/members).
  const forbidden = ["travelenfield", "tarun sagar", "neha singh", "janak katyal"];

  it.each(files)("does not hardcode member names: %s", (rel) => {
    const src = readFileSync(join(root, rel), "utf8").toLowerCase();
    for (const name of forbidden) {
      expect(src).not.toContain(name);
    }
  });

  it("workspace-assignee.ts contains no hardcoded UUIDs", () => {
    const src = readFileSync(
      join(root, "src/lib/flows/workspace-assignee.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("UI + API load the roster from the Team Members endpoint/source", () => {
    const page = readFileSync(
      join(root, "src/app/(dashboard)/workspace/page.tsx"),
      "utf8",
    );
    expect(page).toContain("/api/account/members");
    const route = readFileSync(
      join(root, "src/app/api/flows/[id]/workspace-values/route.ts"),
      "utf8",
    );
    // Same profiles/account_id source the members endpoint reads.
    expect(route).toContain('from("profiles")');
    expect(route).toContain('"account_id"');
  });
});

describe("3. newly added members appear automatically", () => {
  it("a new roster entry validates and lists with no code change", () => {
    const newcomer = {
      user_id: "33333333-3333-4333-8333-333333333333",
      full_name: "New Teammate",
    };
    // Validates immediately once the caller passes the fresh roster.
    expect(validateAssigneeValue(newcomer.user_id, new Set([M_A.user_id, newcomer.user_id]))).toBe(
      newcomer.user_id,
    );
    const opts = buildAssigneeOptions([M_A, newcomer], null);
    expect(opts.map((o) => o.value)).toContain(newcomer.user_id);
    expect(resolveAssigneeDisplay(newcomer.user_id, [M_A, newcomer])).toBe("New Teammate");
  });
});

describe("4. removed members stop being selectable", () => {
  it("a removed id no longer lists and no longer validates", () => {
    const current = [M_A];
    const opts = buildAssigneeOptions(current, null);
    expect(opts.map((o) => o.value)).not.toContain(M_B.user_id);
    expect(() => validateAssigneeValue(M_B.user_id, new Set([M_A.user_id]))).toThrow(
      /current account/i,
    );
  });
});

describe("5. only current-account members validate", () => {
  it("rejects another account's member id", () => {
    const foreignId = "99999999-9999-4999-8999-999999999999";
    expect(() =>
      validateAssigneeValue(foreignId, new Set([M_A.user_id, M_B.user_id])),
    ).toThrow(/current account/i);
  });

  it("rejects legacy display names for new writes", () => {
    expect(() => validateAssigneeValue("Asha Rao", new Set([M_A.user_id]))).toThrow(
      /current account/i,
    );
  });
});

describe("6. selection stores the stable user_id, displays the name", () => {
  it("validate returns the id; resolve shows the name", () => {
    expect(validateAssigneeValue(M_A.user_id, [M_A.user_id, M_B.user_id])).toBe(M_A.user_id);
    expect(resolveAssigneeDisplay(M_A.user_id, [M_A, M_B])).toBe("Asha Rao");
  });

  it("a rename propagates with no data change (id still resolves)", () => {
    const renamed = { ...M_A, full_name: "Asha R. Rao" };
    expect(resolveAssigneeDisplay(M_A.user_id, [renamed, M_B])).toBe("Asha R. Rao");
  });
});

describe("7. existing assignments are preserved", () => {
  it("legacy display strings render as-is (never silently rewritten)", () => {
    expect(resolveAssigneeDisplay("Old Name", [M_A, M_B])).toBe("Old Name");
  });

  it("a removed member's stored id is kept and listed as preserved", () => {
    expect(resolveAssigneeDisplay(M_B.user_id, [M_A])).toBe(M_B.user_id);
    const opts = buildAssigneeOptions([M_A], M_B.user_id);
    const preserved = opts.filter((o) => o.kind === "preserved");
    expect(preserved).toHaveLength(1);
    expect(preserved[0].value).toBe(M_B.user_id);
  });

  it("new rows do not gain a phantom preserved entry", () => {
    const opts = buildAssigneeOptions([M_A], null);
    expect(opts.some((o) => o.kind === "preserved")).toBe(false);
  });
});

describe("8. Clear works", () => {
  it.each([null, undefined, "", "   ", ASSIGNED_TO_CLEAR_SENTINEL])(
    "normalizes %j to null",
    (v) => {
      expect(validateAssigneeValue(v, [M_A.user_id])).toBeNull();
    },
  );

  it("null resolves to null (renders as —)", () => {
    expect(resolveAssigneeDisplay(null, [M_A])).toBeNull();
    expect(resolveAssigneeDisplay(undefined, [M_A])).toBeNull();
  });
});

describe("9. Unassigned works", () => {
  it("validates, resolves, and lists Unassigned", () => {
    expect(validateAssigneeValue("Unassigned", [M_A.user_id])).toBe("Unassigned");
    expect(validateAssigneeValue("  Unassigned  ", [])).toBe("Unassigned");
    expect(resolveAssigneeDisplay("Unassigned", [M_A])).toBe("Unassigned");
    const opts = buildAssigneeOptions([M_A], null);
    expect(opts.map((o) => o.value)).toContain("Unassigned");
    expect(ASSIGNED_TO_UNASSIGNED).toBe("Unassigned");
  });
});
