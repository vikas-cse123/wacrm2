// ============================================================
// Live incomplete-runs sheet sync.
//
// Each flow can have one persistent "incomplete runs" spreadsheet
// (flow_incomplete_sheet_configs). A run belongs in it once it reaches a
// terminal, non-completed status (timed_out / failed / handed_off) —
// active runs are excluded because they may still complete.
//
// Sync is watermark-based: every appended run is stamped
// `flow_runs.incomplete_synced_at`, so each run lands in the sheet
// exactly once no matter how often the sweep runs. The flows cron calls
// `syncAllIncompleteSheets` right after its timeout sweep, which makes
// the sheet live: a run appears within one cron interval of being
// declared abandoned. Enabling the sheet does an immediate first sweep,
// which doubles as the historical backfill.
//
// Column healing mirrors sheet-sync.ts: new var keys found in later
// runs are appended at the end of the header (existing positions never
// move), so old rows stay aligned.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { getValidAccessToken } from "@/lib/google/oauth";
import {
  appendRows,
  findExactValueRows,
  findHeaderColumn,
  formatSubmissionTimeIST,
  insertSheetColumns,
  readFirstHeaderCell,
  setSheetColumnHidden,
  standardColumnsForSchemaVersion,
  updateHeaderCells,
} from "@/lib/google/sheets";
import { quoteSheetTitle } from "@/lib/google/tabs";
import {
  buildIncompleteHeader,
  buildIncompleteRow,
  collectNewAnswerKeys,
  INCOMPLETE_RUN_ID_HEADER,
  incompleteBaseOffset,
  incompleteRunIdColumnIndex,
  partitionSheetKeys,
  stringifySheetCell,
} from "./sheet-layout";
import {
  deriveFlowColumns,
  headerByKey,
  orderNodesForSheets,
  sortKeysByFlowOrder,
} from "./sheet-columns";
import type { FlowNodeLite } from "./sheet-columns";
import {
  ASSIGN_HEADER,
  ASSIGN_KEY,
  getAssignsForFlowRuns,
} from "@/lib/automations/assignment";

/** Terminal statuses that count as "incomplete" for the live sheet. */
export const INCOMPLETE_STATUSES = ["timed_out", "failed", "handed_off"];
export { INCOMPLETE_RUN_ID_HEADER };
export const INCOMPLETE_RUN_ID_MARKER = "incomplete_sheet_row_key_written";

/** Durable lease lock for Dedicated Incomplete sync — covers DB check → sheet read → append → watermark. */
const DEDICATED_INCOMPLETE_LOCK_TTL_SECONDS = 300;

async function tryAcquireDedicatedIncompleteLock(
  db: SupabaseClient,
  flowId: string,
  token: string,
  ttlSeconds = DEDICATED_INCOMPLETE_LOCK_TTL_SECONDS,
): Promise<boolean> {
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    // Try fresh insert
  const { error: insertError } = await (db as unknown as { from: (t: string) => { insert: (r: unknown) => Promise<{ error: unknown }> } }).from("dedicated_incomplete_sync_locks").insert({ flow_id: flowId, locked_at: new Date().toISOString(), expires_at: expiresAt, locked_by: token });
  if (!insertError) return true;
  // Fail closed: missing table or any error other than normal lock contention must not bypass the lock
  if (insertError && String((insertError as { message?: string }).message ?? "").includes("Could not find the table")) return false;
  // If conflict (already locked), try to steal if expired
  const { data: stolen, error: stealError } = await (db as unknown as { from: (t: string) => { update: (r: unknown) => { eq: (a: string, b: unknown) => { lt: (c: string, d: unknown) => { select: (e: string) => Promise<{ data: unknown[] | null; error: unknown }> } } } } }).from("dedicated_incomplete_sync_locks").update({ locked_at: new Date().toISOString(), expires_at: expiresAt, locked_by: token }).eq("flow_id", flowId).lt("expires_at", new Date().toISOString()).select("flow_id");
  if (stealError) {
    // Missing table or any other steal error → fail closed, do not append without lock
    return false;
  }
  return !!(stolen && (stolen as unknown[]).length > 0);
  } catch {
    // Fail closed on any unexpected error
    return false;
  }
}

async function releaseDedicatedIncompleteLock(
  db: SupabaseClient,
  flowId: string,
  token: string,
): Promise<void> {
  try {
    await (db as unknown as { from: (t: string) => { delete: () => { eq: (a: string, b: unknown) => { eq: (c: string, d: unknown) => Promise<unknown> } } } }).from("dedicated_incomplete_sync_locks").delete().eq("flow_id", flowId).eq("locked_by", token);
  } catch {
    // Best effort
  }
}

export interface IncompleteSheetConfigRow {
  flow_id: string;
  account_id: string;
  spreadsheet_id: string;
  spreadsheet_url: string | null;
  spreadsheet_name: string | null;
  sheet_tab: string;
  answer_columns: string[];
  header_written: boolean;
  /**
   * Sheet layout version. This table predates versioning, so configs
   * written before the V3 change carry no value and default to 2 (the
   * layout every existing incomplete sheet was written with — frozen).
   * Brand-new sheets are stamped with CURRENT_INCOMPLETE_SCHEMA_VERSION
   * (see the incomplete-sheet enable route); only an explicit 3 selects
   * the slim V3 layout (no Flow Name / User ID), only an explicit 4
   * additionally drops the fixed leading contact-Name cell, only an
   * explicit 5 restores it as "WhatsApp Name", and only an explicit 6
   * promotes the flow-collected Name first with the contact name moved
   * after the answers.
   */
  schema_version?: number | null;
}

interface RunRow {
  id: string;
  contact_id: string | null;
  vars: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * Append this flow's not-yet-synced incomplete runs to its live sheet
 * and stamp their watermark. Returns the number of rows appended.
 *
 * `db` must be able to update `flow_runs` — pass the service-role admin
 * client (the cron path) or a client whose RLS allows it.
 */
export async function syncIncompleteRunsForFlow(
  db: SupabaseClient,
  config: IncompleteSheetConfigRow,
  accessToken: string,
  window?: { from?: string; to?: string },
): Promise<number> {
  // Durable lease lock for Dedicated Incomplete — covers DB check → sheet read → append → watermark
  // Ensures same flow_id + same run cannot be appended twice concurrently.
  const lockToken = (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)) as string;
  const lockAcquired = await tryAcquireDedicatedIncompleteLock(db, config.flow_id, lockToken);
  if (!lockAcquired) return 0;
  try {
    let runsQuery = db
      .from("flow_runs")
      .select("id, contact_id, vars, started_at, ended_at")
      .eq("flow_id", config.flow_id)
      .in("status", INCOMPLETE_STATUSES)
      .is("incomplete_synced_at", null);
    if (window?.from) runsQuery = runsQuery.gte("started_at", window.from);
    if (window?.to) runsQuery = runsQuery.lt("started_at", window.to);
    const { data: runs } = await runsQuery.order("started_at", { ascending: true });

    if (!runs || runs.length === 0) return 0;

    // Sheet-level idempotency: detect rows already physically present via hidden Flow Run ID
    // Handles crash after appendRows but before watermark, and concurrent scan-before-append race
    let pendingRuns = runs as RunRow[];
    if (config.header_written) {
      try {
        const present = await findDedicatedIncompleteRowsPresent(accessToken, config.spreadsheet_id, config.sheet_tab, pendingRuns.map((r) => r.id));
        if (present.size > 0) {
          // Heal watermark for rows already on sheet but not yet marked synced (crash recovery)
          await db
            .from("flow_runs")
            .update({ incomplete_synced_at: new Date().toISOString() })
            .in("id", [...present]);
          pendingRuns = pendingRuns.filter((r) => !present.has(r.id));
          if (pendingRuns.length === 0) return 0;
        }
      } catch (e) {
        // Sheet read failure: do not treat sheet as empty, fail safely and allow retry (do not append)
        console.error("[incomplete-sheet-sync] sheet presence check failed, aborting to avoid duplicate:", e);
        throw e;
      }
    }

  // Versioned layout (see sheet-layout.ts): configs without a stored
  // version are pre-V3 sheets frozen on v2 (contact Name + Phone/Flow/
  // Time/UserID + answers + Run ID). 3 selects the slim V3 layout (no
  // Flow Name / User ID, leading contact Name kept); 4 additionally drops
  // the fixed leading contact-Name cell. contact_id stays in application
  // logic (contact lookup); only its exported User ID *cell* is gone.
  const schemaVersion = config.schema_version ?? 2;

  // The flows.name value is only needed for pre-V3 sheets (no Flow Name
  // cell from V3 on); entry_node_id is always needed for canonical flow
  // ordering. Single indexed row read either way.
  const { data: flow } = await db
    .from("flows")
    .select("name, entry_node_id")
    .eq("id", config.flow_id)
    .maybeSingle();
  const entryKey =
    (flow as { entry_node_id?: string | null } | null)?.entry_node_id ?? null;

  const contactIds = [
    ...new Set(
      (pendingRuns as RunRow[]).map((r) => r.contact_id).filter((x): x is string => !!x),
    ),
  ];
  const contactMap = new Map<string, { name?: string | null; phone?: string | null }>();
  if (contactIds.length > 0) {
    const { data: contacts } = await db
      .from("contacts")
      .select("id, name, phone")
      .in("id", contactIds);
    for (const c of contacts ?? []) {
      contactMap.set(c.id, { name: c.name, phone: c.phone });
    }
  }

  // Column healing — append any var keys these runs carry that the
  // stored header doesn't have yet. Existing positions never move.
  // Honor "Include in Google Sheet" like the completed path does: keys
  // whose nodes are switched off are neither added as new columns nor
  // given values in future rows (stored ones keep their frozen positions
  // but go blank, mirroring completed-sheet activeKeys). Unknown keys
  // (deleted nodes, non-question captures) keep current behavior.
  const storedKeys = config.answer_columns ?? [];
  const { data: sheetNodes } = await db
    .from("flow_nodes")
    .select("node_key, node_type, config, created_at")
    .eq("flow_id", config.flow_id)
    .order("created_at", { ascending: true });
  const orderedNodes = orderNodesForSheets(
    entryKey,
    (sheetNodes ?? []) as FlowNodeLite[],
  );
  const { disabledKeys } = partitionSheetKeys(orderedNodes);
  // Human-readable labels per the completed-sheet contract (custom name
  // → question text → raw key); unknown keys fall back to the raw key.
  // Stored headers are never rewritten — this map labels only new sheets
  // and newly healed columns.
  const headerMap = headerByKey(entryKey, orderedNodes);
  const headerFor = (k: string): string => headerMap.get(k) ?? k;
  const { newKeys: rawNewKeys } = collectNewAnswerKeys(
    storedKeys,
    (pendingRuns as RunRow[]).map((run) => run.vars),
  );
  // V6 promotion (flow-collected Name first, mirroring completed
  // sheets): adopted fresh on first write; afterwards pinned to the live
  // sheet's A1 so node edits (delete/disable/rename the name question,
  // or add one later) can never change row widths mid-life. A late-added
  // name-like key folds in as a normal answer, like completed sheets do.
  // hasPromotedCell drives header/row widths AND Run ID offsets together.
  const isV6 = schemaVersion >= 6;
  let promotedKey: string | null = null;
  let promotedHeader: string | null = null;
  let hasPromotedCell = false;
  if (isV6 && !config.header_written) {
    const derived = deriveFlowColumns(orderedNodes, true);
    if (derived.name) {
      promotedKey = derived.name.key;
      promotedHeader = derived.name.header;
      hasPromotedCell = true;
    }
  } else if (isV6) {
    const firstCell = await readFirstHeaderCell(
      accessToken,
      config.spreadsheet_id,
      config.sheet_tab,
    );
    if (firstCell === null) {
      throw new Error("incomplete sheet header unreadable");
    }
    if (firstCell !== standardColumnsForSchemaVersion(6)[0]) {
      hasPromotedCell = true;
      const derived = deriveFlowColumns(orderedNodes, true);
      promotedKey = derived.name?.key ?? null;
      promotedHeader = derived.name?.header ?? firstCell;
    }
  }

  // New keys take canonical flow order (unknown keys keep first-seen
  // order at the end); they append after stored keys via the existing
  // append/before-RunID mechanism — stored positions never move. The
  // adopted promoted key is not an answer column (it renders first).
  const newKeys = sortKeysByFlowOrder(
    rawNewKeys.filter((k) => !disabledKeys.has(k) && k !== promotedKey),
    [...headerMap.keys()],
  );
  const answerColumns = [...storedKeys, ...newKeys];

  // Assign enrichment (069): exact-run values, never contact/phone/latest.
  // Healed as a trailing answer (before the hidden Run ID) only when some
  // run in this batch carries a pick — or when the sheet already adopted
  // the column (then rows stay aligned with blanks). Never in vars scan.
  const assignMap = await getAssignsForFlowRuns(
    db,
    (pendingRuns as RunRow[]).map((r) => r.id),
  ).catch(() => new Map<string, string>());
  const includeAssign =
    assignMap.size > 0 || storedKeys.includes(ASSIGN_KEY);
  if (includeAssign && !answerColumns.includes(ASSIGN_KEY)) {
    answerColumns.push(ASSIGN_KEY);
    newKeys.push(ASSIGN_KEY);
  }
  const headerForAssign = (k: string): string =>
    k === ASSIGN_KEY ? ASSIGN_HEADER : headerFor(k);

  // The hidden run-id column is a stable row key. A contact may abandon the
  // same flow more than once, so phone/contact id alone cannot safely identify
  // which incomplete row to remove after a later completion. Offsets derive
  // from this sheet's OWN version (plus the adopted V6 promotion flag) so
  // V2+ sheets keep their frozen positions — Run ID stays last either way.
  const headers = buildIncompleteHeader(
    schemaVersion,
    answerColumns,
    answerColumns.map(headerForAssign),
    promotedHeader,
  );
  const previousRunIdCol = incompleteRunIdColumnIndex(
    schemaVersion,
    storedKeys,
    hasPromotedCell,
  );
  const runIdCol = incompleteRunIdColumnIndex(
    schemaVersion,
    answerColumns,
    hasPromotedCell,
  );
  // Physical insertion point for new answer columns: immediately after
  // the existing answer block. For V2–V5 that coincides with the Run ID
  // index; V6 has a trailing WhatsApp cell between the answers and the
  // Run ID, so inserting at the Run ID index would strand new columns
  // after WhatsApp while rows render them before it. Deriving from the
  // layout keeps header labels and row values aligned on every version.
  const answerInsertCol =
    incompleteBaseOffset(schemaVersion, hasPromotedCell) + storedKeys.length;

  if (config.header_written) {
    // Upgrade already-created sheets in place. Put the stable key after the
    // existing answers. If new answer columns appear later, insert them before
    // this key so all existing run IDs shift safely with their rows.
    await updateHeaderCells(accessToken, config.spreadsheet_id, config.sheet_tab, [
      { colIndex: previousRunIdCol, value: INCOMPLETE_RUN_ID_HEADER },
    ]);
    if (newKeys.length > 0) {
      await insertSheetColumns(
        accessToken,
        config.spreadsheet_id,
        config.sheet_tab,
        answerInsertCol,
        newKeys.length,
      );
      await updateHeaderCells(
        accessToken,
        config.spreadsheet_id,
        config.sheet_tab,
        newKeys.map((k, i) => ({
          colIndex: answerInsertCol + i,
          value: headerForAssign(k),
        })),
      );
    }

    // Persist the shifted layout before appending. If Google accepts the
    // column insertion but a later append fails, the retry must not insert
    // those same columns a second time.
    const { error: columnStateError } = await db
      .from("flow_incomplete_sheet_configs")
      .update({
        answer_columns: answerColumns,
        updated_at: new Date().toISOString(),
      })
      .eq("flow_id", config.flow_id);
    if (columnStateError) throw columnStateError;
  }

  const rows: (string | number)[][] = (pendingRuns as RunRow[]).map((run) => {
    const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
    const vars = (run.vars ?? {}) as Record<string, unknown>;
    // Virtual Assign var (never persisted to flow_runs.vars): blank when
    // this run has no pick, so adopted columns stay aligned.
    const varsWithAssign: Record<string, unknown> =
      answerColumns.includes(ASSIGN_KEY)
        ? { ...vars, [ASSIGN_KEY]: assignMap.get(run.id) ?? "" }
        : vars;
    return buildIncompleteRow({
      schemaVersion,
      contactName: contact?.name ?? "",
      contactPhone: contact?.phone ?? "",
      flowName: flow?.name ?? "",
      submissionTime: formatSubmissionTimeIST(run.ended_at ?? run.started_at),
      contactId: run.contact_id ?? "",
      vars: varsWithAssign,
      answerColumns,
      runId: run.id,
      inactiveKeys: disabledKeys,
      promotedHeader,
      promotedValue:
        promotedHeader != null && promotedKey != null
          ? stringifySheetCell(vars[promotedKey])
          : null,
    });
  });

  // This marker lets cleanup distinguish a new keyed row from a legacy row
  // that predates the hidden Flow Run ID column. Write it before the sheet
  // append so an appended row can never exist without its durable cleanup key.
  const { error: markerError } = await db.from("flow_run_events").insert(
    (pendingRuns as RunRow[]).map((run) => ({
      flow_run_id: run.id,
      event_type: "node_entered",
      node_key: null,
      payload: { [INCOMPLETE_RUN_ID_MARKER]: true },
    })),
  );
  if (markerError) throw markerError;

  const toWrite = config.header_written ? rows : [headers, ...rows];
  await appendRows(accessToken, config.spreadsheet_id, config.sheet_tab, toWrite);
  try {
    await setSheetColumnHidden(
      accessToken,
      config.spreadsheet_id,
      config.sheet_tab,
      runIdCol,
      true,
    );
  } catch (error) {
    // Visibility is cosmetic. The stable IDs are already written and must not
    // be appended again merely because Google refused to hide the column.
    console.error(
      "[incomplete-sheet-sync] could not hide Flow Run ID column:",
      error instanceof Error ? error.message : error,
    );
  }

  // Persist header/column state, then stamp the watermark. If the stamp
  // failed after a successful append, the next sweep would re-append
  // those rows — accepted trade-off (duplicates over silent data loss).
  // NOTE: schema_version is deliberately NOT written here — it is stamped
  // once at creation (see the incomplete-sheet enable route) so a sheet's
  // layout version can never drift mid-life.
  await db
    .from("flow_incomplete_sheet_configs")
    .update({
      answer_columns: answerColumns,
      header_written: true,
      updated_at: new Date().toISOString(),
    })
    .eq("flow_id", config.flow_id);

  await db
    .from("flow_runs")
    .update({ incomplete_synced_at: new Date().toISOString() })
    .in("id", (pendingRuns as RunRow[]).map((r) => r.id));

  return rows.length;
  } finally {
    await releaseDedicatedIncompleteLock(db, config.flow_id, lockToken);
  }
}

async function findDedicatedIncompleteRowsPresent(
  accessToken: string,
  spreadsheetId: string,
  sheetTab: string,
  runIds: string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const { findHeaderColumn, findExactValueRows } = await import("@/lib/google/sheets");
  const runIdCol = await findHeaderColumn(accessToken, spreadsheetId, sheetTab, INCOMPLETE_RUN_ID_HEADER).catch(() => null);
  if (runIdCol === null) return new Set();
  const found = await findExactValueRows(accessToken, spreadsheetId, sheetTab, runIdCol, runIds).catch(() => new Map<string, number>());
  return new Set(found.keys());
}

/**
 * Cron entry point — sync every flow that has a live incomplete sheet.
 * Groups configs by account so each account's Google token is resolved
 * once; accounts without a valid token are skipped (their runs stay
 * unsynced and are picked up once the token is back).
 *
 * Permanent-failure backoff: a config whose spreadsheet/tab was deleted
 * (or whose access was revoked) fails identically every minute forever,
 * wasting worker time and spamming the logs. After `MAX_CONSECUTIVE_FAILURES`
 * consecutive failures we stop retrying that config for a cooldown period,
 * so a permanently-broken sheet can never consume the cron indefinitely.
 * Once the cooldown passes (or the process restarts) it is retried once
 * more, so re-linking the sheet recovers automatically.
 */

const MAX_CONSECUTIVE_FAILURES = 3;
const CONFIG_FAILURE_BACKOFF_MS = 30 * 60_000;

interface FailureState {
  count: number;
  lastFailedAt: number;
}

const failureByFlow = new Map<string, FailureState>();

function inBackoff(flowId: string): boolean {
  const state = failureByFlow.get(flowId);
  if (!state) return false;
  return (
    state.count >= MAX_CONSECUTIVE_FAILURES &&
    Date.now() - state.lastFailedAt < CONFIG_FAILURE_BACKOFF_MS
  );
}

function recordFailure(flowId: string): void {
  const state = failureByFlow.get(flowId);
  if (state) {
    state.count += 1;
    state.lastFailedAt = Date.now();
  } else {
    failureByFlow.set(flowId, { count: 1, lastFailedAt: Date.now() });
  }
}

function recordSuccess(flowId: string): void {
  failureByFlow.delete(flowId);
}

export async function syncAllIncompleteSheets(
  db: SupabaseClient,
): Promise<{ synced: number; errors: number }> {
  const { data: configs } = await db
    .from("flow_incomplete_sheet_configs")
    .select("*");

  if (!configs || configs.length === 0) return { synced: 0, errors: 0 };

  const byAccount = new Map<string, IncompleteSheetConfigRow[]>();
  for (const c of configs as IncompleteSheetConfigRow[]) {
    const list = byAccount.get(c.account_id) ?? [];
    list.push(c);
    byAccount.set(c.account_id, list);
  }

  let synced = 0;
  let errors = 0;
  for (const [accountId, accountConfigs] of byAccount) {
    let token: string | null = null;
    try {
      token = await getValidAccessToken(db, accountId);
    } catch {
      token = null;
    }
    if (!token) continue;

    for (const config of accountConfigs) {
      if (inBackoff(config.flow_id)) {
        console.warn(
          `[incomplete-sheet-sync] flow ${config.flow_id} is in permanent-failure backoff — skipping until cooldown passes`,
        );
        continue;
      }
      try {
        synced += await syncIncompleteRunsForFlow(db, config, token);
        recordSuccess(config.flow_id);
      } catch (err) {
        errors += 1;
        recordFailure(config.flow_id);
        console.error(
          `[incomplete-sheet-sync] flow ${config.flow_id} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { synced, errors };
}
