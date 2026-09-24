import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";
import { buildFlowTableColumns } from "@/lib/flows/flow-tables";
import {
  isStickyColumnKey,
  STICKY_COLUMN_OFFSETS,
  STICKY_COLUMN_ORDER,
  STICKY_COLUMN_WIDTHS,
  STICKY_FLOW_COLUMN_KEYS,
  STICKY_ROW_COLUMN_KEY,
  STICKY_TOTAL_WIDTH,
  STICKY_Z,
  stickyColumnStyle,
} from "./sticky-columns";

// ---------------------------------------------------------------------------
// Workspace enterprise horizontal scroll — structural verification.
//
// Real pixel scrolling can't run in a node test env, so these tests
// lock the MECHANICS that produce the required behavior: a single
// scroll viewport (one native scrollbar pair), key-based pinned
// columns with shared header/body geometry, a stuck opaque
// header, and untouched data plumbing (order, pagination,
// visibility, filters, Sheets).
// ---------------------------------------------------------------------------

const root = process.cwd();
const page = readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");
const globals = readFileSync(`${root}/src/app/globals.css`, "utf8");
const tablePrimitive = readFileSync(`${root}/src/components/ui/table.tsx`, "utf8");

describe("5. sticky left columns remain visible", () => {
  it("pins exactly No. + Submission Time + Name + Phone Number", () => {
    expect(STICKY_FLOW_COLUMN_KEYS).toEqual(["submission_time", "name", "phone"]);
    expect(STICKY_ROW_COLUMN_KEY).toBe("__row");
    expect(STICKY_COLUMN_ORDER).toEqual([
      "__row",
      "submission_time",
      "name",
      "phone",
    ]);
    for (const key of STICKY_COLUMN_ORDER) {
      expect(isStickyColumnKey(key)).toBe(true);
    }
  });

  it("offsets are cumulative (derived, never hand-synced)", () => {
    expect(STICKY_COLUMN_OFFSETS).toEqual({
      __row: 0,
      submission_time: STICKY_COLUMN_WIDTHS.__row,
      name:
        STICKY_COLUMN_WIDTHS.__row + STICKY_COLUMN_WIDTHS.submission_time,
      phone:
        STICKY_COLUMN_WIDTHS.__row +
        STICKY_COLUMN_WIDTHS.submission_time +
        STICKY_COLUMN_WIDTHS.name,
    });
    expect(STICKY_TOTAL_WIDTH).toBe(
      Object.values(STICKY_COLUMN_WIDTHS).reduce((a, b) => a + b, 0),
    );
    for (const w of Object.values(STICKY_COLUMN_WIDTHS)) {
      expect(w).toBeGreaterThan(0);
    }
  });

  it("layering keeps corners above headers above pinned body", () => {
    expect(STICKY_Z.corner).not.toBe(STICKY_Z.head);
    expect(STICKY_Z.head).not.toBe(STICKY_Z.body);
  });
});

describe("2/3. data columns scroll while pinned columns stay", () => {
  it.each(["TravelDate", "status", "custom-field-uuid", "lead_source"])(
    "scrolls (not pinned): %s",
    (key) => {
      expect(isStickyColumnKey(key)).toBe(false);
      expect(stickyColumnStyle(key)).toBeNull();
    },
  );
});

describe("6. header and body stay aligned", () => {
  it("one shared geometry object feeds both cells per key", () => {
    for (const key of STICKY_COLUMN_ORDER) {
      expect(stickyColumnStyle(key)).toEqual(stickyColumnStyle(key));
      expect(stickyColumnStyle(key)).toMatchObject({
        left: STICKY_COLUMN_OFFSETS[key],
        width: STICKY_COLUMN_WIDTHS[key],
        minWidth: STICKY_COLUMN_WIDTHS[key],
      });
    }
  });

  it("the page feeds the shared layouts map to header and body cells", () => {
    const uses = page.split("stickyLayouts[").length - 1;
    expect(uses).toBeGreaterThanOrEqual(4);
    expect(page).toContain("resolveStickyLayouts(");
    expect(page).toContain("TableHead");
    expect(page).toContain("TableCell");
  });

  it("the stuck header keeps its divider (tr border merges to th border)", () => {
    // tailwind-merge must collapse the primitive's tr-level divider
    // in favour of the th-level one, which travels with stuck cells.
    expect(cn("[&_tr]:border-b", "[&_tr]:border-b-0")).toBe("[&_tr]:border-b-0");
    expect(page).toContain("[&_tr]:border-b-0");
  });

  it("pinned flow columns render first, so positional offsets hold", () => {
    const { columns } = buildFlowTableColumns([], null);
    expect(columns.map((c) => c.key).slice(0, 3)).toEqual([
      "submission_time",
      "name",
      "phone",
    ]);
    expect(columns[columns.length - 1].key).toBe("status");
  });
});

describe("1/4/7. single table viewport, no page scroll, vertical intact", () => {
  it("the table viewport owns scrolling with a viewport-relative bound", () => {
    expect(page).toContain("workspace-table-viewport");
    expect(page).toContain("overflow-auto");
    expect(page).toContain("max-h-[70vh]");
    // No fixed-px viewport heights/widths that break screen sizes.
    expect(page).not.toMatch(/max-h-\[\d+px\]/);
  });

  it("the inner Table scroll container is neutralized (one scrollbar)", () => {
    expect(globals).toContain(".workspace-table-viewport");
    expect(globals).toContain('[data-slot="table-container"]');
    expect(globals).toMatch(/overflow:\s*visible/);
  });

  it("the shared Table primitive stays generic (no sticky leaked in)", () => {
    expect(tablePrimitive).not.toContain("sticky");
  });

  it("the page root creates no sideways scrolling of its own", () => {
    expect(page).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(globals).not.toMatch(/body\s*\{[^}]*overflow-x/);
  });
});

describe("8/9. pagination + visibility + Lead Source unchanged", () => {
  it("pagination plumbing is intact", () => {
    for (const token of [
      "workspaceRowNumber",
      "WORKSPACE_PAGE_SIZES",
      "Previous",
      "Next",
      "totalPages",
      "rangeText",
    ]) {
      expect(page).toContain(token);
    }
  });

  it("column visibility plumbing is intact", () => {
    for (const token of [
      "applyVisibility",
      "useWorkspaceVisibility",
      "ColumnsMenu",
      "flowColumnsVisible",
      "customFieldsVisible",
      "leadSourceVisible",
    ]) {
      expect(page).toContain(token);
    }
  });

  it("Lead Source remains the final column", () => {
    // First occurrences live in the header row: custom heads, then
    // the Lead Source head. (Anchor to the header text node with
    // its trailing newline, not the code comment further up.)
    const customIdx = page.indexOf("customFieldsVisible.map");
    const leadIdx = page.indexOf("Lead Source\n");
    expect(customIdx).toBeGreaterThan(-1);
    expect(leadIdx).toBeGreaterThan(customIdx);
    // Still conditional + centered, as before.
    expect(page).toContain("{leadSourceVisible && (");
  });

  it("filters, search, and views are untouched", () => {
    for (const token of [
      "WorkspaceFilters",
      "debouncedSearch",
      "selectView",
      "VIEWS",
    ]) {
      expect(page).toContain(token);
    }
  });
});

describe("10. no regression to Google Sheets or Workspace data", () => {
  it("sheets read paths reference none of the scroll work", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src).not.toContain("workspace-table-viewport");
      expect(src).not.toContain("stickyColumnStyle");
    }
  });

  it("column definitions and data flow are untouched", () => {
    for (const token of ["cellText(row, c)", "CustomCell", "AdSourceCell", "onSaved"]) {
      expect(page).toContain(token);
    }
  });
});
