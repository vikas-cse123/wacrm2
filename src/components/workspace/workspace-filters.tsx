'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  assigneeDisplayName,
  type AssigneeMember,
} from '@/lib/flows/workspace-assignee';
import {
  WORKSPACE_ASSIGNEE_ALL,
  WORKSPACE_ASSIGNEE_UNASSIGNED,
  WORKSPACE_DATE_PRESETS,
  WORKSPACE_DATE_PRESET_LABELS,
  resolveWorkspaceDateRange,
  serializeAssigneeSelection,
  type WorkspaceAssigneeSelection,
  type WorkspaceDatePreset,
  type WorkspaceDateRange,
} from '@/lib/flows/workspace-filters';

export interface AppliedDateFilter {
  preset: WorkspaceDatePreset;
  customFrom: string;
  customTo: string;
  range: WorkspaceDateRange;
}

type DateDraft = WorkspaceDatePreset | 'all';

/**
 * Workspace Filters button + panel (Date + Assigned To).
 *
 * One trigger beside Search / Columns / Add Column; the panel
 * holds two independent sections that combine conjunctively
 * (AND) on Apply. Draft state lives in the panel and only hits
 * the table on Apply — Clear all resets and applies immediately.
 * Both filters are server-side (the table request carries them),
 * so pagination, views, search, visibility, and ordering are
 * preserved by construction.
 */
export function WorkspaceFilters({
  members,
  appliedDate,
  appliedAssignee,
  onApply,
}: {
  /** Live roster (Settings → Team Members source). Never hardcoded. */
  members: readonly AssigneeMember[];
  appliedDate: AppliedDateFilter | null;
  appliedAssignee: WorkspaceAssigneeSelection;
  onApply: (date: AppliedDateFilter | null, assignee: WorkspaceAssigneeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dateDraft, setDateDraft] = useState<DateDraft>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [assigneeDraft, setAssigneeDraft] = useState<string>(WORKSPACE_ASSIGNEE_ALL);

  // Reset the draft from the applied filters every time the panel
  // opens (same reset-on-open behavior as AddColumnDialog, but
  // event-driven rather than in an effect).
  function handleOpenChange(next: boolean) {
    if (next) {
      setDateDraft(appliedDate?.preset ?? 'all');
      setCustomFrom(appliedDate?.customFrom ?? '');
      setCustomTo(appliedDate?.customTo ?? '');
      setAssigneeDraft(serializeAssigneeSelection(appliedAssignee));
    }
    setOpen(next);
  }

  const activeCount =
    (appliedDate !== null ? 1 : 0) + (appliedAssignee.type !== 'all' ? 1 : 0);

  function handleApply() {
    let date: AppliedDateFilter | null = null;
    if (dateDraft !== 'all') {
      try {
        const range = resolveWorkspaceDateRange(
          dateDraft,
          { from: customFrom, to: customTo },
        );
        if (!range) {
          toast.error('Choose a date option.');
          return;
        }
        date = {
          preset: dateDraft,
          customFrom: dateDraft === 'custom' ? customFrom.trim() : '',
          customTo: dateDraft === 'custom' ? customTo.trim() : '',
          range,
        };
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Invalid date range.'
        );
        return;
      }
    }
    const trimmed = assigneeDraft.trim();
    const assignee: WorkspaceAssigneeSelection =
      trimmed === '' || trimmed.toLowerCase() === WORKSPACE_ASSIGNEE_ALL
        ? { type: 'all' }
        : trimmed.toLowerCase() === WORKSPACE_ASSIGNEE_UNASSIGNED
          ? { type: 'unassigned' }
          : { type: 'member', userId: trimmed };
    onApply(date, assignee);
    setOpen(false);
  }

  function handleClearAll() {
    onApply(null, { type: 'all' });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        className={cn(
          'border-border bg-card inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium',
          'text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
        )}
        aria-label="Filter table"
      >
        <Filter className="h-4 w-4" />
        Filters
        {activeCount > 0 && (
          <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
            {activeCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80">
        <div className="px-1 pt-1">
          <p className="text-foreground text-sm font-semibold">Filters</p>
          <p className="text-muted-foreground text-xs">
            Date and assignee combine — both apply at once.
          </p>
        </div>

        <div className="px-1">
          <p className="text-muted-foreground text-[11px] tracking-wide uppercase">
            Date
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Date range">
            {WORKSPACE_DATE_PRESETS.map((p) => (
              <Button
                key={p}
                type="button"
                variant={dateDraft === p ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDateDraft(p)}
                className={cn(
                  'h-7 rounded-full px-3 text-xs font-medium',
                  dateDraft !== p &&
                    'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {WORKSPACE_DATE_PRESET_LABELS[p]}
              </Button>
            ))}
          </div>
          {dateDraft === 'custom' && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label htmlFor="ws-filter-from" className="text-xs">
                  From
                </Label>
                <Input
                  id="ws-filter-from"
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-8 text-[13px]"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="ws-filter-to" className="text-xs">
                  To
                </Label>
                <Input
                  id="ws-filter-to"
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-8 text-[13px]"
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-1">
          <p className="text-muted-foreground text-[11px] tracking-wide uppercase">
            Assigned To
          </p>
          <Select value={assigneeDraft} onValueChange={(v) => v && setAssigneeDraft(v)}>
            <SelectTrigger
              className="border-border bg-card mt-1.5 w-full"
              aria-label="Filter by assignee"
            >
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={WORKSPACE_ASSIGNEE_ALL}>All</SelectItem>
              <SelectItem value={WORKSPACE_ASSIGNEE_UNASSIGNED}>Unassigned</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.user_id} value={m.user_id}>
                  {assigneeDisplayName(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="border-border flex items-center justify-between gap-2 border-t px-1 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={handleClearAll}>
            Clear all
          </Button>
          <Button type="button" size="sm" onClick={handleApply}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
