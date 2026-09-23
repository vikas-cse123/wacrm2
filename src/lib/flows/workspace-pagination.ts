// ============================================================
// Workspace table pagination helpers — pure, unit-testable.
//
// The table is paginated SERVER-side (page + pageSize ride the
// table request key); these helpers only describe the page-size
// control and its display. Default 25; changing size always
// restarts at page 1 so the index can never go stale.
// ============================================================

/** The exact page-size options offered by the Workspace control. */
export const WORKSPACE_PAGE_SIZES = [25, 50, 75, 100] as const;

export type WorkspacePageSize = (typeof WORKSPACE_PAGE_SIZES)[number];

/** Rows per page when the user hasn't chosen otherwise. */
export const DEFAULT_WORKSPACE_PAGE_SIZE: WorkspacePageSize = 25;

export function isWorkspacePageSize(value: unknown): value is WorkspacePageSize {
  return (
    typeof value === "number" &&
    (WORKSPACE_PAGE_SIZES as readonly number[]).includes(value)
  );
}

export interface WorkspacePage {
  /** Zero-based page index. */
  page: number;
  pageSize: WorkspacePageSize;
}

/**
 * Apply a page-size change: adopt the new size and restart at page
 * 1 (page index 0). View/search/selection are the caller's concern
 * and are never touched here.
 */
export function applyWorkspacePageSizeChange(
  nextSize: WorkspacePageSize,
): WorkspacePage {
  return { page: 0, pageSize: nextSize };
}

/**
 * UI-only row number for the "#" column: the row's 1-based position
 * in the full result set. `page` is zero-based, `index` is the
 * row's zero-based position on the current page. Never stored —
 * derived from pagination state on every render.
 */
export function workspaceRowNumber(args: {
  page: number;
  pageSize: number;
  index: number;
}): number {
  return args.page * args.pageSize + args.index + 1;
}

/**
 * "1–25 of 5,581" range line for the pagination header. `page` is
 * zero-based; `rowsOnPage` is how many rows the current page
 * actually holds (last page may be short).
 */
export function formatWorkspaceRange(args: {
  page: number;
  pageSize: number;
  total: number;
  rowsOnPage: number;
}): string {
  const { page, pageSize, total, rowsOnPage } = args;
  if (total <= 0 || rowsOnPage <= 0) return `0 of ${total.toLocaleString()}`;
  const from = page * pageSize + 1;
  const to = Math.min(total, page * pageSize + rowsOnPage);
  return `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`;
}
