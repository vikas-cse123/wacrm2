import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  WORKSPACE_PAGE_SIZES,
  applyWorkspacePageSizeChange,
  formatWorkspaceRange,
  getWorkspacePageItems,
  isWorkspacePageSize,
  workspaceRowNumber,
} from "./workspace-pagination";

describe("workspace pagination", () => {
  it("defaults to 25 rows per page", () => {
    expect(DEFAULT_WORKSPACE_PAGE_SIZE).toBe(25);
  });

  it("offers exactly 25, 50, 75, 100", () => {
    expect([...WORKSPACE_PAGE_SIZES]).toEqual([25, 50, 75, 100]);
    expect(isWorkspacePageSize(25)).toBe(true);
    expect(isWorkspacePageSize(50)).toBe(true);
    expect(isWorkspacePageSize(75)).toBe(true);
    expect(isWorkspacePageSize(100)).toBe(true);
    expect(isWorkspacePageSize(10)).toBe(false);
    expect(isWorkspacePageSize(200)).toBe(false);
    expect(isWorkspacePageSize("50")).toBe(false);
  });

  it("changing page size restarts at page 1 without touching anything else", () => {
    for (const size of WORKSPACE_PAGE_SIZES) {
      expect(applyWorkspacePageSizeChange(size)).toEqual({ page: 0, pageSize: size });
    }
  });

  it("formats the range line per page size", () => {
    const total = 5581;
    expect(
      formatWorkspaceRange({ page: 0, pageSize: 25, total, rowsOnPage: 25 }),
    ).toBe("1–25 of 5,581");
    expect(
      formatWorkspaceRange({ page: 0, pageSize: 50, total, rowsOnPage: 50 }),
    ).toBe("1–50 of 5,581");
    expect(
      formatWorkspaceRange({ page: 0, pageSize: 75, total, rowsOnPage: 75 }),
    ).toBe("1–75 of 5,581");
    expect(
      formatWorkspaceRange({ page: 0, pageSize: 100, total, rowsOnPage: 100 }),
    ).toBe("1–100 of 5,581");
  });

  it("handles short last pages and empty tables", () => {
    expect(
      formatWorkspaceRange({ page: 2, pageSize: 25, total: 60, rowsOnPage: 10 }),
    ).toBe("51–60 of 60");
    expect(
      formatWorkspaceRange({ page: 0, pageSize: 25, total: 0, rowsOnPage: 0 }),
    ).toBe("0 of 0");
  });
});

describe("workspaceRowNumber", () => {
  it("numbers the first page 1–25", () => {
    expect(workspaceRowNumber({ page: 0, pageSize: 25, index: 0 })).toBe(1);
    expect(workspaceRowNumber({ page: 0, pageSize: 25, index: 24 })).toBe(25);
  });

  it("continues across pages instead of restarting at 1", () => {
    expect(workspaceRowNumber({ page: 1, pageSize: 25, index: 0 })).toBe(26);
    expect(workspaceRowNumber({ page: 1, pageSize: 25, index: 24 })).toBe(50);
    expect(workspaceRowNumber({ page: 2, pageSize: 25, index: 0 })).toBe(51);
  });

  it("reflects 50/75/100 page sizes", () => {
    expect(workspaceRowNumber({ page: 0, pageSize: 50, index: 49 })).toBe(50);
    expect(workspaceRowNumber({ page: 1, pageSize: 50, index: 0 })).toBe(51);
    expect(workspaceRowNumber({ page: 0, pageSize: 75, index: 74 })).toBe(75);
    expect(workspaceRowNumber({ page: 1, pageSize: 75, index: 0 })).toBe(76);
    expect(workspaceRowNumber({ page: 0, pageSize: 100, index: 99 })).toBe(100);
    expect(workspaceRowNumber({ page: 2, pageSize: 100, index: 0 })).toBe(201);
  });
});

describe("getWorkspacePageItems (compact deterministic page buttons)", () => {
  it("lists every page without ellipsis when total fits", () => {
    expect(getWorkspacePageItems(0, 1)).toEqual([1]);
    expect(getWorkspacePageItems(2, 4)).toEqual([1, 2, 3, 4]);
    expect(getWorkspacePageItems(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("first page of many shows head, ellipsis, last", () => {
    expect(getWorkspacePageItems(0, 18)).toEqual([1, 2, "ellipsis", 18]);
  });

  it("middle page shows first, window, ellipsis, last", () => {
    expect(getWorkspacePageItems(9, 18)).toEqual([
      1,
      "ellipsis",
      9,
      10,
      11,
      "ellipsis",
      18,
    ]);
  });

  it("final page shows first, ellipsis, tail", () => {
    expect(getWorkspacePageItems(17, 18)).toEqual([1, "ellipsis", 17, 18]);
  });

  it("stays compact and deterministic for large counts", () => {
    for (const [page, total] of [
      [0, 500],
      [123, 500],
      [499, 500],
      [7, 9],
    ] as const) {
      const a = getWorkspacePageItems(page, total);
      expect(a).toEqual(getWorkspacePageItems(page, total));
      // At most 5 numbers + 2 ellipsis markers.
      expect(a.length).toBeLessThanOrEqual(7);
      expect(a[0]).toBe(1);
      expect(a[a.length - 1]).toBe(total);
    }
  });

  it("clamps out-of-range input instead of inventing pages", () => {
    expect(getWorkspacePageItems(-3, 18)[0]).toBe(1);
    const last = getWorkspacePageItems(99, 18);
    expect(last[last.length - 1]).toBe(18);
    expect(getWorkspacePageItems(0, 0)).toEqual([1]);
  });

  it("recalculates correctly when page size changes the totals", () => {
    // 80 rows: 25/page → 4 pages, 50/page → 2 pages; size change
    // restarts at page 1 in both cases.
    expect(Math.ceil(80 / 25)).toBe(4);
    expect(Math.ceil(80 / 50)).toBe(2);
    expect(applyWorkspacePageSizeChange(50)).toEqual({ page: 0, pageSize: 50 });
    expect(getWorkspacePageItems(0, 4)).toEqual([1, 2, 3, 4]);
  });

  it("formats the 1–25 of 80 style range", () => {
    expect(
      formatWorkspaceRange({ page: 0, pageSize: 25, total: 80, rowsOnPage: 25 })
    ).toBe("1–25 of 80");
  });
});
