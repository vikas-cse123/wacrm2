// ============================================================
// Workspace table filters — pure model (no React, no I/O).
//
// Exactly two filters, both server-side (the table is
// server-paginated via get_flow_table_rows; rows are never fanned
// out to the browser for filtering):
//
//   1. DATE — operates on the existing Submission Time
//      (flow_runs.started_at, TIMESTAMPTZ). Presets resolve to a
//      half-open [from, to) UTC range computed in the viewer's
//      LOCAL timezone — the same tz the table uses to display
//      Submission Time — so "Today" means the user's local today.
//      No second date field is created anywhere.
//   2. ASSIGNEE — operates on the existing "Assigned To" column.
//      Options derive from the live account roster (Settings →
//      Team Members via GET /api/account/members): All,
//      Unassigned, plus one entry per current member keyed by the
//      stable user_id. Filtering matches workspace_values
//      .value_text by ID equality — display names are never used
//      as filter keys.
//
// Combination is conjunctive (AND). Pagination, row numbering,
// views, search, visibility, and ordering are preserved because
// filtering happens inside the paginated RPC: total + page slice
// are computed AFTER all predicates.
//
// No member names, emails, UUIDs, or roles are hardcoded here.
// ============================================================

import type { AssigneeMember } from "./workspace-assignee";
import { assigneeDisplayName } from "./workspace-assignee";

// ------------------------------------------------------------
// Date filter
// ------------------------------------------------------------

export const WORKSPACE_DATE_PRESETS = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "custom",
] as const;

export type WorkspaceDatePreset = (typeof WORKSPACE_DATE_PRESETS)[number];

export const WORKSPACE_DATE_PRESET_LABELS: Record<WorkspaceDatePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last30: "Last 30 days",
  custom: "Custom",
};

export function isWorkspaceDatePreset(value: unknown): value is WorkspaceDatePreset {
  return (
    typeof value === "string" &&
    (WORKSPACE_DATE_PRESETS as readonly string[]).includes(value)
  );
}

/** Applied date range: half-open [from, to) ISO instants, or null = no filter. */
export interface WorkspaceDateRange {
  from: string;
  to: string;
}

/** Midnight of the given local day, plus calendar-day arithmetic (DST-safe). */
function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addLocalDays(midnight: Date, n: number): Date {
  return new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + n);
}

/**
 * Resolve a date preset to a half-open [from, to) range.
 * Bounds are local-midnight-derived, serialized as UTC ISO
 * instants for TIMESTAMPTZ comparison server-side.
 *
 *   today      → local today 00:00 → tomorrow 00:00
 *   yesterday  → yesterday 00:00 → today 00:00
 *   last7      → 6 days ago 00:00 → tomorrow 00:00 (7 days incl. today)
 *   last30     → 29 days ago 00:00 → tomorrow 00:00 (30 days incl. today)
 *   custom     → from-date 00:00 → (to-date + 1) 00:00, both inclusive
 *
 * `now` defaults to the current time (injectable for tests).
 * Custom dates are "YYYY-MM-DD" calendar days; throws when
 * missing, malformed, non-calendar, or from > to.
 */
export function resolveWorkspaceDateRange(
  preset: WorkspaceDatePreset,
  custom: { from?: string | null; to?: string | null },
  now: Date = new Date(),
): WorkspaceDateRange | null {
  // "All" is represented by the caller as null (no preset) — this
  // resolver only handles concrete presets.
  const today = localMidnight(now);
  switch (preset) {
    case "today":
      return { from: today.toISOString(), to: addLocalDays(today, 1).toISOString() };
    case "yesterday":
      return {
        from: addLocalDays(today, -1).toISOString(),
        to: today.toISOString(),
      };
    case "last7":
      return {
        from: addLocalDays(today, -6).toISOString(),
        to: addLocalDays(today, 1).toISOString(),
      };
    case "last30":
      return {
        from: addLocalDays(today, -29).toISOString(),
        to: addLocalDays(today, 1).toISOString(),
      };
    case "custom": {
      const fromDay = parseCustomDay(custom.from);
      const toDay = parseCustomDay(custom.to);
      if (!fromDay || !toDay) {
        throw new Error("Choose both a From and a To date.");
      }
      if (fromDay.getTime() > toDay.getTime()) {
        throw new Error("The From date must be on or before the To date.");
      }
      return { from: fromDay.toISOString(), to: addLocalDays(toDay, 1).toISOString() };
    }
  }
}

/** Strict YYYY-MM-DD → local midnight, or null when absent/invalid. */
function parseCustomDay(value: string | null | undefined): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt;
}

/** Validate a resolved range (ISO datetimes, from <= to). Throws on invalid. */
export function validateWorkspaceDateRange(range: {
  from: unknown;
  to: unknown;
}): WorkspaceDateRange {
  if (typeof range.from !== "string" || typeof range.to !== "string") {
    throw new Error("Invalid date filter.");
  }
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new Error("Invalid date filter.");
  }
  if (fromMs > toMs) {
    throw new Error("The From date must be on or before the To date.");
  }
  return { from: range.from, to: range.to };
}

// ------------------------------------------------------------
// Assignee filter
// ------------------------------------------------------------

export const WORKSPACE_ASSIGNEE_ALL = "all";
export const WORKSPACE_ASSIGNEE_UNASSIGNED = "unassigned";

/**
 * Applied assignee selection. `all` = no filter. `unassigned` =
 * rows with no real assignment (no value row, or cleared /
 * "Unassigned"). `{ type: "member", userId }` matches
 * workspace_values.value_text by stable ID equality.
 */
export type WorkspaceAssigneeSelection =
  | { type: "all" }
  | { type: "unassigned" }
  | { type: "member"; userId: string };

export const ALL_ASSIGNEES: WorkspaceAssigneeSelection = { type: "all" };

/**
 * Dropdown rows for the Assigned-To FILTER: All + Unassigned +
 * one entry per CURRENT account member, in roster order. Unlike
 * the cell editor there is no Clear item and no preserved entry —
 * a removed member must not appear for new filtering, so unknown
 * stored values are never listed here.
 */
export interface AssigneeFilterOption {
  value: string;
  label: string;
  kind: "all" | "unassigned" | "member";
}

export function buildAssigneeFilterOptions(
  members: readonly AssigneeMember[],
): AssigneeFilterOption[] {
  const options: AssigneeFilterOption[] = [
    { value: WORKSPACE_ASSIGNEE_ALL, label: "All", kind: "all" },
    { value: WORKSPACE_ASSIGNEE_UNASSIGNED, label: "Unassigned", kind: "unassigned" },
  ];
  for (const m of members) {
    options.push({ value: m.user_id, label: assigneeDisplayName(m), kind: "member" });
  }
  return options;
}

/** Serialize a selection to its wire value (member → stable user_id). */
export function serializeAssigneeSelection(sel: WorkspaceAssigneeSelection): string {
  switch (sel.type) {
    case "all":
      return WORKSPACE_ASSIGNEE_ALL;
    case "unassigned":
      return WORKSPACE_ASSIGNEE_UNASSIGNED;
    case "member":
      return sel.userId;
  }
}

/**
 * Parse the `assignee` query param. "all" (or absent) = no
 * filter; "unassigned" = unassigned; any other non-empty string
 * is a member user_id matched by ID equality server-side
 * (unknown/foreign IDs simply match nothing — account isolation
 * holds because the match runs inside the account-scoped RPC).
 */
export function parseAssigneeParam(value: unknown): WorkspaceAssigneeSelection {
  if (value === null || value === undefined) return ALL_ASSIGNEES;
  if (typeof value !== "string") throw new Error("Invalid assignee filter.");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === WORKSPACE_ASSIGNEE_ALL) {
    return ALL_ASSIGNEES;
  }
  if (trimmed.toLowerCase() === WORKSPACE_ASSIGNEE_UNASSIGNED) {
    return { type: "unassigned" };
  }
  return { type: "member", userId: trimmed };
}

// ------------------------------------------------------------
// Combined table query (client → GET /api/flows/[id]/table)
// ------------------------------------------------------------

export interface WorkspaceTableQuery {
  view: string;
  search?: string | null;
  page: number;
  pageSize: number;
  /** Null = no date filter. */
  dateRange: WorkspaceDateRange | null;
  /** Defaults to all. */
  assignee: WorkspaceAssigneeSelection;
}

/**
 * Compose the table query string. Filter params ride alongside
 * the existing view/search/page/pageSize keys so pagination,
 * search, and views keep working with filters active — the
 * server paginates the FILTERED set, keeping row numbering
 * correct.
 */
export function buildWorkspaceTableQuery(q: WorkspaceTableQuery): string {
  const qs = new URLSearchParams({
    view: q.view,
    page: String(q.page),
    pageSize: String(q.pageSize),
  });
  if (q.search && q.search.trim()) qs.set("search", q.search.trim());
  if (q.dateRange) {
    qs.set("dateFrom", q.dateRange.from);
    qs.set("dateTo", q.dateRange.to);
  }
  const assignee = serializeAssigneeSelection(q.assignee ?? ALL_ASSIGNEES);
  if (assignee !== WORKSPACE_ASSIGNEE_ALL) qs.set("assignee", assignee);
  return qs.toString();
}

/** True when either filter narrows the table (drives badges + empty states). */
export function hasActiveWorkspaceFilters(args: {
  dateRange: WorkspaceDateRange | null;
  assignee: WorkspaceAssigneeSelection;
}): boolean {
  return args.dateRange !== null || args.assignee.type !== "all";
}
