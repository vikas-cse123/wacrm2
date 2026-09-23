'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Columns3,
  Eye,
  Loader2,
  Lock,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { FlowTableColumn } from '@/lib/flows/flow-tables';
import type { WorkspaceField } from '@/lib/flows/workspace-fields';
import {
  describeVisibilityMenu,
  filterVisibilityMenu,
  customFieldVisId,
  type VisibilityMenuItem,
} from '@/lib/flows/workspace-visibility';

/**
 * Columns management panel.
 *
 * Two independent concerns share this menu but never the same
 * control:
 *   VISIBILITY (new) — checkboxes hide/show table columns.
 *   Hiding is presentation-only: definitions, values, and order
 *   are untouched, and a hidden column returns to its original
 *   position when re-enabled.
 *   MANAGEMENT (existing) — the pencil/trash actions edit or
 *   delete custom Workspace columns. Deleting requires
 *   confirmation and removes only Workspace data — flow fields
 *   can never appear here as deletable, and hiding can never
 *   delete.
 */
export function ColumnsMenu({
  flowId,
  flowColumns,
  customFields,
  hiddenIds,
  onToggleVisibility,
  onShowAll,
  onReset,
  onEditField,
  onChanged,
}: {
  flowId: string | null;
  flowColumns: FlowTableColumn[];
  customFields: WorkspaceField[];
  /** Currently hidden visibility ids (see workspace-visibility). */
  hiddenIds: readonly string[];
  onToggleVisibility: (id: string) => void;
  onShowAll: () => void;
  onReset: () => void;
  onEditField: (field: WorkspaceField) => void;
  onChanged: () => void;
}) {
  const [deleting, setDeleting] = useState<WorkspaceField | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    if (!deleting || !flowId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/flows/${flowId}/workspace-fields/${deleting.id}`,
        { method: 'DELETE' }
      );
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok)
        throw new Error(json?.error ?? 'Could not delete the column.');
      toast.success(`Column "${deleting.name}" deleted.`);
      setDeleting(null);
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not delete the column.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            'border-border bg-card inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium',
            'text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          <Columns3 className="h-4 w-4" />
          Columns
          {customFields.length > 0 && (
            <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
              {customFields.length}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <VisibilityPanel
            flowColumns={flowColumns}
            customFields={customFields}
            hiddenIds={hiddenIds}
            onToggleVisibility={onToggleVisibility}
            onShowAll={onShowAll}
            onReset={onReset}
            onEditField={onEditField}
            onDeleteField={setDeleting}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
            <DialogDescription>
              This will remove the Workspace column and all its custom values.
              Flow fields and history are not affected. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={handleDelete}
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                'Delete column'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Visibility manager: the menu content. Search state lives here so
 * it resets every time the menu closes (the dropdown content
 * unmounts on close). Search filters this list only — Workspace
 * rows are never affected.
 */
function VisibilityPanel({
  flowColumns,
  customFields,
  hiddenIds,
  onToggleVisibility,
  onShowAll,
  onReset,
  onEditField,
  onDeleteField,
}: {
  flowColumns: FlowTableColumn[];
  customFields: WorkspaceField[];
  hiddenIds: readonly string[];
  onToggleVisibility: (id: string) => void;
  onShowAll: () => void;
  onReset: () => void;
  onEditField: (field: WorkspaceField) => void;
  onDeleteField: (field: WorkspaceField) => void;
}) {
  const [query, setQuery] = useState('');
  const model = useMemo(
    () =>
      filterVisibilityMenu(
        describeVisibilityMenu(flowColumns, customFields),
        query
      ),
    [flowColumns, customFields, query]
  );
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const fieldByVisId = useMemo(
    () => new Map(customFields.map((f) => [customFieldVisId(f.id), f])),
    [customFields]
  );
  const empty =
    model.core.length === 0 &&
    model.flow.length === 0 &&
    model.custom.length === 0 &&
    model.leadSource === null;

  return (
    <>
      <div className="px-2 pt-1.5">
        <p className="text-foreground px-1 text-sm font-semibold">Columns</p>
        <p className="text-muted-foreground px-1 text-xs">
          Manage visible columns
        </p>
      </div>
      {/* Stop menu typeahead/shortcuts while typing; Escape still closes. */}
      <div
        className="px-1 py-1.5"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') e.stopPropagation();
        }}
      >
        <div className="relative">
          <Search
            className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search columns..."
            aria-label="Search columns"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
      </div>

      {empty ? (
        <p className="text-muted-foreground px-3 py-4 text-[13px]">
          No columns match your search.
        </p>
      ) : (
        <>
          {model.core.length > 0 && (
            <>
              <DropdownMenuLabel className="text-muted-foreground text-[11px] tracking-wide uppercase">
                Core
              </DropdownMenuLabel>
              <div className="px-1 pb-1">
                {model.core.map((item) => (
                  <LockedRow key={item.id} item={item} />
                ))}
              </div>
            </>
          )}
          {model.flow.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-[11px] tracking-wide uppercase">
                Flow columns
              </DropdownMenuLabel>
              <div className="px-1 pb-1">
                {model.flow.map((item) => (
                  <HideableRow
                    key={item.id}
                    item={item}
                    checked={!hidden.has(item.id)}
                    onToggle={() => onToggleVisibility(item.id)}
                  />
                ))}
              </div>
            </>
          )}
          {model.custom.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-[11px] tracking-wide uppercase">
                Custom columns
              </DropdownMenuLabel>
              <div className="px-1 pb-1">
                {model.custom.map((item) => {
                  const field = fieldByVisId.get(item.id);
                  if (!field) return null;
                  return (
                    <CustomVisibilityRow
                      key={item.id}
                      item={item}
                      checked={!hidden.has(item.id)}
                      onToggle={() => onToggleVisibility(item.id)}
                      onEdit={() => onEditField(field)}
                      onDelete={() => onDeleteField(field)}
                    />
                  );
                })}
              </div>
            </>
          )}
          {model.leadSource !== null && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-[11px] tracking-wide uppercase">
                Lead Source
              </DropdownMenuLabel>
              <div className="px-1 pb-1">
                <HideableRow
                  item={model.leadSource}
                  checked={!hidden.has(model.leadSource.id)}
                  onToggle={() => onToggleVisibility(model.leadSource!.id)}
                />
              </div>
            </>
          )}
        </>
      )}

      <div className="border-border bg-popover sticky bottom-0 border-t px-1 pt-1">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onShowAll}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            Show all columns
          </button>
          <button
            type="button"
            onClick={onReset}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset columns
          </button>
        </div>
      </div>
    </>
  );
}

/** Locked system column: always visible, toggle disabled. */
function LockedRow({ item }: { item: VisibilityMenuItem }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]"
      title="Always visible"
    >
      <Lock
        className="text-muted-foreground h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {item.label}
      </span>
      <Checkbox
        checked
        disabled
        aria-label={`${item.label} (always visible)`}
      />
    </div>
  );
}

/**
 * Hideable column without management actions. The label toggles the
 * checkbox natively — one control, keyboard accessible.
 */
function HideableRow({
  item,
  checked,
  onToggle,
}: {
  item: VisibilityMenuItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="text-foreground hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`${checked ? 'Hide' : 'Show'} ${item.label}`}
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </label>
  );
}

/**
 * Hideable custom column WITH its management actions. Visibility
 * (checkbox/name) and management (pencil/trash) are distinct
 * controls — toggling visibility can never edit or delete.
 */
function CustomVisibilityRow({
  item,
  checked,
  onToggle,
  onEdit,
  onDelete,
}: {
  item: VisibilityMenuItem;
  checked: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`${checked ? 'Hide' : 'Show'} ${item.label}`}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={`${checked ? 'Hide' : 'Show'} ${item.label}`}
        className="text-foreground focus-visible:ring-ring min-w-0 flex-1 truncate rounded text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        {item.label}
      </button>
      <button
        type="button"
        aria-label={`Edit ${item.label}`}
        onClick={onEdit}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Delete ${item.label}`}
        onClick={onDelete}
        className="text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:ring-ring flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
