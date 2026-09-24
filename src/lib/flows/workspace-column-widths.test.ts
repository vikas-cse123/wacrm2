import { describe, expect, it } from "vitest";

import {
  clampColumnWidth,
  coerceColumnWidth,
  columnWidthStyle,
  WORKSPACE_COLUMN_MAX_WIDTH,
  WORKSPACE_COLUMN_MIN_WIDTH,
} from "./workspace-column-widths";
import {
  resolveStickyLayouts,
  STICKY_COLUMN_OFFSETS,
  STICKY_COLUMN_WIDTHS,
  STICKY_ROW_COLUMN_KEY,
} from "@/components/workspace/sticky-columns";

// ---------------------------------------------------------------------------
// Column widths — clamping, styles, sticky integration.
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

describe("resolveStickyLayouts", () => {
  const visIdFor = (key: string) =>
    key === STICKY_ROW_COLUMN_KEY ? "core:row" : `flow:${key}`;

  it("matches the static defaults when nothing is resized", () => {
    const layouts = resolveStickyLayouts(visIdFor, {});
    for (const key of Object.keys(STICKY_COLUMN_WIDTHS)) {
      expect(layouts[key].width).toBe(STICKY_COLUMN_WIDTHS[key]);
      expect(layouts[key].left).toBe(STICKY_COLUMN_OFFSETS[key]);
    }
  });

  it("a resized sticky column shifts later siblings with no gaps/overlaps", () => {
    const layouts = resolveStickyLayouts(visIdFor, { "flow:name": 300 });
    expect(layouts["name"].width).toBe(300);
    expect(layouts["phone"].left).toBe(layouts["name"].left + 300);
    // Contiguity: every left edge equals the previous right edge.
    const order = ["__row", "submission_time", "name", "phone"];
    const ids = ["core:row", "flow:submission_time", "flow:name", "flow:phone"];
    const full = resolveStickyLayouts(
      (k) => ids[order.indexOf(k)],
      { "flow:submission_time": 200, "flow:phone": 120 },
    );
    let cursor = 0;
    for (const key of order) {
      expect(full[key].left).toBe(cursor);
      cursor += full[key].width;
    }
    expect(full["submission_time"].width).toBe(200);
    expect(full["phone"].width).toBe(120);
  });

  it("ignores unknown widths and unknown sticky keys", () => {
    const layouts = resolveStickyLayouts(visIdFor, {
      "custom:whatever": 400,
      "flow:name": "junk",
    });
    expect(layouts["name"].width).toBe(STICKY_COLUMN_WIDTHS["name"]);
    expect(layouts["unknown-key"]).toBeUndefined();
  });
});
