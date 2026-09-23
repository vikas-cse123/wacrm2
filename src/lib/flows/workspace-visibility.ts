// ============================================================
// Workspace column visibility — presentation-layer only.
//
// Hiding a column NEVER deletes data, definitions, or values: it
// only filters what the table renders. Order is always derived
// from the payload, so restoring a column returns it to its
// original position (never appended).
//
// Identity (never display names):
//   flow answer column → `flow:<column.key>` (stable var/node key)
//   custom field       → `custom:<field.id>` (stable UUID)
//   lead source        → `lead_source` (constant)
//
// Locked (always visible, never toggleable):
//   Row (implicit), Submission Time, Name, Phone Number.
// The `status` system column is excluded from the table AND the
// menu by design (the Completed/Incomplete tabs already
// communicate classification).
//
// Persistence is localStorage, scoped `account:flow` — Completed
// and Incomplete deliberately share one configuration per flow,
// and one flow's state can never leak into another's. No API, no
// migration, no effect on Google Sheets (which never reads this).
// ============================================================

import { useCallback, useMemo, useState } from 'react';

import type { FlowTableColumn } from './flow-tables';
import type { WorkspaceField } from './workspace-fields';

export const LEAD_SOURCE_VIS_ID = 'lead_source';
export const ROW_VIS_ID = 'core:row';

/** Flow-column keys that are permanently visible. */
export const LOCKED_FLOW_COLUMN_KEYS: ReadonlySet<string> = new Set([
  'submission_time',
  'name',
  'phone',
]);

/**
 * Display-excluded regardless of visibility state. The Status
 * column stays in the payload (drawer badges, types, API) but is
 * not a table column and is not offered in the menu.
 */
const DISPLAY_EXCLUDED_COLUMN_KEYS: ReadonlySet<string> = new Set(['status']);

export function flowColumnVisId(key: string): string {
  return `flow:${key}`;
}

export function customFieldVisId(id: string): string {
  return `custom:${id}`;
}

export interface VisibilityMenuItem {
  /** Stable visibility id (see above). Locked core rows included. */
  id: string;
  label: string;
  locked: boolean;
}

export interface VisibilityMenuModel {
  /** Locked system columns (Row + Submission Time + Name + Phone). */
  core: VisibilityMenuItem[];
  /** Hideable flow answer columns (dynamic per flow, never hardcoded). */
  flow: VisibilityMenuItem[];
  /** Hideable custom Workspace columns. */
  custom: VisibilityMenuItem[];
  /** Hideable Lead Source pseudo-column. */
  leadSource: VisibilityMenuItem;
}

/**
 * Build the menu model from the live payload. Pure view over the
 * given columns/fields — never mutates, never reorders.
 */
export function describeVisibilityMenu(
  flowColumns: FlowTableColumn[],
  customFields: WorkspaceField[]
): VisibilityMenuModel {
  const core: VisibilityMenuItem[] = [
    { id: ROW_VIS_ID, label: 'Row', locked: true },
  ];
  const flow: VisibilityMenuItem[] = [];
  for (const c of flowColumns) {
    if (DISPLAY_EXCLUDED_COLUMN_KEYS.has(c.key)) continue;
    if (LOCKED_FLOW_COLUMN_KEYS.has(c.key)) {
      core.push({ id: flowColumnVisId(c.key), label: c.label, locked: true });
    } else {
      flow.push({ id: flowColumnVisId(c.key), label: c.label, locked: false });
    }
  }
  return {
    core,
    flow,
    custom: customFields.map((f) => ({
      id: customFieldVisId(f.id),
      label: f.name,
      locked: false,
    })),
    leadSource: { id: LEAD_SOURCE_VIS_ID, label: 'Lead Source', locked: false },
  };
}

/**
 * Filter a menu model by the manager search query (case-insensitive
 * substring on labels). Filters the manager list ONLY — table rows
 * are never touched. Sections with zero matches come back empty
 * (the UI hides them); a non-matching Lead Source comes back null.
 */
export function filterVisibilityMenu(
  model: VisibilityMenuModel,
  query: string
): Omit<VisibilityMenuModel, 'leadSource'> & {
  leadSource: VisibilityMenuItem | null;
} {
  const q = query.trim().toLowerCase();
  if (!q) return model;
  const match = (item: VisibilityMenuItem) =>
    item.label.toLowerCase().includes(q);
  return {
    core: model.core.filter(match),
    flow: model.flow.filter(match),
    custom: model.custom.filter(match),
    leadSource: match(model.leadSource) ? model.leadSource : null,
  };
}

export interface AppliedVisibility {
  /** Flow columns to render (status excluded, order preserved). */
  flowColumns: FlowTableColumn[];
  /** Custom fields to render (order preserved). */
  customFields: WorkspaceField[];
  /** Whether the Lead Source column renders (always final). */
  leadSourceVisible: boolean;
}

/**
 * Apply a hidden-id set to the live payload. Pure filter — input
 * arrays are never mutated and order is never changed, so an
 * unhidden column automatically returns to its original position.
 * Locked core columns render even if their id somehow lands in the
 * hidden set (defensive; the UI never offers that toggle).
 */
export function applyVisibility(
  flowColumns: FlowTableColumn[],
  customFields: WorkspaceField[],
  hiddenIds: readonly string[]
): AppliedVisibility {
  const hidden = new Set(hiddenIds);
  return {
    flowColumns: flowColumns.filter(
      (c) =>
        !DISPLAY_EXCLUDED_COLUMN_KEYS.has(c.key) &&
        (LOCKED_FLOW_COLUMN_KEYS.has(c.key) ||
          !hidden.has(flowColumnVisId(c.key)))
    ),
    customFields: customFields.filter(
      (f) => !hidden.has(customFieldVisId(f.id))
    ),
    leadSourceVisible: !hidden.has(LEAD_SOURCE_VIS_ID),
  };
}

/** Toggle one id in a hidden set. Pure; output sorted for stable storage. */
export function toggleHiddenId(
  hiddenIds: readonly string[],
  id: string
): string[] {
  const next = new Set(hiddenIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return [...next].sort();
}

// ------------------------------------------------------------
// Persistence (localStorage, per account + flow).
// ------------------------------------------------------------

const STORAGE_PREFIX = 'wacrm:ws-cols:v1';

export function visibilityStorageKey(
  accountId: string,
  flowId: string
): string {
  return `${STORAGE_PREFIX}:${accountId}:${flowId}`;
}

function storage(): Storage | null {
  try {
    // `typeof` guard: SSR prerender and bare-node have no localStorage.
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Hidden ids for this scope. Corrupt/foreign values → default (all visible). */
export function loadHiddenIds(accountId: string, flowId: string): string[] {
  try {
    const raw = storage()?.getItem(visibilityStorageKey(accountId, flowId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').sort();
  } catch {
    return [];
  }
}

/**
 * Persist a hidden set. Empty sets remove the key (default state =
 * key absent). Never throws — private-mode quota errors degrade to
 * session-only visibility.
 */
export function saveHiddenIds(
  accountId: string,
  flowId: string,
  hiddenIds: readonly string[]
): void {
  try {
    const store = storage();
    if (!store) return;
    const key = visibilityStorageKey(accountId, flowId);
    if (hiddenIds.length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify([...hiddenIds].sort()));
  } catch {
    // Session-only fallback: state still lives in React.
  }
}

export interface WorkspaceVisibility {
  /** Currently hidden visibility ids for the active scope. */
  hiddenIds: string[];
  toggle: (id: string) => void;
  /** Make every hideable column visible (core untouched — always visible). */
  showAll: () => void;
  /** Restore the default configuration (all visible; definitions/data intact). */
  reset: () => void;
}

/**
 * Effect-free visibility state for the Workspace page. The active
 * scope derives from (accountId, flowId) every render, so switching
 * flows, views, pages, or searches never needs a synchronizing
 * effect — each scope simply reads its own stored set, with
 * in-session overrides layered on top.
 */
export function useWorkspaceVisibility(
  accountId: string | null,
  flowId: string | null
): WorkspaceVisibility {
  const [overrides, setOverrides] = useState<Record<string, string[]>>({});
  const scoped = accountId !== null && flowId !== null;
  const scopeKey = scoped ? visibilityStorageKey(accountId, flowId) : null;
  const hiddenIds = useMemo(
    () =>
      scopeKey !== null && accountId !== null && flowId !== null
        ? (overrides[scopeKey] ?? loadHiddenIds(accountId, flowId))
        : [],
    [scopeKey, accountId, flowId, overrides]
  );

  const commit = useCallback(
    (next: string[]) => {
      if (
        !scoped ||
        accountId === null ||
        flowId === null ||
        scopeKey === null
      ) {
        return;
      }
      saveHiddenIds(accountId, flowId, next);
      setOverrides((prev) => ({ ...prev, [scopeKey]: next }));
    },
    [scoped, accountId, flowId, scopeKey]
  );

  const toggle = useCallback(
    (id: string) => {
      commit(toggleHiddenId(hiddenIds, id));
    },
    [commit, hiddenIds]
  );

  const showAll = useCallback(() => {
    commit([]);
  }, [commit]);

  const reset = useCallback(() => {
    commit([]);
  }, [commit]);

  return { hiddenIds, toggle, showAll, reset };
}
