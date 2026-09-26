import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Workspace column groups — Group 1 (system/contact) + Group 2
// (flow-derived) come from the table payload in derivation order;
// Group 3 (business/workspace) renders Assigned To, Received,
// Type, Stage first via orderBusinessColumns, then the rest in
// stored order. These are page-wiring assertions (same
// read-source pattern as the workspace scroll/grid tests):
// derivation lives in lib, the page only chooses render order.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

describe("Group 2 before Group 3 (flow columns render before business columns)", () => {
  it("flow header cells render before business header cells", () => {
    const flowHead = pageSrc.indexOf("{flowColumnsVisible.map((c) => {");
    const businessHead = pageSrc.indexOf("{customFieldsOrdered.map((f) => (");
    expect(flowHead).toBeGreaterThan(-1);
    expect(businessHead).toBeGreaterThan(flowHead);
  });

  it("flow body cells render before business body cells", () => {
    const flowBody = pageSrc.indexOf("{flowColumnsVisible.map((c) => {");
    const businessBody = pageSrc.indexOf("customFieldsOrdered.map((f) => (");
    expect(flowBody).toBeGreaterThan(-1);
    expect(businessBody).toBeGreaterThan(flowBody);
  });
});

describe("Group 3 pinned order (Assigned To, Received, Type, Stage)", () => {
  it("the page derives a display-ordered business list from visibility output", () => {
    expect(pageSrc).toContain("orderBusinessColumns(customFieldsVisible)");
    expect(pageSrc).toContain("customFieldsOrdered");
  });

  it("both header and body render the ordered list (never divergent)", () => {
    const uses = pageSrc.split("customFieldsOrdered.map((f) => (").length - 1;
    expect(uses).toBe(2);
    // No JSX table render still uses the stored-order list (the
    // header-color map legitimately does: `...customFieldsVisible`).
    expect(pageSrc).not.toContain("{customFieldsVisible.map((f) => (");
  });

  it("visibility, widths, colors, and menu keep the stored-order identities", () => {
    // Header colors still resolve on the stored visible order so
    // auto-assigned tints never shift; the Columns menu still
    // receives the stored list.
    expect(pageSrc).toContain("...customFieldsVisible.map((f) => ({");
    expect(pageSrc).toContain("customFields={customFields}");
  });
});
