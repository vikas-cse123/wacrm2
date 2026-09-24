// ============================================================
// Workspace enterprise grid — sticky-column geometry.
//
// Exactly four left-side structural columns stay pinned while
// the table scrolls horizontally inside its own viewport:
//   No. (row number) + Submission Time + Name + Phone Number.
//
// Every other column (flow answers, custom Workspace columns
// such as Assigned To … Final Remark, Lead Source last) scrolls.
// The sticky header (top) + sticky columns (left) share these
// numbers, so header and body can never misalign: both read the
// same width/left per column key.
//
// Responsiveness: widths are per-COLUMN px (the scrollport
// absorbs them on narrow screens — the page itself never
// scrolls sideways). No viewport/container pixel widths are
// hardcoded; the viewport height is viewport-relative (70vh).
// Left offsets are DERIVED (cumulative), never hand-synced.
// ============================================================

import type { CSSProperties } from "react";

import { coerceColumnWidth } from "@/lib/flows/workspace-column-widths";

/** Flow-table column keys pinned to the left (render order). */
export const STICKY_FLOW_COLUMN_KEYS: readonly string[] = [
  "submission_time",
  "name",
  "phone",
];

/** Identity for the row-number ("No.") column. */
export const STICKY_ROW_COLUMN_KEY = "__row";

/** Fixed content widths (px) for the pinned columns. */
export const STICKY_COLUMN_WIDTHS: Readonly<Record<string, number>> = {
  [STICKY_ROW_COLUMN_KEY]: 40,
  submission_time: 150,
  name: 170,
  phone: 150,
};

/** Render order of the pinned block, row-number first. */
export const STICKY_COLUMN_ORDER: readonly string[] = [
  STICKY_ROW_COLUMN_KEY,
  ...STICKY_FLOW_COLUMN_KEYS,
];

/** Total pinned width (px) — informational for tests/docs. */
export const STICKY_TOTAL_WIDTH: number = STICKY_COLUMN_ORDER.reduce(
  (sum, key) => sum + (STICKY_COLUMN_WIDTHS[key] ?? 0),
  0,
);

/** Cumulative left offsets (px), derived from widths in order. */
export const STICKY_COLUMN_OFFSETS: Readonly<Record<string, number>> =
  (() => {
    const offsets: Record<string, number> = {};
    let left = 0;
    for (const key of STICKY_COLUMN_ORDER) {
      offsets[key] = left;
      left += STICKY_COLUMN_WIDTHS[key] ?? 0;
    }
    return offsets;
  })();

/** True for the row-number column or a pinned flow column key. */
export function isStickyColumnKey(key: string): boolean {
  return (STICKY_COLUMN_ORDER as readonly string[]).includes(key);
}

/**
 * Inline geometry for one pinned column: identical object for its
 * header cell and every body cell, which is what keeps header
 * and body aligned. Returns null for scrolling columns.
 *
 * NOTE: width-unaware (defaults only). Resizing flows through
 * resolveStickyLayouts below, which is the single writer of
 * sticky geometry once user widths exist.
 */
export function stickyColumnStyle(key: string): CSSProperties | null {
  if (!isStickyColumnKey(key)) return null;
  const width = STICKY_COLUMN_WIDTHS[key] ?? 0;
  const left = STICKY_COLUMN_OFFSETS[key] ?? 0;
  return { left, width, minWidth: width };
}

/**
 * Layering: scrolling body (0) < pinned body (10) < scrolling
 * header (20) < pinned header corner (30). Opaque card
 * backgrounds on every pinned/stuck cell keep scrolled content
 * from bleeding through.
 */
export const STICKY_Z = {
  body: "z-10",
  head: "z-20",
  corner: "z-30",
} as const;

export interface StickyColumnGeometry {
  left: number;
  width: number;
  minWidth: number;
}

/**
 * Width-aware sticky geometry for the whole pinned block, in ONE
 * pass: each column's left is the exact sum of its predecessors'
 * resolved widths, so resizing can never open gaps or overlaps.
 * A stored width overrides its column's default (read-clamped to
 * the safe band); absent entries keep defaults. Unknown keys are
 * absent from the result — scrolling columns never pin.
 */
export function resolveStickyLayouts(
  visIdFor: (stickyKey: string) => string,
  widths?: Readonly<Record<string, unknown>> | null,
): Record<string, StickyColumnGeometry> {
  const out: Record<string, StickyColumnGeometry> = {};
  let left = 0;
  for (const key of STICKY_COLUMN_ORDER) {
    const fallback = STICKY_COLUMN_WIDTHS[key] ?? 0;
    const raw = widths?.[visIdFor(key)];
    const width =
      raw === undefined || raw === null || raw === ""
        ? fallback
        : coerceColumnWidth(raw, fallback);
    out[key] = { left, width, minWidth: width };
    left += width;
  }
  return out;
}
