import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowTableColumn } from './flow-tables';
import type { WorkspaceField } from './workspace-fields';
import {
  LEAD_SOURCE_VIS_ID,
  ROW_VIS_ID,
  applyVisibility,
  customFieldVisId,
  describeVisibilityMenu,
  filterVisibilityMenu,
  flowColumnVisId,
  loadHiddenIds,
  saveHiddenIds,
  toggleHiddenId,
  visibilityStorageKey,
} from './workspace-visibility';

const FLOW_COLUMNS: FlowTableColumn[] = [
  { key: 'submission_time', label: 'Submission Time', system: true },
  { key: 'name', label: 'Name', system: true },
  { key: 'phone', label: 'Phone Number', system: true },
  { key: 'hotel_category', label: 'Hotel Category', system: false },
  { key: 'travel_month', label: 'Travel Month', system: false },
  { key: 'status', label: 'Status', system: true },
];

function field(id: string, name: string): WorkspaceField {
  return {
    id,
    account_id: 'acct-1',
    flow_id: 'flow-1',
    name,
    field_type: 'text',
    position: 0,
    options: null,
    default_value: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const CUSTOM_FIELDS = [
  field('f-budget', 'Budget'),
  field('f-status', 'Status'),
];

// localStorage stub (vitest runs in node: no DOM storage by default).
const backing = new Map<string, string>();
function stubStorage(throwOnWrite = false) {
  backing.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (throwOnWrite) throw new Error('quota exceeded');
      backing.set(k, String(v));
    },
    removeItem: (k: string) => {
      backing.delete(k);
    },
  });
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('describeVisibilityMenu', () => {
  it('locks Row, Submission Time, Name, Phone Number', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(model.core).toEqual([
      { id: ROW_VIS_ID, label: 'Row', locked: true },
      {
        id: flowColumnVisId('submission_time'),
        label: 'Submission Time',
        locked: true,
      },
      { id: flowColumnVisId('name'), label: 'Name', locked: true },
      { id: flowColumnVisId('phone'), label: 'Phone Number', locked: true },
    ]);
  });

  it('lists dynamic flow columns as hideable and never hardcodes them', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(model.flow).toEqual([
      {
        id: flowColumnVisId('hotel_category'),
        label: 'Hotel Category',
        locked: false,
      },
      {
        id: flowColumnVisId('travel_month'),
        label: 'Travel Month',
        locked: false,
      },
    ]);
  });

  it('never offers the Status system column (tabs already classify)', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    const ids = [...model.core, ...model.flow].map((i) => i.id);
    expect(ids).not.toContain(flowColumnVisId('status'));
  });

  it('keys custom columns by stable field id (never by name)', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(model.custom).toEqual([
      { id: 'custom:f-budget', label: 'Budget', locked: false },
      { id: 'custom:f-status', label: 'Status', locked: false },
    ]);
  });

  it('exposes Lead Source as hideable', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(model.leadSource).toEqual({
      id: LEAD_SOURCE_VIS_ID,
      label: 'Lead Source',
      locked: false,
    });
  });
});

describe('applyVisibility', () => {
  it('hides flow, custom, and Lead Source columns', () => {
    const applied = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, [
      flowColumnVisId('hotel_category'),
      customFieldVisId('f-budget'),
      LEAD_SOURCE_VIS_ID,
    ]);
    expect(applied.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'travel_month',
    ]);
    expect(applied.customFields.map((f) => f.id)).toEqual(['f-status']);
    expect(applied.leadSourceVisible).toBe(false);
  });

  it('keeps locked core columns visible even if hidden (defensive)', () => {
    const applied = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, [
      flowColumnVisId('submission_time'),
      flowColumnVisId('name'),
      flowColumnVisId('phone'),
      ROW_VIS_ID,
    ]);
    expect(applied.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'hotel_category',
      'travel_month',
    ]);
  });

  it('never reorders: a restored column returns to its original position', () => {
    const hidden = [flowColumnVisId('hotel_category')];
    const narrowed = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, hidden);
    expect(narrowed.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'travel_month',
    ]);
    const restored = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, []);
    expect(restored.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'hotel_category',
      'travel_month',
    ]);
  });

  it('show-all/reset (empty set) restores every hideable column', () => {
    const applied = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, []);
    expect(applied.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'hotel_category',
      'travel_month',
    ]);
    expect(applied.customFields.map((f) => f.id)).toEqual([
      'f-budget',
      'f-status',
    ]);
    expect(applied.leadSourceVisible).toBe(true);
  });

  it('never deletes or mutates definitions: inputs come back intact', () => {
    const before = JSON.stringify({ FLOW_COLUMNS, CUSTOM_FIELDS });
    applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, [
      flowColumnVisId('hotel_category'),
      customFieldVisId('f-budget'),
      LEAD_SOURCE_VIS_ID,
    ]);
    expect(JSON.stringify({ FLOW_COLUMNS, CUSTOM_FIELDS })).toBe(before);
    expect(FLOW_COLUMNS).toHaveLength(6);
    expect(CUSTOM_FIELDS).toHaveLength(2);
  });
});

describe('toggleHiddenId', () => {
  it('adds and removes ids with stable sorted output', () => {
    expect(toggleHiddenId([], 'custom:b')).toEqual(['custom:b']);
    expect(toggleHiddenId(['custom:b'], 'custom:a')).toEqual([
      'custom:a',
      'custom:b',
    ]);
    expect(toggleHiddenId(['custom:a', 'custom:b'], 'custom:a')).toEqual([
      'custom:b',
    ]);
  });
});

describe('filterVisibilityMenu (manager search only)', () => {
  const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);

  it('matches labels case-insensitively across sections', () => {
    const filtered = filterVisibilityMenu(model, 'hotel');
    expect(filtered.flow.map((i) => i.label)).toEqual(['Hotel Category']);
    expect(filtered.core).toEqual([]);
    expect(filtered.custom).toEqual([]);
    expect(filtered.leadSource).toBeNull();
  });

  it('empty query returns the full model', () => {
    expect(filterVisibilityMenu(model, '  ')).toEqual(model);
  });

  it('no match empties every section without touching rows', () => {
    const filtered = filterVisibilityMenu(model, 'zzz-no-such-column');
    expect(filtered.core).toEqual([]);
    expect(filtered.flow).toEqual([]);
    expect(filtered.custom).toEqual([]);
    expect(filtered.leadSource).toBeNull();
    // The source model (and therefore the table) is untouched.
    expect(model.flow).toHaveLength(2);
  });

  it('finds Lead Source by name', () => {
    const filtered = filterVisibilityMenu(model, 'lead');
    expect(filtered.leadSource).toEqual({
      id: LEAD_SOURCE_VIS_ID,
      label: 'Lead Source',
      locked: false,
    });
  });
});

describe('visibility persistence (localStorage, per account + flow)', () => {
  it('round-trips a hidden set and survives a reload', () => {
    saveHiddenIds('acct-1', 'flow-1', ['custom:f-budget', LEAD_SOURCE_VIS_ID]);
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([
      'custom:f-budget',
      LEAD_SOURCE_VIS_ID,
    ]);
  });

  it('scopes by flow: one flow never affects another', () => {
    saveHiddenIds('acct-1', 'flow-a', [LEAD_SOURCE_VIS_ID]);
    expect(loadHiddenIds('acct-1', 'flow-b')).toEqual([]);
    expect(loadHiddenIds('acct-1', 'flow-a')).toEqual([LEAD_SOURCE_VIS_ID]);
  });

  it('scopes by account', () => {
    saveHiddenIds('acct-1', 'flow-1', [LEAD_SOURCE_VIS_ID]);
    expect(loadHiddenIds('acct-2', 'flow-1')).toEqual([]);
  });

  it('Completed/Incomplete share one configuration (key ignores view)', () => {
    expect(visibilityStorageKey('acct-1', 'flow-1')).toBe(
      'wacrm:ws-cols:v1:acct-1:flow-1'
    );
  });

  it('saving an empty set removes the key (default = all visible)', () => {
    saveHiddenIds('acct-1', 'flow-1', [LEAD_SOURCE_VIS_ID]);
    expect(backing.has('wacrm:ws-cols:v1:acct-1:flow-1')).toBe(true);
    saveHiddenIds('acct-1', 'flow-1', []);
    expect(backing.has('wacrm:ws-cols:v1:acct-1:flow-1')).toBe(false);
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([]);
  });

  it('corrupt or foreign stored values fall back to all visible', () => {
    backing.set('wacrm:ws-cols:v1:acct-1:flow-1', 'not-json{{{');
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([]);
    backing.set(
      'wacrm:ws-cols:v1:acct-1:flow-1',
      JSON.stringify({ hidden: [LEAD_SOURCE_VIS_ID] })
    );
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([]);
    backing.set(
      'wacrm:ws-cols:v1:acct-1:flow-1',
      JSON.stringify([LEAD_SOURCE_VIS_ID, 42, null])
    );
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([LEAD_SOURCE_VIS_ID]);
  });

  it('never throws when storage is unavailable (private mode)', () => {
    stubStorage(true);
    expect(() =>
      saveHiddenIds('acct-1', 'flow-1', [LEAD_SOURCE_VIS_ID])
    ).not.toThrow();
    vi.unstubAllGlobals();
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([]);
  });
});
