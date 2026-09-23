import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  WORKSPACE_PAGE_SIZES,
  applyWorkspacePageSizeChange,
  formatWorkspaceRange,
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
