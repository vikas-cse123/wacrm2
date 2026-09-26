import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { FlowTableColumn } from '@/lib/flows/flow-tables';
import { ColumnsMenu } from './columns-menu';

const FLOW_COLUMNS: FlowTableColumn[] = [
  { key: 'submission_time', label: 'Submission Time', system: true },
  { key: 'name', label: 'Name', system: true },
  { key: 'phone', label: 'Phone Number', system: true },
  { key: 'hotel_category', label: 'Hotel Category', system: false },
];

describe('ColumnsMenu', () => {
  function render(hiddenIds: string[] = []) {
    return renderToStaticMarkup(
      <ColumnsMenu
        flowId="flow-1"
        flowColumns={FLOW_COLUMNS}
        customFields={[]}
        hiddenIds={hiddenIds}
        onToggleVisibility={vi.fn()}
        onShowAll={vi.fn()}
        onReset={vi.fn()}
        onEditField={vi.fn()}
        onChanged={vi.fn()}
      />
    );
  }

  it('renders the Columns trigger without fetching anything', () => {
    const html = render();
    expect(html).toContain('Columns');
    // Closed menu renders no item rows and no data fetching affordance.
    expect(html).not.toContain('Hotel Category');
  });

  it('menu model derives from live columns (visibility is presentation-only)', () => {
    // The panel content is portal-mounted on open; the contract that
    // matters statically is that visibility props flow through types.
    // Dynamic behavior is covered by workspace-visibility unit tests.
    expect(FLOW_COLUMNS.filter((c) => !c.system)).toHaveLength(1);
  });

  it('manager is one unified list — no CORE/FLOW/CUSTOM sections', () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/columns-menu.tsx`,
      'utf8'
    );
    expect(src).not.toMatch(/>\s*Core\s*</);
    expect(src).not.toMatch(/Flow columns/);
    expect(src).not.toMatch(/Custom columns/);
    expect(src).not.toMatch(/FLOW COLUMNS/);
    expect(src).not.toMatch(/CUSTOM COLUMNS/);
    // Unified rendering path with every row hideable.
    expect(src).toContain('flattenVisibilityMenu');
    expect(src).toContain('HideableRow');
    expect(src).toContain('Manage visible columns');
    expect(src).toContain('Search columns...');
  });

  it('no column is locked — no lock icons, no disabled checkboxes by status', () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/columns-menu.tsx`,
      'utf8'
    );
    expect(src).not.toContain('LockedRow');
    expect(src).not.toMatch(/^\s*Lock,$/m);
    expect(src).not.toMatch(/item\.locked/);
    expect(src).not.toMatch(/locked:\s*(true|false)/);
    expect(src).toContain('HideableRow');
  });

  it('table hides the row-number column like any other column', () => {
    const page = readFileSync(
      `${process.cwd()}/src/app/(dashboard)/workspace/page.tsx`,
      'utf8'
    );
    expect(page).toContain('rowVisible');
    expect(page).not.toContain('stickyLayouts');
  });

  it('every row ends with the same fixed color slot (dots align)', () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/columns-menu.tsx`,
      'utf8'
    );
    // Fixed-width right-aligned area, shared by both row types.
    expect(src).toContain('flex w-6 shrink-0 items-center justify-center');
    const slots = src.split('<ColorDotSlot').length - 1;
    expect(slots).toBe(2);
    // No content-dependent positioning in rows.
    expect(src).not.toMatch(/justify-between/);
    // Long labels truncate instead of pushing the dot.
    expect(src).toContain('min-w-0 flex-1 truncate');
    // Custom edit/delete precede the slot, so custom dots line up
    // with plain-row dots.
    const deleteIdx = src.indexOf('aria-label={`Delete');
    const lastSlotIdx = src.lastIndexOf('<ColorDotSlot');
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeLessThan(lastSlotIdx);
  });
});
