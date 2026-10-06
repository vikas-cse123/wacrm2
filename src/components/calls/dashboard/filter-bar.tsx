'use client';

import { CalendarDays, Filter, User } from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RANGE_OPTIONS, toDateInputValue, type CallsRangeKey } from '@/lib/calls/ranges';

export interface MemberOption {
  user_id: string;
  label: string;
}

/**
 * Dashboard filter bar: date range (+ custom day pickers), user,
 * direction. Every control maps to a real API param — nothing
 * decorative.
 */
export function FilterBar({
  rangeKey,
  onRangeKey,
  customFrom,
  customTo,
  onCustom,
  nowMs,
  timeZone,
  members,
  userFilter,
  onUserFilter,
  directionFilter,
  onDirectionFilter,
}: {
  rangeKey: CallsRangeKey;
  onRangeKey: (k: CallsRangeKey) => void;
  customFrom: string;
  customTo: string;
  onCustom: (from: string, to: string) => void;
  nowMs: number;
  timeZone: string;
  members: MemberOption[];
  userFilter: string | null;
  onUserFilter: (u: string | null) => void;
  directionFilter: string | null;
  onDirectionFilter: (d: string | null) => void;
}) {
  const todayInput = toDateInputValue(nowMs, timeZone);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={rangeKey} onValueChange={(v) => onRangeKey(v as CallsRangeKey)}>
        <SelectTrigger className="w-auto gap-2 rounded-full" aria-label="Date range">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGE_OPTIONS.map((o) => (
            <SelectItem key={o.key} value={o.key}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {rangeKey === 'custom' ? (
        <span className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="Custom start date"
            value={customFrom}
            max={customTo || todayInput}
            onChange={(e) => onCustom(e.target.value, customTo)}
            className="h-8 w-auto rounded-full text-[13px]"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="date"
            aria-label="Custom end date"
            value={customTo}
            min={customFrom}
            max={todayInput}
            onChange={(e) => onCustom(customFrom, e.target.value)}
            className="h-8 w-auto rounded-full text-[13px]"
          />
        </span>
      ) : null}

      <Select
        value={userFilter ?? 'all'}
        onValueChange={(v) => onUserFilter(v === 'all' ? null : v)}
      >
        <SelectTrigger className="w-auto gap-2 rounded-full" aria-label="User">
          <User className="h-4 w-4 text-muted-foreground" />
          <SelectValue placeholder="All Users" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Users</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.user_id} value={m.user_id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={directionFilter ?? 'all'}
        onValueChange={(v) => onDirectionFilter(v === 'all' ? null : v)}
      >
        <SelectTrigger className="w-auto gap-2 rounded-full" aria-label="Direction">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <SelectValue placeholder="All Directions" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Directions</SelectItem>
          <SelectItem value="in">Inbound</SelectItem>
          <SelectItem value="out">Outbound</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
