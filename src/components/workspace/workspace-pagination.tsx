'use client';

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  WORKSPACE_PAGE_SIZES,
  formatWorkspaceRange,
  getWorkspacePageItems,
  isWorkspacePageSize,
  type WorkspacePageSize,
} from '@/lib/flows/workspace-pagination';

/**
 * Enterprise pagination footer for the Workspace table.
 *
 * Layout: [rows-per-page + "1–25 of 80"] … [‹‹ ‹ pages › ››] … [Page x of y].
 * Renders OUTSIDE the horizontally scrolling table viewport (the
 * page places it after that container), so controls never scroll
 * away or overflow. Page numbers collapse below the `sm`
 * breakpoint; First/Previous/Next/Last always stay available.
 * All paging math lives in `workspace-pagination.ts` — this
 * component only renders the model (zero-based `page` in,
 * clamped zero-based page out).
 */
export function WorkspacePagination({
  page,
  totalPages,
  total,
  pageSize,
  rowsOnPage,
  disabled,
  onPage,
  onPageSize,
}: {
  /** Zero-based current page. */
  page: number;
  totalPages: number;
  total: number;
  pageSize: WorkspacePageSize;
  rowsOnPage: number;
  disabled?: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: WorkspacePageSize) => void;
}) {
  const safeTotal = Math.max(1, totalPages);
  const current = Math.min(Math.max(0, page), safeTotal - 1);
  const items = getWorkspacePageItems(current, safeTotal);
  const rangeText = formatWorkspaceRange({
    page: current,
    pageSize,
    total,
    rowsOnPage,
  });
  const busy = disabled === true;
  const go = (p: number) => {
    if (busy) return;
    onPage(Math.min(Math.max(0, p), safeTotal - 1));
  };
  const btn =
    'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border px-2 text-[13px] font-medium transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none';

  return (
    <div className="border-border bg-card flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-2 text-[13px]">
      <div className="flex items-center gap-2.5">
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            const size = Number(v);
            if (isWorkspacePageSize(size)) onPageSize(size);
          }}
          disabled={busy}
        >
          <SelectTrigger
            className="border-border bg-card h-8 w-[84px] text-[13px]"
            aria-label="Rows per page"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKSPACE_PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground tabular-nums" aria-live="polite">
          {rangeText}
        </p>
      </div>

      <nav
        className="mx-auto flex items-center gap-1"
        aria-label="Pagination"
      >
        <button
          type="button"
          className={cn(btn, 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}
          disabled={busy || current === 0}
          onClick={() => go(0)}
          aria-label="First page"
        >
          <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(btn, 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}
          disabled={busy || current === 0}
          onClick={() => go(current - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="hidden items-center gap-1 sm:flex">
          {items.map((item, i) =>
            item === 'ellipsis' ? (
              <span
                key={`ellipsis-${i}`}
                className="text-muted-foreground inline-flex h-8 min-w-8 items-center justify-center"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                className={cn(
                  btn,
                  item === current + 1
                    ? 'border-primary bg-primary text-primary-foreground font-semibold'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                aria-label={`Page ${item}`}
                aria-current={item === current + 1 ? 'page' : undefined}
                disabled={busy}
                onClick={() => go(item - 1)}
              >
                {item}
              </button>
            )
          )}
        </span>
        <button
          type="button"
          className={cn(btn, 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}
          disabled={busy || current >= safeTotal - 1}
          onClick={() => go(current + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(btn, 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}
          disabled={busy || current >= safeTotal - 1}
          onClick={() => go(safeTotal - 1)}
          aria-label="Last page"
        >
          <ChevronsRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </nav>

      <p className="text-muted-foreground ml-auto tabular-nums sm:ml-0">
        Page {current + 1} of {safeTotal.toLocaleString()}
      </p>
    </div>
  );
}
