// ============================================================
// Workspace "Assigned To" — dynamic team-member binding.
//
// Source of truth is the SAME account-scoped roster shown in
// Settings → Team Members: `profiles` rows for the caller's
// account, surfaced to the browser via GET /api/account/members
// (which selects user_id/full_name/... where account_id = caller).
//
// Model:
//   - The Workspace column is the ordinary "Assigned To"
//     single_select default (options ["Unassigned"] is only the
//     structural fallback). Dynamic members are NEVER duplicated
//     into workspace_fields.options.
//   - Cell storage stays TEXT in workspace_values.value_text:
//       null          → cleared (no row)
//       "Unassigned"  → explicitly unassigned
//       <user_id>     → stable member ID (profiles.user_id)
//     Display names are resolved at render time from the live
//     roster, so a rename propagates with no data migration.
//   - Legacy rows that stored a display string (pre-ID era) are
//     preserved on read: an unknown stored value renders as-is and
//     is never silently rewritten. New writes only accept current
//     account member IDs (+ Unassigned + Clear), so a removed
//     member stops being selectable while their old rows stay intact.
//
// Account isolation: callers pass ONLY the current account's
// member IDs (from /api/account/members, itself RLS-scoped).
// Validation rejects anything outside that set — never another
// account's members, never bare auth.users rows.
//
// No member names, emails, UUIDs, or roles are hardcoded here.
// ============================================================

export const ASSIGNED_TO_FIELD_NAME = "Assigned To";

/** Structural option for "no one owns this row". Stored verbatim. */
export const ASSIGNED_TO_UNASSIGNED = "Unassigned";

/**
 * UI-only sentinel for the "Clear" menu item. The client maps it
 * to null before PUT; the validator also accepts it defensively
 * and normalizes to null (delete the value row).
 */
export const ASSIGNED_TO_CLEAR_SENTINEL = "__clear__";

/** Minimal roster shape — structural subset of AccountMember. */
export interface AssigneeMember {
  user_id: string;
  full_name: string | null;
}

/** True for the "Assigned To" Workspace column (case-insensitive). */
export function isAssigneeField(field: { name: string }): boolean {
  return field.name.trim().toLowerCase() === ASSIGNED_TO_FIELD_NAME.trim().toLowerCase();
}

/** Display name for one roster entry (matches Members tab fallback). */
export function assigneeDisplayName(member: AssigneeMember): string {
  const trimmed = (member.full_name ?? "").trim();
  return trimmed ? trimmed : "Unnamed";
}

/**
 * Resolve a stored cell value to its display text.
 *
 *   null/undefined/""      → null (renders as "—")
 *   "Unassigned"            → "Unassigned"
 *   <member user_id>        → current member's name
 *   anything else           → returned as-is (legacy display string
 *                             or a removed member's ID — preserved,
 *                             never rewritten here)
 */
export function resolveAssigneeDisplay(
  stored: string | null | undefined,
  members: readonly AssigneeMember[],
): string | null {
  if (stored === null || stored === undefined) return null;
  const trimmed = stored.trim();
  if (trimmed === "") return null;
  if (trimmed === ASSIGNED_TO_UNASSIGNED) return ASSIGNED_TO_UNASSIGNED;
  const match = members.find((m) => m.user_id === trimmed);
  if (match) return assigneeDisplayName(match);
  return stored;
}

/**
 * Validate + normalize one Assigned-To cell value for storage.
 * Throws with a human-readable message on invalid input.
 *
 * Accepts (all compared after trimming):
 *   null/undefined/""/"__clear__" → null (clear — deletes the row)
 *   "Unassigned"                  → "Unassigned"
 *   a user_id in `memberIds`       → that user_id (stable ID storage)
 *
 * Anything else (unknown name, removed member's ID, another
 * account's member ID) throws — removed members stop being
 * selectable for new assignments while their existing rows are
 * left untouched (reads preserve them via resolveAssigneeDisplay).
 */
export function validateAssigneeValue(
  value: unknown,
  memberIds: ReadonlySet<string> | readonly string[],
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Choose a team member from the current account.");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === ASSIGNED_TO_CLEAR_SENTINEL) return null;
  if (trimmed === ASSIGNED_TO_UNASSIGNED) return ASSIGNED_TO_UNASSIGNED;
  const has = Array.isArray(memberIds)
    ? (memberIds as readonly string[]).includes(trimmed)
    : (memberIds as ReadonlySet<string>).has(trimmed);
  if (has) return trimmed;
  throw new Error("Choose a team member from the current account.");
}

/**
 * Dropdown rows for the Assigned-To editor: Clear + Unassigned +
 * one entry per CURRENT account member, in roster order. The
 * caller fetches the roster live from /api/account/members, so a
 * newly added teammate appears with no code change and a removed
 * one simply stops being listed. When the stored value belongs to
 * nobody in the roster (legacy string / removed member), it is
 * appended as a preserve-only entry so the Select stays controlled
 * and the old assignment keeps rendering instead of vanishing.
 */
export interface AssigneeOption {
  value: string;
  label: string;
  kind: "clear" | "unassigned" | "member" | "preserved";
}

export function buildAssigneeOptions(
  members: readonly AssigneeMember[],
  stored: string | null | undefined,
): AssigneeOption[] {
  const options: AssigneeOption[] = [
    { value: ASSIGNED_TO_CLEAR_SENTINEL, label: "Clear", kind: "clear" },
    { value: ASSIGNED_TO_UNASSIGNED, label: ASSIGNED_TO_UNASSIGNED, kind: "unassigned" },
  ];
  for (const m of members) {
    options.push({ value: m.user_id, label: assigneeDisplayName(m), kind: "member" });
  }
  if (stored !== null && stored !== undefined) {
    const trimmed = stored.trim();
    if (
      trimmed !== "" &&
      trimmed !== ASSIGNED_TO_UNASSIGNED &&
      !members.some((m) => m.user_id === trimmed)
    ) {
      options.push({ value: stored, label: stored, kind: "preserved" });
    }
  }
  return options;
}
