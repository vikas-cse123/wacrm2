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
  formatSubmissionTimeIST,
  insertSheetColumns,
  setSheetColumnHidden,
  updateHeaderCells,
} from "@/lib/google/sheets";
import {
  buildIncompleteHeader,
  buildIncompleteRow,
  collectNewAnswerKeys,
  INCOMPLETE_RUN_ID_HEADER,
  incompleteRunIdColumnIndex,
  partitionSheetKeys,
} from "./sheet-layout";
import {
  headerByKey,
  orderNodesForSheets,
  sortKeysByFlowOrder,
} from "./sheet-columns";
import type { FlowNodeLite } from "./sheet-columns";

/** Terminal statuses that count as "incomplete" for the live sheet. */
export const INCOMPLETE_STATUSES = ["timed_out", "failed", "handed_off"];
export { INCOMPLETE_RUN_ID_HEADER };
export const INCOMPLETE_RUN_ID_MARKER = "incomplete_sheet_row_key_written";

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
   * additionally drops the fixed leading contact-Name cell, and only an
   * explicit 5 restores it as "WhatsApp Name".
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
      (runs as RunRow[]).map((r) => r.contact_id).filter((x): x is string => !!x),
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
    (runs as RunRow[]).map((run) => run.vars),
  );
  // New keys take canonical flow order (unknown keys keep first-seen
  // order at the end); they append after stored keys via the existing
  // append/before-RunID mechanism — stored positions never move.
  const newKeys = sortKeysByFlowOrder(
    rawNewKeys.filter((k) => !disabledKeys.has(k)),
    [...headerMap.keys()],
  );
  const answerColumns = [...storedKeys, ...newKeys];

  // The hidden run-id column is a stable row key. A contact may abandon the
  // same flow more than once, so phone/contact id alone cannot safely identify
  // which incomplete row to remove after a later completion. Offsets derive
  // from this sheet's OWN version so V2 sheets keep their frozen positions
  // and V3 sheets compute their slim ones — Run ID stays last either way.
  const headers = buildIncompleteHeader(
    schemaVersion,
    answerColumns,
    answerColumns.map(headerFor),
  );
  const previousRunIdCol = incompleteRunIdColumnIndex(schemaVersion, storedKeys);
  const runIdCol = incompleteRunIdColumnIndex(schemaVersion, answerColumns);

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
        previousRunIdCol,
        newKeys.length,
      );
      await updateHeaderCells(
        accessToken,
        config.spreadsheet_id,
        config.sheet_tab,
        newKeys.map((k, i) => ({
          colIndex: previousRunIdCol + i,
          value: headerFor(k),
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

  const rows: (string | number)[][] = (runs as RunRow[]).map((run) => {
    const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
    return buildIncompleteRow({
      schemaVersion,
      contactName: contact?.name ?? "",
      contactPhone: contact?.phone ?? "",
      flowName: flow?.name ?? "",
      submissionTime: formatSubmissionTimeIST(run.ended_at ?? run.started_at),
      contactId: run.contact_id ?? "",
      vars: (run.vars ?? {}) as Record<string, unknown>,
      answerColumns,
      runId: run.id,
      inactiveKeys: disabledKeys,
    });
  });

  // This marker lets cleanup distinguish a new keyed row from a legacy row
  // that predates the hidden Flow Run ID column. Write it before the sheet
  // append so an appended row can never exist without its durable cleanup key.
  const { error: markerError } = await db.from("flow_run_events").insert(
    (runs as RunRow[]).map((run) => ({
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
    .in("id", (runs as RunRow[]).map((r) => r.id));

  return rows.length;
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
