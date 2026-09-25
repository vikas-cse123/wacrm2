'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Inbox, Plus, Search, Table2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import type { WorkspaceField } from '@/lib/flows/workspace-fields';
import {
  isAssigneeField,
  type AssigneeMember,
} from '@/lib/flows/workspace-assignee';
import {
  ALL_ASSIGNEES,
  buildWorkspaceTableQuery,
  hasActiveWorkspaceFilters,
  serializeAssigneeSelection,
  type WorkspaceAssigneeSelection,
} from '@/lib/flows/workspace-filters';
import { AddColumnDialog } from '@/components/workspace/add-column-dialog';
import { AdSourceCell } from '@/components/workspace/ad-source-cell';
import { ColumnsMenu } from '@/components/workspace/columns-menu';
import { CustomCell } from '@/components/workspace/custom-cell';
import {
  WorkspaceFilters,
  type AppliedDateFilter,
} from '@/components/workspace/workspace-filters';
import { ColumnResizeHandle } from '@/components/workspace/column-resize-handle';
import {
  STICKY_ROW_COLUMN_KEY,
  STICKY_Z,
  resolveStickyLayouts,
} from '@/components/workspace/sticky-columns';
import { columnWidthStyle } from '@/lib/flows/workspace-column-widths';
import {
  headerTextColor,
  buildHeaderColorMap,
  resolveHeaderColor,
} from '@/lib/flows/header-colors';
import {
  customFieldVisId,
  flowColumnVisId,
  LEAD_SOURCE_VIS_ID,
  ROW_VIS_ID,
} from '@/lib/flows/workspace-visibility';
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  WORKSPACE_PAGE_SIZES,
  applyWorkspacePageSizeChange,
  formatWorkspaceRange,
  isWorkspacePageSize,
  workspaceRowNumber,
  type WorkspacePageSize,
} from '@/lib/flows/workspace-pagination';
import type {
  FlowTableColumn,
  FlowTablePayload,
  FlowTableRow,
  FlowTableView,
} from '@/lib/flows/flow-tables';
import { flowColumnRenderKey, flowDisplayName } from '@/lib/flows/flow-tables';
import {
  applyVisibility,
  useWorkspaceVisibility,
} from '@/lib/flows/workspace-visibility';
import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';

interface FlowOption {
  id: string;
  name: string | null;
}

const VIEWS: Array<{ id: Exclude<FlowTableView, 'all'>; label: string }> = [
  { id: 'completed', label: 'Completed' },
  { id: 'incomplete', label: 'Incomplete' },
];

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusBadge({ status }: { status: FlowTableRow['status'] }) {
  const completed = status === 'completed';
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1.5 text-xs font-normal',
        completed
          ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
          : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          completed ? 'bg-emerald-500' : 'bg-amber-500'
        )}
      />
      {completed ? 'Completed' : 'Incomplete'}
    </Badge>
  );
}

/**
 * Plain-text content for one flow (non-custom) table cell. Empty
 * values render BLANK (never a dash placeholder) — display-only;
 * the underlying row data is untouched.
 */
export function cellText(row: FlowTableRow, column: FlowTableColumn): string {
  switch (column.key) {
    case 'name':
      return row.name ?? '';
    case 'phone':
      return row.phone ?? '';
    case 'submission_time':
      return formatDateTime(row.startedAt);
    case 'status':
      return row.status === 'completed' ? 'Completed' : 'Incomplete';
    default:
      return row.answers[column.key] ?? '';
  }
}

export default function WorkspacePage() {
  const { accountId, canEditSettings, canSendMessages } = useAuth();
  const [flows, setFlows] = useState<FlowOption[] | null>(null);
  const [flowsError, setFlowsError] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [view, setView] = useState<FlowTableView>('completed');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<WorkspacePageSize>(
    DEFAULT_WORKSPACE_PAGE_SIZE
  );
  const [payload, setPayload] = useState<FlowTablePayload | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FlowTableRow | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [editingField, setEditingField] = useState<WorkspaceField | null>(null);
  // Workspace filters (Date over Submission Time + Assigned To over
  // the live roster). Applied state only — the panel owns its
  // draft. Both are server-side: they ride the table request, so
  // pagination, views, search, visibility, and ordering are
  // preserved on the FILTERED set.
  const [appliedDate, setAppliedDate] = useState<AppliedDateFilter | null>(null);
  const [appliedAssignee, setAppliedAssignee] =
    useState<WorkspaceAssigneeSelection>(ALL_ASSIGNEES);
  // Header background overrides by stable visibility id
  // (`core:row`, `flow:<key>`, `custom:<uuid>`, `lead_source`).
  // Server-persisted per (account, flow); defaults resolve in
  // code, so visibility changes never disturb colors.
  const [headerColors, setHeaderColors] = useState<Record<string, string>>({});
  // Column widths by stable visibility id. Absent = natural width
  // (current visuals are the initial state). Server-persisted per
  // (account, flow), independent of visibility and filters — never
  // part of the table request key, so resizing never refetches.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  // Active resize drag (viewport-level select-none while set).
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  // Live account roster for the "Assigned To" column — the SAME
  // source as Settings → Team Members (GET /api/account/members,
  // RLS-scoped to this account). Fetched once per page mount so a
  // newly added teammate appears with no code change; a removed
  // teammate simply stops being listed. Stored cells keep stable
  // user_ids — names resolve at render from this list.
  const [teamMembers, setTeamMembers] = useState<AssigneeMember[]>([]);
  // Optimistic custom-cell overrides, keyed by request so a stale
  // edit can never leak into a newer fetch (no effect needed —
  // mismatched keys are simply ignored on read).
  const [valueOverrides, setValueOverrides] = useState<{
    key: string | null;
    map: Record<string, Record<string, string | null>>;
  }>({ key: null, map: {} });

  // Account-scoped flow list (same source as the rest of the app).
  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/flows', { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Couldn't load flows (${res.status})`);
        const json = (await res.json()) as {
          flows?: Array<{ id: string; name?: string | null }>;
        };
        const list = (json.flows ?? []).map((f) => ({
          id: f.id,
          name: f.name ?? null,
        }));
        if (ctrl.signal.aborted) return;
        setFlows(list);
        setFlowId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setFlowsError(
          err instanceof Error ? err.message : "Couldn't load flows."
        );
        setFlows([]);
      });
    return () => ctrl.abort();
  }, []);

  // Assigned-To roster — same endpoint as Settings → Team Members.
  // Best-effort: a failed fetch leaves [] so Clear + Unassigned
  // still work and preserved legacy values keep rendering as-is.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/account/members', { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          members?: Array<{ user_id: string; full_name?: string | null }>;
        } | null;
        if (ctrl.signal.aborted || !json || !Array.isArray(json.members)) return;
        setTeamMembers(
          json.members
            .filter((m) => typeof m?.user_id === 'string' && m.user_id)
            .map((m) => ({
              user_id: m.user_id,
              full_name: m.full_name ?? null,
            }))
        );
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // Header-color overrides — same account/flow scope as the
  // table itself. Best-effort: a failed fetch leaves {} so every
  // column simply paints its default pastel.
  useEffect(() => {
    if (!flowId) return;
    const ctrl = new AbortController();
    fetch(`/api/flows/${flowId}/header-colors`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          colors?: Record<string, string>;
        } | null;
        if (ctrl.signal.aborted || !json || typeof json.colors !== 'object')
          return;
        setHeaderColors(json.colors ?? {});
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [flowId]);

  // Column widths — same account/flow scope as the table
  // itself. Best-effort: a failed fetch leaves {} so every
  // column simply keeps its natural width.
  useEffect(() => {
    if (!flowId) return;
    const ctrl = new AbortController();
    fetch(`/api/flows/${flowId}/column-widths`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          widths?: Record<string, number>;
        } | null;
        if (ctrl.signal.aborted || !json || typeof json.widths !== 'object')
          return;
        const clean: Record<string, number> = {};
        for (const [key, value] of Object.entries(json.widths ?? {})) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            clean[key] = value;
          }
        }
        setColumnWidths(clean);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [flowId]);

  // Debounced search; resets to the first page.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(0);
    }, 400);
    return () => window.clearTimeout(t);
  }, [search]);

  const selectFlow = useCallback((id: string | null) => {
    if (!id) return;
    setFlowId(id);
    setView('completed');
    setPage(0);
    setSelected(null);
  }, []);

  const selectView = useCallback((v: Exclude<FlowTableView, 'all'>) => {
    setView(v);
    setPage(0);
  }, []);

  const applyFilters = useCallback(
    (date: AppliedDateFilter | null, assignee: WorkspaceAssigneeSelection) => {
      setAppliedDate(date);
      setAppliedAssignee(assignee);
      setPage(0);
      setSelected(null);
    },
    []
  );

  // Persist one column's header tint (null resets to the default).
  // Optimistic: paint immediately, revert + toast when the server
  // rejects (same pattern as the Members tab role editor).
  const handleSaveHeaderColor = useCallback(
    async (columnKey: string, color: string | null) => {
      if (!flowId) return;
      const previous = headerColors;
      setHeaderColors((prev) => {
        const next = { ...prev };
        if (color === null) delete next[columnKey];
        else next[columnKey] = color;
        return next;
      });
      try {
        const res = await fetch(`/api/flows/${flowId}/header-colors`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ column_key: columnKey, color }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            (payload as { error?: string }).error ?? 'Could not save the color.'
          );
        }
      } catch (err) {
        setHeaderColors(previous);
        toast.error(
          err instanceof Error ? err.message : 'Could not save the color.'
        );
      }
    },
    [flowId, headerColors]
  );

  // Header paint helpers live below the visibility memo (they
  // need the visible column set for the uniqueness map).

  const selectPageSize = useCallback((value: string | null) => {
    if (value === null) return;
    const size = Number(value);
    if (!isWorkspacePageSize(size)) return;
    const next = applyWorkspacePageSizeChange(size);
    setPageSize(next.pageSize);
    setPage(next.page);
  }, []);

  // Table rows: server-filtered + paginated per (flow, view, search,
  // filters, page). Loading is DERIVED (requested vs loaded key) so
  // the fetch effect never sets state synchronously — responses
  // reconcile by key, and a stale response for an older key is
  // ignored.
  const appliedDateRange = appliedDate?.range ?? null;
  const requestKey = flowId
    ? `${flowId}|${view}|${debouncedSearch}|${appliedDateRange?.from ?? ''}|${appliedDateRange?.to ?? ''}|${serializeAssigneeSelection(appliedAssignee)}|${page}|${pageSize}`
    : null;
  const loading = requestKey !== null && requestKey !== loadedKey;
  useEffect(() => {
    if (!flowId || !requestKey) return;
    const ctrl = new AbortController();
    const qs = buildWorkspaceTableQuery({
      view,
      search: debouncedSearch,
      page,
      pageSize,
      dateRange: appliedDateRange,
      assignee: appliedAssignee,
    });
    fetch(`/api/flows/${flowId}/table?${qs}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          (FlowTablePayload & { error?: unknown }) | null;
        if (!res.ok || !json || !('rows' in json)) {
          throw new Error(
            json && typeof json.error === 'string'
              ? json.error
              : `Couldn't load table (${res.status})`
          );
        }
        if (ctrl.signal.aborted) return;
        setPayload(json as FlowTablePayload);
        setTableError(null);
        setLoadedKey(requestKey);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (ctrl.signal.aborted) return;
        setTableError(
          err instanceof Error ? err.message : "Couldn't load table."
        );
        setLoadedKey(requestKey);
      });
    return () => ctrl.abort();
  }, [flowId, requestKey, view, debouncedSearch, appliedDateRange, appliedAssignee, page, pageSize, refreshSeq]);

  const totalPages = useMemo(() => {
    const total = payload?.meta.total ?? 0;
    return Math.max(1, Math.ceil(total / pageSize));
  }, [payload, pageSize]);
  const rangeText = useMemo(() => {
    const total = payload?.meta.total ?? 0;
    return formatWorkspaceRange({
      page,
      pageSize,
      total,
      rowsOnPage: payload?.rows.length ?? 0,
    });
  }, [payload, page, pageSize]);

  const activeFlowName = flows?.find((f) => f.id === flowId)?.name ?? null;

  const customFields = useMemo(() => payload?.customFields ?? [], [payload]);
  const overridesForRequest =
    valueOverrides.key === requestKey ? valueOverrides.map : {};

  const reloadTable = useCallback(() => {
    setRefreshSeq((n) => n + 1);
  }, []);

  const handleCustomSaved = useCallback(
    (fieldId: string, runId: string, value: string | null) => {
      if (!requestKey) return;
      setValueOverrides((prev) => ({
        key: requestKey,
        map: {
          ...(prev.key === requestKey ? prev.map : {}),
          [runId]: {
            ...((prev.key === requestKey ? prev.map : {})[runId] ?? {}),
            [fieldId]: value,
          },
        },
      }));
      // An assignee edit can move the row in or out of the active
      // assignee filter — re-sync with the server so the filtered
      // set stays truthful. (Submission Time never changes, so date
      // filtering needs no such resync.)
      if (appliedAssignee.type !== 'all') {
        const field = customFields.find((f) => f.id === fieldId);
        if (field && isAssigneeField(field)) reloadTable();
      }
    },
    [requestKey, appliedAssignee, customFields, reloadTable]
  );
  // Closed-trigger label: Base UI falls back to the raw value when
  // the selected item's text isn't resolved, which leaked the flow
  // UUID — always render the matched name explicitly instead. An
  // unmatched id (stale selection) shows the safe fallback, never
  // the UUID; with no selection yet the placeholder shows.
  const activeFlowLabel =
    flowId == null ? undefined : flowDisplayName(activeFlowName);

  // UI-only: the Status column is hidden — the Completed/Incomplete
  // tabs already communicate classification. The column stays in the
  // payload (drawer badges, types, API untouched).
  //
  // Column visibility is presentation-only state (account + flow
  // scoped, localStorage-backed): hiding filters these render
  // arrays, never the payload — data, definitions, values, and
  // order are preserved, so a restored column returns to its
  // original position with Lead Source still final.
  const visibility = useWorkspaceVisibility(accountId, flowId);
  const {
    flowColumns: flowColumnsVisible,
    customFields: customFieldsVisible,
    leadSourceVisible,
  } = useMemo(
    () =>
      applyVisibility(
        payload?.columns ?? [],
        customFields,
        visibility.hiddenIds
      ),
    [payload, customFields, visibility.hiddenIds]
  );

  // Effective header backgrounds for the VISIBLE set — customs
  // first, then semantic reference colors, then unused palette
  // colors reassigned in visible order (a mapped color never
  // disappears when its column is absent), overflow beyond that.
  // Hidden columns keep their stored overrides in headerColors, so unhiding restores their tint; visibility
  // resets never touch this map.
  const headerMap = useMemo(
    () =>
      buildHeaderColorMap(
        [
          { visId: ROW_VIS_ID, label: 'Row' },
          ...flowColumnsVisible.map((c) => ({
            visId: flowColumnVisId(c.key),
            label: c.label,
          })),
          ...customFieldsVisible.map((f) => ({
            visId: customFieldVisId(f.id),
            label: f.name,
          })),
          ...(leadSourceVisible
            ? [{ visId: LEAD_SOURCE_VIS_ID, label: 'Lead Source' }]
            : []),
        ],
        headerColors
      ),
    [flowColumnsVisible, customFieldsVisible, leadSourceVisible, headerColors]
  );

  // Sticky geometry, width-aware: each pinned column's left
  // is the exact sum of its predecessors' resolved widths, so a
  // resize can never open gaps or overlaps. Shared by header and
  // body cells of the pinned block.
  const stickyVisIdFor = useCallback(
    (stickyKey: string) =>
      stickyKey === STICKY_ROW_COLUMN_KEY
        ? ROW_VIS_ID
        : flowColumnVisId(stickyKey),
    []
  );
  const stickyLayouts = useMemo(
    () => resolveStickyLayouts(stickyVisIdFor, columnWidths),
    [stickyVisIdFor, columnWidths]
  );

  // Header paint for one column: sticky geometry (when pinned) or
  // resized width + map background + auto-contrast text. Sticky
  // corners reuse the exact same geometry/background, so no seams
  // appear while scrolling. The map fallback covers keys missing
  // from the visible set (defensive only).
  const headStyle = useCallback(
    (visId: string, label: string, stickyKey?: string) => {
      const background =
        headerMap[visId] ?? resolveHeaderColor(visId, label, headerColors);
      const geometry =
        stickyKey !== undefined
          ? (stickyLayouts[stickyKey] ?? columnWidthStyle(visId, columnWidths))
          : columnWidthStyle(visId, columnWidths);
      return {
        ...geometry,
        backgroundColor: background,
        color: headerTextColor(background),
      };
    },
    [headerMap, headerColors, stickyLayouts, columnWidths]
  );

  // Live width during a drag (no fetch); persist on release.
  // Unchanged releases skip the PUT; failures revert + toast.
  const handleResizeWidth = useCallback((columnKey: string, widthPx: number) => {
    setColumnWidths((prev) =>
      prev[columnKey] === widthPx ? prev : { ...prev, [columnKey]: widthPx }
    );
  }, []);

  const handleCommitWidth = useCallback(
    async (columnKey: string, widthPx: number) => {
      if (!flowId) return;
      const previous = columnWidths[columnKey];
      if (previous === widthPx) return;
      try {
        const res = await fetch(`/api/flows/${flowId}/column-widths`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ column_key: columnKey, width_px: widthPx }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            (payload as { error?: string }).error ?? 'Could not save the width.'
          );
        }
      } catch (err) {
        setColumnWidths((prev) => {
          const next = { ...prev };
          if (previous === undefined) delete next[columnKey];
          else next[columnKey] = previous;
          return next;
        });
        toast.error(
          err instanceof Error ? err.message : 'Could not save the width.'
        );
      }
    },
    [flowId, columnWidths]
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Workspace
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          One live table per flow — every run, completed or not.
        </p>
      </div>

      {flows === null ? (
        <Skeleton className="h-10 w-72" />
      ) : flowsError ? (
        <p className="text-destructive text-sm" role="alert">
          {flowsError}
        </p>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={Table2}
          title="No flows yet"
          hint="Create a flow first — each flow gets its own table here."
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Select value={flowId ?? ''} onValueChange={selectFlow}>
              <SelectTrigger
                className="border-border bg-card w-full sm:w-72"
                aria-label="Select flow"
              >
                <SelectValue placeholder="Select Flow">
                  {activeFlowLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {flows.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {flowDisplayName(f.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div
              className="flex items-center gap-1.5"
              role="tablist"
              aria-label="Completion filter"
            >
              {VIEWS.map((v) => (
                <Button
                  key={v.id}
                  role="tab"
                  aria-selected={view === v.id}
                  variant={view === v.id ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => selectView(v.id)}
                  className={cn(
                    'h-8 rounded-full px-3.5 text-[13px] font-medium',
                    view !== v.id &&
                      'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {v.label}
                </Button>
              ))}
            </div>
          </div>

          {payload?.meta.completionNodeId ? (
            <p className="text-muted-foreground text-xs">
              Completion point:{' '}
              <code className="bg-muted rounded px-1 font-mono">
                {payload.meta.completionNodeId}
              </code>{' '}
              — runs that reach it show as Completed.{' '}
              <Link
                href={`/flows/${payload.meta.flowId}`}
                className="underline underline-offset-2"
              >
                Edit in flow builder
              </Link>
            </p>
          ) : (
            payload && (
              <p className="text-muted-foreground text-xs">
                No custom completion point — runs show as Completed when they
                reach END.{' '}
                <Link
                  href={`/flows/${payload.meta.flowId}`}
                  className="underline underline-offset-2"
                >
                  Set one in the flow builder
                </Link>
              </p>
            )
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative w-full sm:max-w-sm">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or phone…"
                className="pl-9"
                aria-label="Search table"
              />
            </div>
            <div className="flex items-center gap-2 sm:ml-auto">
              <WorkspaceFilters
                members={teamMembers}
                appliedDate={appliedDate}
                appliedAssignee={appliedAssignee}
                onApply={applyFilters}
              />
              <ColumnsMenu
                flowId={flowId}
                flowColumns={payload?.columns ?? []}
                customFields={customFields}
                hiddenIds={visibility.hiddenIds}
                onToggleVisibility={visibility.toggle}
                onShowAll={visibility.showAll}
                onReset={visibility.reset}
                onEditField={(f) => {
                  setEditingField(f);
                  setAddColumnOpen(true);
                }}
                onChanged={reloadTable}
                headerColors={headerColors}
                onSaveHeaderColor={handleSaveHeaderColor}
                canCustomizeColors={canSendMessages}
                headerColorMap={headerMap}
              />
              {canEditSettings && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setEditingField(null);
                    setAddColumnOpen(true);
                  }}
                  className="h-8"
                >
                  <Plus className="h-4 w-4" />
                  Add Column
                </Button>
              )}
            </div>
          </div>

          {tableError ? (
            <p className="text-destructive text-sm" role="alert">
              {tableError}
            </p>
          ) : loading && !payload ? (
            <Skeleton className="h-64 w-full" />
          ) : !payload || payload.rows.length === 0 ? (
            hasActiveWorkspaceFilters({
              dateRange: appliedDateRange,
              assignee: appliedAssignee,
            }) ? (
              <EmptyState
                icon={Table2}
                title="No matching runs"
                hint="Try widening the date range or choosing a different assignee — or clear the filters to see everything."
              />
            ) : (
              <EmptyState
                icon={Table2}
                title={
                  view === 'all'
                    ? 'No runs yet'
                    : view === 'completed'
                      ? 'No completed runs'
                      : 'No incomplete runs'
                }
                hint="New flow runs appear here automatically."
              />
            )
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Select
                    value={String(pageSize)}
                    onValueChange={selectPageSize}
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
                  <p className="text-muted-foreground text-sm tabular-nums">
                    {rangeText}
                  </p>
                </div>
              </div>
              <div
                className={cn(
                  'workspace-table-viewport border-border bg-card max-h-[70vh] overflow-auto rounded-xl border',
                  resizingKey !== null && 'select-none'
                )}
              >
                <Table>
                  {/* Enterprise grid: every header cell is sticky-top
                      (opaque, so rows slide underneath); the pinned
                      block (No. + Submission Time + Name + Phone)
                      additionally sticks left via the shared sticky
                      layouts — the SAME width/left object feeds each
                      header cell and its body cells, so the two can
                      never misalign, including after a resize. The
                      tr-level divider is neutralized (merged to
                      border-b-0 by tailwind-merge) in favour of the
                      th-level divider, which travels with the stuck
                      header. Each header carries a drag handle on its
                      right boundary (writers only). */}
                  <TableHeader className="[&_tr]:border-b-0">
                    <TableRow>
                      <TableHead
                        className={cn(
                          'sticky top-0 h-14 truncate border-r border-b border-border px-3 text-[13px] font-semibold last:border-r-0',
                          STICKY_Z.corner
                        )}
                        style={headStyle(ROW_VIS_ID, 'Row', STICKY_ROW_COLUMN_KEY)}
                      >
                        No.
                        {canSendMessages && (
                          <ColumnResizeHandle
                            columnKey={ROW_VIS_ID}
                            onResize={handleResizeWidth}
                            onCommit={handleCommitWidth}
                            onActiveChange={(active) =>
                              setResizingKey(active ? ROW_VIS_ID : null)
                            }
                          />
                        )}
                      </TableHead>
                      {flowColumnsVisible.map((c) => {
                        const visId = flowColumnVisId(c.key);
                        // Sticky geometry is system-only: a flow answer
                        // that shares a system key (e.g. var_key "name"
                        // beside system Name) scrolls normally instead
                        // of pinning over its system twin.
                        const geom = c.system ? stickyLayouts[c.key] : undefined;
                        return (
                          <TableHead
                            key={flowColumnRenderKey(c)}
                            className={cn(
                              'sticky top-0 h-14 truncate border-r border-b border-border px-3 text-[13px] font-semibold whitespace-nowrap last:border-r-0',
                              geom ? STICKY_Z.corner : STICKY_Z.head
                            )}
                            style={headStyle(visId, c.label, c.system ? c.key : undefined)}
                          >
                            {c.label}
                            {canSendMessages && (
                              <ColumnResizeHandle
                                columnKey={visId}
                                onResize={handleResizeWidth}
                                onCommit={handleCommitWidth}
                                onActiveChange={(active) =>
                                  setResizingKey(active ? visId : null)
                                }
                              />
                            )}
                          </TableHead>
                        );
                      })}
                      {customFieldsVisible.map((f) => (
                        <TableHead
                          key={f.id}
                          className={cn(
                            'sticky top-0 h-14 truncate border-r border-b border-border px-3 text-[13px] font-semibold whitespace-nowrap last:border-r-0',
                            STICKY_Z.head
                          )}
                          style={headStyle(customFieldVisId(f.id), f.name)}
                        >
                          {f.name}
                          {canSendMessages && (
                            <ColumnResizeHandle
                              columnKey={customFieldVisId(f.id)}
                              onResize={handleResizeWidth}
                              onCommit={handleCommitWidth}
                              onActiveChange={(active) =>
                                setResizingKey(
                                  active ? customFieldVisId(f.id) : null
                                )
                              }
                            />
                          )}
                        </TableHead>
                      ))}
                      {leadSourceVisible && (
                        <TableHead
                          className={cn(
                            'sticky top-0 h-14 w-16 truncate border-r border-b border-border px-3 text-center text-[13px] font-semibold whitespace-nowrap last:border-r-0',
                            STICKY_Z.head
                          )}
                          style={headStyle(LEAD_SOURCE_VIS_ID, 'Lead Source')}
                        >
                          Lead Source
                          {canSendMessages && (
                            <ColumnResizeHandle
                              columnKey={LEAD_SOURCE_VIS_ID}
                              onResize={handleResizeWidth}
                              onCommit={handleCommitWidth}
                              onActiveChange={(active) =>
                                setResizingKey(active ? LEAD_SOURCE_VIS_ID : null)
                              }
                            />
                          )}
                        </TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payload.rows.map((row, rowIndex) => (
                      <TableRow
                        key={row.runId}
                        className="cursor-pointer"
                        onClick={() => setSelected(row)}
                      >
                        <TableCell
                          className={cn(
                            'text-muted-foreground sticky border-r border-border bg-card tabular-nums last:border-r-0',
                            STICKY_Z.body
                          )}
                          style={stickyLayouts[STICKY_ROW_COLUMN_KEY]}
                        >
                          {workspaceRowNumber({
                            page,
                            pageSize,
                            index: rowIndex,
                          }).toLocaleString()}
                        </TableCell>
                        {flowColumnsVisible.map((c) => {
                          const geom = c.system ? stickyLayouts[c.key] : undefined;
                          return (
                            <TableCell
                              key={flowColumnRenderKey(c)}
                              className={cn(
                                'max-w-56 truncate border-r border-border last:border-r-0',
                                geom && cn('sticky bg-card', STICKY_Z.body)
                              )}
                              style={
                                geom ??
                                columnWidthStyle(flowColumnVisId(c.key), columnWidths)
                              }
                            >
                              {cellText(row, c)}
                            </TableCell>
                          );
                        })}
                        {flowId &&
                          customFieldsVisible.map((f) => (
                            <TableCell
                              key={f.id}
                              className="max-w-56 overflow-hidden border-r border-border last:border-r-0"
                              style={columnWidthStyle(
                                customFieldVisId(f.id),
                                columnWidths
                              )}
                            >
                              <CustomCell
                                flowId={flowId}
                                runId={row.runId}
                                field={f}
                                stored={
                                  overridesForRequest[row.runId]?.[f.id] ??
                                  payload.customValues?.[row.runId]?.[f.id] ??
                                  null
                                }
                                canEdit={canSendMessages}
                                onSaved={handleCustomSaved}
                                members={teamMembers}
                              />
                            </TableCell>
                          ))}
                        {leadSourceVisible && (
                          <TableCell
                            className="w-16 border-r border-border text-center last:border-r-0"
                            style={columnWidthStyle(
                              LEAD_SOURCE_VIS_ID,
                              columnWidths
                            )}
                          >
                            <AdSourceCell sourceUrl={row.sourceUrl} />
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="text-muted-foreground flex items-center justify-end text-sm">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 0 || loading}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page + 1 >= totalPages || loading}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      <AddColumnDialog
        flowId={flowId}
        editing={editingField}
        open={addColumnOpen}
        onOpenChange={(v) => {
          setAddColumnOpen(v);
          if (!v) setEditingField(null);
        }}
        onSaved={() => {
          setEditingField(null);
          reloadTable();
        }}
      />

      <Sheet
        open={selected !== null}
        onOpenChange={(v) => !v && setSelected(null)}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.name ?? 'Run'}</SheetTitle>
                <SheetDescription>
                  {activeFlowName ?? 'Flow run'} · started{' '}
                  {formatDateTime(selected.startedAt)}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-4 overflow-y-auto px-5 pb-6">
                <div className="flex items-center gap-2">
                  <StatusBadge status={selected.status} />
                </div>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Phone</dt>
                    <dd className="text-foreground font-medium">
                      {selected.phone ?? '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Submission time</dt>
                    <dd className="text-foreground tabular-nums">
                      {formatDateTime(selected.startedAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Completed at</dt>
                    <dd className="text-foreground tabular-nums">
                      {formatDateTime(selected.completedAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Flow run ID</dt>
                    <dd className="text-foreground max-w-48 truncate font-mono text-xs">
                      {selected.runId}
                    </dd>
                  </div>
                </dl>
                <div>
                  <h3 className="text-foreground text-sm font-semibold">
                    Answers
                  </h3>
                  {payload && payload.columns.some((c) => !c.system) ? (
                    <dl className="mt-2 space-y-2 text-sm">
                      {payload.columns
                        .filter((c) => !c.system)
                        .map((c) => (
                          <div
                            key={flowColumnRenderKey(c)}
                            className="flex justify-between gap-4"
                          >
                            <dt className="text-muted-foreground shrink-0">
                              {c.label}
                            </dt>
                            <dd className="text-foreground text-right break-words">
                              {selected.answers[c.key] ?? '—'}
                            </dd>
                          </div>
                        ))}
                    </dl>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-sm">
                      No answers collected yet.
                    </p>
                  )}
                </div>
                {selected.conversationId ? (
                  <Button
                    className="w-full"
                    render={
                      <Link href={`/inbox?c=${selected.conversationId}`} />
                    }
                  >
                    <Inbox className="mr-2 h-4 w-4" />
                    Open Conversation
                  </Button>
                ) : (
                  <Button disabled className="w-full">
                    <Inbox className="mr-2 h-4 w-4" />
                    No conversation linked
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
