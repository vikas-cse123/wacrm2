import type { SupabaseClient } from "@supabase/supabase-js";

import { getValidAccessToken } from "@/lib/google/oauth";
import {
  deleteSheetRows,
  findExactValueRows,
  findHeaderColumn,
} from "@/lib/google/sheets";
import {
  INCOMPLETE_RUN_ID_HEADER,
  INCOMPLETE_RUN_ID_MARKER,
  type IncompleteSheetConfigRow,
} from "@/lib/flows/incomplete-sheet-sync";

interface CompletedRunRow {
  id: string;
  flow_id: string;
  account_id: string;
}

interface RunEventRow {
  flow_run_id: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Remove keyed incomplete-sheet rows once the same run has completed and a
 * successful Completed-sheet sync event exists. Safe to call repeatedly:
 * exact Flow Run IDs prevent deleting another attempt by the same contact.
 */
export async function cleanupCompletedIncompleteRows(
  db: SupabaseClient,
): Promise<{ removed: number; errors: number }> {
  const { data: completedRuns, error: runsError } = await db
    .from("flow_runs")
    .select("id, flow_id, account_id")
    .eq("status", "completed")
    .not("incomplete_synced_at", "is", null)
    .order("ended_at", { ascending: true })
    .limit(100);
  if (runsError) throw runsError;
  if (!completedRuns?.length) return { removed: 0, errors: 0 };

  const runs = completedRuns as CompletedRunRow[];
  const runIds = runs.map((run) => run.id);
  const { data: events, error: eventsError } = await db
    .from("flow_run_events")
    .select("flow_run_id, payload, created_at")
    .in("flow_run_id", runIds)
    .eq("event_type", "node_entered");
  if (eventsError) throw eventsError;

  const keyedAt = new Map<string, number>();
  const completedSheetSyncedAt = new Map<string, number>();
  for (const event of (events ?? []) as RunEventRow[]) {
    const payload = event.payload ?? {};
    const createdAt = new Date(event.created_at).getTime();
    if (payload[INCOMPLETE_RUN_ID_MARKER] === true) {
      keyedAt.set(
        event.flow_run_id,
        Math.max(keyedAt.get(event.flow_run_id) ?? 0, createdAt),
      );
    }
    if (
      payload.node_type === "google_sheets_sync" &&
      payload.result === "synced"
    ) {
      completedSheetSyncedAt.set(
        event.flow_run_id,
        Math.max(completedSheetSyncedAt.get(event.flow_run_id) ?? 0, createdAt),
      );
    }
  }

  const eligible = runs.filter(
    (run) =>
      (completedSheetSyncedAt.get(run.id) ?? 0) >
      (keyedAt.get(run.id) ?? Infinity),
  );
  if (eligible.length === 0) return { removed: 0, errors: 0 };

  const flowIds = [...new Set(eligible.map((run) => run.flow_id))];
  const { data: configs, error: configsError } = await db
    .from("flow_incomplete_sheet_configs")
    .select("*")
    .in("flow_id", flowIds);
  if (configsError) throw configsError;
  const configByFlow = new Map(
    ((configs ?? []) as IncompleteSheetConfigRow[]).map((config) => [
      config.flow_id,
      config,
    ]),
  );

  const tokenByAccount = new Map<string, string | null>();
  const runsByFlow = new Map<string, CompletedRunRow[]>();
  for (const run of eligible) {
    const flowRuns = runsByFlow.get(run.flow_id) ?? [];
    flowRuns.push(run);
    runsByFlow.set(run.flow_id, flowRuns);
  }

  let removed = 0;
  let errors = 0;

  for (const [flowId, flowRuns] of runsByFlow) {
    const config = configByFlow.get(flowId);
    if (!config) continue;
    const accountId = flowRuns[0]!.account_id;

    if (!tokenByAccount.has(accountId)) {
      try {
        tokenByAccount.set(
          accountId,
          await getValidAccessToken(db, accountId),
        );
      } catch {
        tokenByAccount.set(accountId, null);
      }
    }
    const token = tokenByAccount.get(accountId);
    if (!token) {
      errors += 1;
      continue;
    }

    try {
      const runIdColumn = await findHeaderColumn(
        token,
        config.spreadsheet_id,
        config.sheet_tab,
        INCOMPLETE_RUN_ID_HEADER,
      );
      if (runIdColumn === null) continue;

      const rowsByRunId = await findExactValueRows(
        token,
        config.spreadsheet_id,
        config.sheet_tab,
        runIdColumn,
        flowRuns.map((run) => run.id),
      );
      const rowNumbers = [...rowsByRunId.values()];
      if (rowNumbers.length > 0) {
        await deleteSheetRows(
          token,
          config.spreadsheet_id,
          config.sheet_tab,
          rowNumbers,
        );
        removed += rowNumbers.length;
      }

      // Null is safe for completed runs (the incomplete sync excludes them)
      // and prevents repeated cleanup attempts. A missing keyed row means it
      // was already deleted by an earlier attempt or by the sheet owner.
      const { error: clearError } = await db
        .from("flow_runs")
        .update({ incomplete_synced_at: null })
        .in(
          "id",
          flowRuns.map((run) => run.id),
        )
        .eq("status", "completed");
      if (clearError) throw clearError;
    } catch (error) {
      errors += 1;
      console.error(
        `[incomplete-sheet-cleanup] flow ${flowId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { removed, errors };
}
