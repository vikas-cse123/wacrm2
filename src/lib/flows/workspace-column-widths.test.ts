import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  clampColumnWidth,
  coerceColumnWidth,
  columnWidthStyle,
  WORKSPACE_COLUMN_MAX_WIDTH,
  WORKSPACE_COLUMN_MIN_WIDTH,
} from "./workspace-column-widths";

// ---------------------------------------------------------------------------
// Column widths — clamping, styles. No sticky/pinned layout remains:
// every column (including Row) sizes from its stored width only.
// ---------------------------------------------------------------------------

describe("min/max band", () => {
  it("is 80–500px", () => {
    expect(WORKSPACE_COLUMN_MIN_WIDTH).toBe(80);
    expect(WORKSPACE_COLUMN_MAX_WIDTH).toBe(500);
  });

  it("clampColumnWidth accepts the band and rounds", () => {
    expect(clampColumnWidth(80)).toBe(80);
    expect(clampColumnWidth(500)).toBe(500);
    expect(clampColumnWidth(200.6)).toBe(201);
  });

  it("clampColumnWidth rejects outside/non-numeric input", () => {
    for (const bad of [79, 501, 0, -10, "wide", null, undefined, NaN]) {
      expect(() => clampColumnWidth(bad)).toThrow();
    }
  });

  it("coerceColumnWidth pins hand-edited values instead of throwing", () => {
    expect(coerceColumnWidth(10, 150)).toBe(80);
    expect(coerceColumnWidth(9000, 150)).toBe(500);
    expect(coerceColumnWidth(200, 150)).toBe(200);
    expect(coerceColumnWidth("junk", 150)).toBe(150);
  });
});

describe("columnWidthStyle", () => {
  it("returns undefined for natural (unset) columns", () => {
    expect(columnWidthStyle("flow:name", {})).toBeUndefined();
    expect(columnWidthStyle("flow:name", null)).toBeUndefined();
    expect(columnWidthStyle("flow:name", { "flow:name": "" })).toBeUndefined();
    expect(columnWidthStyle("flow:name", { "flow:name": "junk" })).toBeUndefined();
  });

  it("returns identical width/minWidth for header and body", () => {
    const widths = { "flow:name": 220 };
    expect(columnWidthStyle("flow:name", widths)).toEqual({
      width: 220,
      minWidth: 220,
    });
  });

  it("pins hand-edited out-of-band values to the band on read", () => {
    expect(columnWidthStyle("flow:name", { "flow:name": 10 })).toEqual({
      width: 80,
      minWidth: 80,
    });
    expect(columnWidthStyle("flow:name", { "flow:name": 9000 })).toEqual({
      width: 500,
      minWidth: 500,
    });
  });
});

describe("no sticky layouts remain", () => {
  it("the sticky-column module is deleted", () => {
    expect(
      existsSync(
        `${process.cwd()}/src/components/workspace/sticky-columns.ts`
      )
    ).toBe(false);
  });

  it("resizing still flows through columnWidthStyle per column", () => {
    // Row + every other column size independently; no offsets exist.
    expect(columnWidthStyle("core:row", { "core:row": 120 })).toEqual({
      width: 120,
      minWidth: 120,
    });
    expect(columnWidthStyle("flow:name", { "flow:name": 300 })).toEqual({
      width: 300,
      minWidth: 300,
    });
  });
});
