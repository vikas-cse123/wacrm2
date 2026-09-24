import { hasMinRole, type AccountRole } from "@/lib/auth/roles";

// ============================================================
// Reminder ownership: a reminder belongs to its creator.
// Only the creator — or an admin+ override, matching the
// owner/admin/agent/viewer hierarchy — may edit, cancel, or
// retry it. Teammates at agent/viewer level can read but never
// mutate another member's reminder. Account isolation is enforced
// separately by the per-route account_id scoping + RLS.
// ============================================================

export function canManageReminder(
  role: AccountRole,
  row: { created_by?: unknown },
  userId: string,
): boolean {
  if (typeof row.created_by === "string" && row.created_by === userId) {
    return true;
  }
  // Admin override only — agents and viewers cannot touch
  // another member's reminder. Legacy rows with no creator fall
  // through to the admin check (fail closed for non-admins).
  return hasMinRole(role, "admin");
}
