'use client';

import { useRef } from 'react';
import {
  WORKSPACE_COLUMN_MAX_WIDTH,
  WORKSPACE_COLUMN_MIN_WIDTH,
} from '@/lib/flows/workspace-column-widths';
import { cn } from '@/lib/utils';

interface DragState {
  startX: number;
  startWidth: number;
  latest: number;
}

function clampWidth(px: number): number {
  return Math.min(
    WORKSPACE_COLUMN_MAX_WIDTH,
    Math.max(WORKSPACE_COLUMN_MIN_WIDTH, Math.round(px)),
  );
}

/**
 * Sheets-style column resize handle: an invisible-until-hover
 * grip on a header cell's right boundary. Pointer-drag resizes
 * the column live (header + body stay synced — both read the
 * same width state); release commits (the page persists).
 *
 * No buttons, no icons, no sorting side effects: pointerdown is
 * captured + stopped, and the page applies viewport-level
 * select-none while a drag is active, so no text selection and
 * no stray clicks can occur mid-drag.
 */
export function ColumnResizeHandle({
  columnKey,
  onResize,
  onCommit,
  onActiveChange,
}: {
  /** Stable visibility id of the column being resized. */
  columnKey: string;
  /** Live width updates during the drag (already clamped). */
  onResize: (columnKey: string, widthPx: number) => void;
  /** Final width on release (page persists; skips when unchanged). */
  onCommit: (columnKey: string, widthPx: number) => void;
  /** Drag active/inactive (page toggles select-none). */
  onActiveChange: (active: boolean) => void;
}) {
  const drag = useRef<DragState | null>(null);

  return (
    <span
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Never start a text selection or trip header clicks.
        e.preventDefault();
        e.stopPropagation();
        const th = e.currentTarget.closest('th');
        const startWidth = th?.getBoundingClientRect().width ?? 0;
        if (startWidth <= 0) return;
        drag.current = { startX: e.clientX, startWidth, latest: clampWidth(startWidth) };
        e.currentTarget.setPointerCapture(e.pointerId);
        onActiveChange(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        e.preventDefault();
        d.latest = clampWidth(d.startWidth + (e.clientX - d.startX));
        onResize(columnKey, d.latest);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        onActiveChange(false);
        if (d) onCommit(columnKey, d.latest);
      }}
      onPointerCancel={(e) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        onActiveChange(false);
      }}
      className={cn(
        'absolute inset-y-0 right-0 flex w-2 cursor-col-resize touch-none justify-center',
        'transition-colors hover:bg-primary/40 active:bg-primary/60',
      )}
    />
  );
}
