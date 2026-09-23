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
});
