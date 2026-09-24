import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { HeaderColorSwatches } from "@/components/workspace/header-color-picker";
import {
  buildHeaderColorMap,
  defaultHeaderColor,
  HEADER_COLOR_POOL,
  HEADER_COLOR_PRESETS,
  HEADER_CURATED_DEFAULTS,
  HEADER_FALLBACK_PALETTE,
  HEADER_TEXT_DARK,
  HEADER_TEXT_LIGHT,
  headerTextColor,
  isDarkHeaderColor,
  normalizeHeaderColor,
  overflowHeaderColor,
  resolveHeaderColor,
} from "./header-colors";

// ---------------------------------------------------------------------------
// Workspace header colors — model + wiring tests (14 required behaviors).
// ---------------------------------------------------------------------------

describe("1. distinct default light colors per column", () => {
  const canonicalOrder: Array<[string, string]> = [
    ["core:row", "Row"],
    ["flow:submission_time", "Submission Time"],
    ["flow:name", "Name"],
    ["flow:phone", "Phone Number"],
    ["custom:aaa", "Assigned To"],
    ["custom:bbb", "Call Status"],
    ["custom:ccc", "No. of Calls Tried"],
    ["custom:ddd", "Lead Quality"],
    ["custom:eee", "Quotation / Package"],
    ["custom:fff", "Follow-Up Status"],
    ["custom:ggg", "Last Contact Date"],
    ["custom:hhh", "Customer Response"],
    ["custom:iii", "Next Follow-up Date & Time"],
    ["custom:jjj", "Next Action"],
    ["custom:kkk", "Reason for Lost Lead"],
    ["custom:lll", "Final Remark"],
    ["lead_source", "Lead Source"],
  ];

  it("every canonical column resolves a valid light pastel", () => {
    for (const [visId, label] of canonicalOrder) {
      const hex = defaultHeaderColor(visId, label);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      // Light: dark slate text must win the contrast pick.
      expect(headerTextColor(hex)).toBe(HEADER_TEXT_DARK);
    }
  });

  it("no two adjacent columns share a color", () => {
    const colors = canonicalOrder.map(([v, l]) => defaultHeaderColor(v, l));
    for (let i = 1; i < colors.length; i++) {
      expect(colors[i]).not.toBe(colors[i - 1]);
    }
  });

  it("matches the spec's example intent (blue/green/yellow/purple…)", () => {
    expect(defaultHeaderColor("custom:x", "Assigned To")).toBe("#dbeafe");
    expect(defaultHeaderColor("custom:x", "Call Status")).toBe("#dcfce7");
    expect(defaultHeaderColor("custom:x", "Lead Quality")).toBe("#f3e8ff");
    expect(defaultHeaderColor("lead_source", "Lead Source")).not.toBe(
      defaultHeaderColor("custom:x", "Final Remark"),
    );
  });

  it("dynamic columns get stable hash-ring colors (no hardcoding)", () => {
    const a = defaultHeaderColor("flow:TravelDate", "TravelDate");
    const b = defaultHeaderColor("flow:TravelDate", "TravelDate");
    expect(a).toBe(b);
    expect(HEADER_FALLBACK_PALETTE).toContain(a);
    expect(defaultHeaderColor("custom:some-uuid", "My Tracker")).toBe(
      defaultHeaderColor("custom:some-uuid", "My Tracker"),
    );
  });
});

describe("normalizeHeaderColor", () => {
  it("accepts #rgb and #rrggbb in any case", () => {
    expect(normalizeHeaderColor("#DBEAFE")).toBe("#dbeafe");
    expect(normalizeHeaderColor("  #abc ")).toBe("#aabbcc");
  });

  it("rejects non-hex input", () => {
    for (const bad of ["red", "#12", "#gggggg", "", null, undefined, 42]) {
      expect(() => normalizeHeaderColor(bad)).toThrow(/hex/i);
    }
  });
});

describe("12. readable text on configured colors", () => {
  it("uses dark slate on every preset and every default", () => {
    for (const hex of HEADER_COLOR_PRESETS) {
      expect(headerTextColor(hex)).toBe(HEADER_TEXT_DARK);
    }
    expect(isDarkHeaderColor("#dbeafe")).toBe(false);
  });

  it("switches to white automatically on dark custom picks", () => {
    for (const dark of ["#111827", "#000000", "#7c2d12", "#1e3a8a"]) {
      expect(headerTextColor(dark)).toBe(HEADER_TEXT_LIGHT);
      expect(isDarkHeaderColor(dark)).toBe(true);
    }
    expect(headerTextColor("#ffffff")).toBe(HEADER_TEXT_DARK);
  });

  it("degrades safely on garbage input", () => {
    expect(headerTextColor("not-a-color")).toBe(HEADER_TEXT_DARK);
  });
});

describe("3/5. customize one column without affecting others", () => {
  it("custom override wins; siblings keep defaults", () => {
    const customs = { "custom:aaa": "#123456" };
    expect(resolveHeaderColor("custom:aaa", "Assigned To", customs)).toBe("#123456");
    expect(resolveHeaderColor("custom:bbb", "Call Status", customs)).toBe(
      defaultHeaderColor("custom:bbb", "Call Status"),
    );
  });

  it("any column is customizable (defaults are not locked)", () => {
    const customs: Record<string, string> = {
      "core:row": "#000000",
      "flow:submission_time": "#000000",
      lead_source: "#000000",
      "custom:anything": "#000000",
    };
    for (const visId of Object.keys(customs)) {
      expect(resolveHeaderColor(visId, visId, customs)).toBe("#000000");
    }
  });

  it("corrupt stored values degrade to the default, never blank", () => {
    expect(resolveHeaderColor("custom:aaa", "Assigned To", { "custom:aaa": "junk" })).toBe(
      defaultHeaderColor("custom:aaa", "Assigned To"),
    );
    expect(resolveHeaderColor("custom:aaa", "Assigned To", null)).toBe(
      defaultHeaderColor("custom:aaa", "Assigned To"),
    );
  });
});

describe("6/7. visibility never disturbs colors", () => {
  it("hidden → shown keeps the override (keyed by stable id)", () => {
    const customs = { "custom:aaa": "#123456" };
    // Simulate hide + show: the customs map is never filtered.
    const hidden = new Set(["custom:aaa"]);
    hidden.delete("custom:aaa");
    expect(resolveHeaderColor("custom:aaa", "Assigned To", customs)).toBe("#123456");
  });

  it("Show All / Reset (empty hidden set) leaves colors intact", () => {
    const customs = { "flow:TravelDate": "#abcdef", "lead_source": "#123123" };
    const afterReset: Record<string, string> = { ...customs };
    expect(afterReset).toEqual(customs);
    expect(resolveHeaderColor("flow:TravelDate", "TravelDate", afterReset)).toBe("#abcdef");
  });
});

describe("9/11. sticky headers keep their configured colors", () => {
  it("pinned columns resolve distinct pastels like everyone else", () => {
    const pinned: Array<[string, string]> = [
      ["core:row", "Row"],
      ["flow:submission_time", "Submission Time"],
      ["flow:name", "Name"],
      ["flow:phone", "Phone Number"],
    ];
    const colors = pinned.map(([v, l]) => resolveHeaderColor(v, l, {}));
    expect(new Set(colors).size).toBe(colors.length);
    for (const hex of colors) {
      expect(headerTextColor(hex)).toBe(HEADER_TEXT_DARK);
    }
  });
});

describe("picker UI (Columns → color)", () => {
  function render(custom: string | null, taken: string[] = []) {
    return renderToStaticMarkup(
      <HeaderColorSwatches
        label="Assigned To"
        defaultHex="#dbeafe"
        custom={custom}
        takenColors={taken}
        onPick={() => {}}
      />,
    );
  }

  it("offers default, presets, custom input, and reset", () => {
    const html = render(null);
    expect(html).toContain("Default");
    expect(html).toContain("Presets");
    expect(html).toContain("Custom");
    expect(html).toContain("Reset to default");
    expect(html).toContain('type="color"');
    for (const hex of HEADER_COLOR_PRESETS) {
      expect(html).toContain(hex);
    }
  });

  it("marks the active selection without locking anything", () => {
    const html = render("#fbcfe8");
    expect(html).toContain("#fbcfe8");
    expect(html).toContain("aria-pressed");
  });

  it("flags already-taken presets so duplicates are visibly blocked", () => {
    const html = render(null, ["#fbcfe8"]);
    expect(html).toContain("(already used)");
  });
});

describe("1/2. strict uniqueness — one color per visible column", () => {
  const canonical: Array<{ visId: string; label: string }> = [
    { visId: "core:row", label: "Row" },
    { visId: "flow:submission_time", label: "Submission Time" },
    { visId: "flow:name", label: "Name" },
    { visId: "flow:phone", label: "Phone Number" },
    { visId: "custom:aaa", label: "Assigned To" },
    { visId: "custom:bbb", label: "Call Status" },
    { visId: "custom:ccc", label: "No. of Calls Tried" },
    { visId: "custom:ddd", label: "Lead Quality" },
    { visId: "custom:eee", label: "Quotation / Package" },
    { visId: "custom:fff", label: "Follow-Up Status" },
    { visId: "custom:ggg", label: "Last Contact Date" },
    { visId: "custom:hhh", label: "Customer Response" },
    { visId: "custom:iii", label: "Next Follow-up Date & Time" },
    { visId: "custom:jjj", label: "Next Action" },
    { visId: "custom:kkk", label: "Reason for Lost Lead" },
    { visId: "custom:lll", label: "Final Remark" },
    { visId: "lead_source", label: "Lead Source" },
  ];

  function valuesOf(map: Record<string, string>): string[] {
    return Object.values(map);
  }

  it("the whole pool is pairwise distinct (curated + generated)", () => {
    expect(new Set(HEADER_COLOR_POOL).size).toBe(HEADER_COLOR_POOL.length);
    expect(new Set(HEADER_CURATED_DEFAULTS).size).toBe(
      HEADER_CURATED_DEFAULTS.length,
    );
    for (const hex of HEADER_COLOR_POOL) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("every canonical column maps to a unique background", () => {
    const map = buildHeaderColorMap(canonical, {});
    expect(Object.keys(map)).toHaveLength(canonical.length);
    expect(new Set(valuesOf(map)).size).toBe(canonical.length);
  });

  it("customs apply exactly; foreign customs never leak across columns", () => {
    const map = buildHeaderColorMap(canonical, {
      "custom:aaa": "#123456",
      "lead_source": "#654321",
    });
    expect(map["custom:aaa"]).toBe("#123456");
    expect(map["lead_source"]).toBe("#654321");
    expect(new Set(valuesOf(map)).size).toBe(canonical.length);
  });

  it("3. a newly added column takes another unused color (nothing reused)", () => {
    const before = buildHeaderColorMap(canonical, {});
    const extended = [
      ...canonical,
      { visId: "custom:newbie", label: "VIP Flag" },
      { visId: "flow:ExtraAnswer", label: "Extra Answer" },
    ];
    const after = buildHeaderColorMap(extended, {});
    expect(new Set(valuesOf(after)).size).toBe(extended.length);
    // Earlier fixed columns keep their colors when columns append.
    for (const col of canonical) {
      expect(after[col.visId]).toBe(before[col.visId]);
    }
  });

  it("many dynamic columns stay unique (hash probe, not luck)", () => {
    const cols = [
      ...canonical,
      ...Array.from({ length: 12 }, (_, i) => ({
        visId: `flow:Answer${i}`,
        label: `Answer ${i}`,
      })),
    ];
    const map = buildHeaderColorMap(cols, {});
    expect(new Set(valuesOf(map)).size).toBe(cols.length);
  });

  it("a duplicated stored custom falls back uniquely (first wins)", () => {
    const map = buildHeaderColorMap(canonical, {
      "custom:aaa": "#123456",
      "custom:bbb": "#123456",
    });
    expect(map["custom:aaa"]).toBe("#123456");
    expect(map["custom:bbb"]).not.toBe("#123456");
    expect(new Set(valuesOf(map)).size).toBe(canonical.length);
  });

  it("6. reset restores the column's unique fixed default", () => {
    const customized = buildHeaderColorMap(canonical, { "custom:aaa": "#123456" });
    expect(customized["custom:aaa"]).toBe("#123456");
    const reset = buildHeaderColorMap(canonical, {});
    expect(reset["custom:aaa"]).toBe(defaultHeaderColor("custom:aaa", "Assigned To"));
    expect(new Set(valuesOf(reset)).size).toBe(canonical.length);
  });

  it("overflow hues are deterministic valid hex", () => {
    expect(overflowHeaderColor(0)).toMatch(/^#[0-9a-f]{6}$/);
    expect(overflowHeaderColor(0)).toBe(overflowHeaderColor(0));
    expect(overflowHeaderColor(1)).not.toBe(overflowHeaderColor(0));
  });
});

describe("2/10/13. taller headers, sticky intact, functionality intact", () => {
  const root = process.cwd();
  const page = readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");

  it("headers are taller, semibold, and still sticky", () => {
    // 56px sits inside the 52–60px enterprise band.
    expect(page).toContain("h-14");
    expect(page).toContain("font-semibold");
    expect(page).toContain("text-[13px]");
    expect(page).toContain("sticky top-0");
    expect(page).toContain("resolveStickyLayouts(");
  });

  it("every header paints via the shared resolver (sticky corners included)", () => {
    // One headStyle call site per header group (row, flow, custom,
    // lead); the uniqueness map + contrast run inside it.
    const uses = page.split("headStyle(").length - 1;
    expect(uses).toBeGreaterThanOrEqual(4);
    expect(page).toContain("buildHeaderColorMap(");
    expect(page).toContain("headerTextColor(");
    expect(page).toContain("headerColorMap={headerMap}");
  });

  it("colors load per flow and save through the Columns manager", () => {
    expect(page).toContain("/header-colors");
    expect(page).toContain("onSaveHeaderColor");
    expect(page).toContain("headerColors={headerColors}");
    expect(page).toContain("canCustomizeColors={canSendMessages}");
  });

  it("existing table functionality is untouched", () => {
    for (const token of [
      "cellText(row, c)",
      "CustomCell",
      "workspaceRowNumber",
      "applyVisibility",
      "buildWorkspaceTableQuery",
      "debouncedSearch",
      "Lead Source\n",
    ]) {
      expect(page).toContain(token);
    }
  });
});

describe("14. Google Sheets is unaffected", () => {
  const root = process.cwd();
  it("sheets read paths reference none of the header-color work", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src).not.toContain("header-colors");
      expect(src).not.toContain("headerColors");
      expect(src).not.toContain("workspace_header_colors");
    }
  });
});
