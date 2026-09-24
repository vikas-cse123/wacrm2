// ============================================================
// Workspace default business columns — the 12 sales columns
// every flow's Workspace ships with (Assigned To … Final Remark).
//
// Design notes:
//   - Defaults are ORDINARY workspace_fields rows (same table,
//     same RLS, same visibility ids `custom:<uuid>`). After
//     provisioning they behave exactly like user-created columns:
//     hideable, editable, persistent — never locked, never core.
//   - Completed and Incomplete are views over the SAME flow's
//     fields, so one provisioning per (account, flow) serves both.
//     No per-view records are ever created.
//   - Recognition is deterministic: the canonical lowercase name
//     set below. An existing field with the same name
//     (case-insensitive) is treated as the user's own — it is
//     never overwritten, never duplicated.
//   - Google Sheets is untouched: provisioning writes ONLY to
//     workspace_fields, which Sheets never reads (migration 088).
//   - "Assigned To" is single_select with a single structural
//     "Unassigned" option, mirroring the deals Assigned-To
//     convention (deal-form "Unassigned" default). The dropdown
//     itself is DYNAMIC: Workspace loads the live account roster
//     from GET /api/account/members (the Team Members source of
//     truth) and stores the stable member user_id per cell —
//     member names are never duplicated into field options.
//   - "No. of Calls Tried" is a single_select dropdown with
//     exactly the options 1–10 (strings "1" … "10"). Free numeric
//     entry is intentionally NOT allowed — one pick, no arbitrary
//     text. Pre-existing numeric values 1–10 already store in that
//     exact form, so they carry over untouched (migration 096
//     converts the column type and reports — never rewrites —
//     any out-of-range legacy values).
//   - "Quotation / Package" is a single_select dropdown with
//     exactly ["Sent", "Not Yet"]. Pre-existing matching values
//     carry over untouched; anything else is reported, not
//     destroyed (migration 096).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { WorkspaceFieldType } from "./workspace-fields";

export interface WorkspaceDefaultSpec {
  /** Display label. Uniqueness key (case-insensitive) per flow. */
  name: string;
  field_type: WorkspaceFieldType;
  /** Select options. Null for non-select types. */
  options: string[] | null;
}

/**
 * Exact dropdown options for "No. of Calls Tried": the strings
 * "1" … "10", in order. Stored cell values use this exact form
 * (single_select validates by equality), so pre-existing numeric
 * entries 1–10 need no conversion.
 */
export const CALLS_TRIED_OPTIONS: readonly string[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
];

/** Exact dropdown options for "Quotation / Package". */
export const QUOTATION_OPTIONS: readonly string[] = ["Sent", "Not Yet"];

export const WORKSPACE_DEFAULT_FIELDS: readonly WorkspaceDefaultSpec[] = [
  { name: "Assigned To", field_type: "single_select", options: ["Unassigned"] },
  {
    name: "Call Status",
    field_type: "single_select",
    options: [
      "Connected",
      "Not Answering",
      "Switched Off",
      "Busy",
      "Call Back Later",
      "Invalid Number",
    ],
  },
  { name: "No. of Calls Tried", field_type: "single_select", options: [...CALLS_TRIED_OPTIONS] },
  {
    name: "Lead Quality",
    field_type: "single_select",
    options: ["Hot", "Warm", "Cold", "Fake"],
  },
  {
    name: "Quotation / Package",
    field_type: "single_select",
    options: [...QUOTATION_OPTIONS],
  },
  {
    name: "Follow-Up Status",
    field_type: "single_select",
    options: [
      "Follow-up Pending",
      "Negotiation Going On",
      "Booked",
      "Lost",
      "No Plan",
    ],
  },
  { name: "Last Contact Date", field_type: "date", options: null },
  { name: "Customer Response", field_type: "text", options: null },
  { name: "Next Follow-up Date & Time", field_type: "datetime", options: null },
  { name: "Next Action", field_type: "text", options: null },
  {
    name: "Reason for Lost Lead",
    field_type: "single_select",
    options: [
      "Budget Issue",
      "No Response",
      "Already Booked Elsewhere",
      "Date Issue",
      "Just Inquiry",
      "Travel Cancelled",
    ],
  },
  { name: "Final Remark", field_type: "text", options: null },
];

/**
 * Canonical lookup of system-provided default names
 * (lowercased + trimmed). Used to recognize equivalents without
 * touching them — a user field with the same name suppresses the
 * corresponding default insert for that flow.
 */
export const WORKSPACE_DEFAULT_NAMES: ReadonlySet<string> = new Set(
  WORKSPACE_DEFAULT_FIELDS.map((f) => f.name.trim().toLowerCase()),
);

export function isWorkspaceDefaultName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    WORKSPACE_DEFAULT_NAMES.has(name.trim().toLowerCase())
  );
}

export interface WorkspaceDefaultEnsureResult {
  /** Names (display case) that were inserted by this call. */
  created: string[];
}

/**
 * Provision the 12 default business columns for one flow's
 * Workspace. Idempotent and safe to call on every Workspace load:
 *
 *   - existing fields (user or default) are never modified;
 *   - a user field whose name matches a default (case-insensitive)
 *     suppresses that default — no duplicates, no overwrites;
 *   - missing defaults are appended after the current max
 *     position, so existing column order is never disturbed;
 *   - concurrent callers racing the same insert hit the
 *     (account, flow, lower(name)) unique index — the 23505
 *     conflict is swallowed, not surfaced.
 *
 * Only writes to `workspace_fields` (never values, flows, or
 * anything Sheets-related). Callers pass a client that can write
 * (service-role on the server); the (account_id, flow_id) scope
 * keeps tenant isolation explicit at the call site.
 */
export async function ensureWorkspaceDefaultFields(
  client: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<WorkspaceDefaultEnsureResult> {
  const { data: existing, error: readErr } = await client
    .from("workspace_fields")
    .select("name, position")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (readErr) throw readErr;

  const seen = new Set<string>();
  let maxPosition = -1;
  for (const row of (existing ?? []) as Array<{
    name: string;
    position: number | null;
  }>) {
    if (typeof row.name === "string") seen.add(row.name.trim().toLowerCase());
    if (typeof row.position === "number" && row.position > maxPosition) {
      maxPosition = row.position;
    }
  }

  const missing = WORKSPACE_DEFAULT_FIELDS.filter(
    (spec) => !seen.has(spec.name.trim().toLowerCase()),
  );
  if (missing.length === 0) return { created: [] };

  const { error: insertErr } = await client.from("workspace_fields").insert(
    missing.map((spec, i) => ({
      account_id: accountId,
      flow_id: flowId,
      name: spec.name,
      field_type: spec.field_type,
      position: maxPosition + 1 + i,
      options: spec.options,
      default_value: null,
      currency_code: null,
    })),
  );
  // Lost a race with another provisioner — the unique index kept
  // us duplicate-free; treat as success with nothing new to show.
  if (insertErr && (insertErr as { code?: string }).code !== "23505") {
    throw insertErr;
  }
  return { created: missing.map((spec) => spec.name) };
}
