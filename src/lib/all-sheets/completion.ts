// All Sheets — automatic completion handling (isolated).
//
// Called best-effort when a flow run completes (engine hook) and by the
// background worker during reconciliation. For one completed run:
//
//   1. Remove its row from the flow's INCOMPLETE tab (located by the
//      hidden Flow Run ID — the stable per-run identity, never
//      name/phone/time), if present.
//   2. Append it to the flow's COMPLETED tab unless already recorded.
//   3. Record independent All Sheets state (all_sheet_tab_run_state).
//
// Guarantees:
//   - Never throws: every failure is logged to
//     all_sheet_tab_sync_failures (or console when no tab context exists)
//     and reported in the return value. The flow engine and the existing
//     Google Sheets behavior can never be affected.
//   - Idempotent: re-running for the same run appends nothing twice
//     (completed-tab state short-circuits; incomplete removal clears
//     state even when the row is already absent).
//   - Missing incomplete rows never block the completed append.
//   - Flows without All Sheets tabs are ignored entirely (enrollment).
//
// Reads/writes ONLY all_sheet_* tables (+ flows/flow_runs/contacts reads).
// Never touches flow_sheet_configs, flow_incomplete_sheet_configs,
// flow_runs.incomplete_synced_at, or google_sheets_sync_failures.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidAccessToken } from "@/lib/google/oauth";
import { resolveAllTabWorksheet } from "./flow-tabs";
import {
  importAllSheetCompleted,
  removeRunsFromIncompleteTab,
} from "./sync";
import type {
  AllSheetCollectionRow,
  AllSheetFlowTabRow,
} from "./types";

export interface AllSheetCompletionResult {
  /** True when the completed row is now recorded (or was already). */
  completed: boolean;
  /** True when no incomplete-tab state remains for the run. */
  removedIncomplete: boolean;
  /** Human-readable shortfall when either half did not finish. */
  error?: string;
}

const NOTHING: AllSheetCompletionResult = { completed: false, removedIncomplete: true };

async function logTabFailure(
  db: SupabaseClient,
  accountId: string,
  tab: AllSheetFlowTabRow | null,
  flowId: string,
  runId: string,
  error: unknown,
): Promise<void> {
  try {
    await db.from("all_sheet_tab_sync_failures").insert({
      account_id: accountId,
      tab_id: tab?.id ?? null,
      flow_id: flowId,
      flow_run_id: runId,
      contact_id: null,
      payload: { op: "auto_completion" },
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Failure logging must never break the caller either.
  }
}

async function loadTabs(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<{ completed: { collection: AllSheetCollectionRow; tab: AllSheetFlowTabRow } | null; incomplete: { collection: AllSheetCollectionRow; tab: AllSheetFlowTabRow } | null }> {
  const { data: collections } = await db
    .from("all_sheet_collections")
    .select("*")
    .eq("account_id", accountId);
  const cols = (collections ?? []) as AllSheetCollectionRow[];
  if (cols.length === 0) return { completed: null, incomplete: null };

  const { data: tabs } = await db
    .from("all_sheet_flow_tabs")
    .select("*")
    .eq("flow_id", flowId)
    .in(
      "collection_id",
      cols.map((c) => c.id),
    );
  const pick = (kind: "completed" | "incomplete") => {
    const collection = cols.find((c) => c.kind === kind) ?? null;
    const tab = ((tabs ?? []) as AllSheetFlowTabRow[]).find((t) => t.collection_id === collection?.id) ?? null;
    return collection && tab ? { collection, tab } : null;
  };
  return { completed: pick("completed"), incomplete: pick("incomplete") };
}

/**
 * Best-effort automatic transition for one completed run. Never throws.
 */
export async function handleAllSheetCompletion(
  db: SupabaseClient,
  runId: string,
  opts?: { getToken?: (accountId: string) => Promise<string | null> },
): Promise<AllSheetCompletionResult> {
  try {
    const { data: run } = await db
      .from("flow_runs")
      .select("id, flow_id, account_id, status")
      .eq("id", runId)
      .maybeSingle();
    const row = run as { id: string; flow_id: string; account_id: string; status: string } | null;
    // Only completed runs transition. Anything else (active, timed_out,
    // failed, handed_off, missing) is a no-op — the incomplete worker
    // owns those paths and must never see a completed insert from here.
    if (!row || row.status !== "completed") return { ...NOTHING };

    const tabs = await loadTabs(db, row.account_id, row.flow_id);
    if (!tabs.completed && !tabs.incomplete) return { ...NOTHING };

    const getToken = opts?.getToken ?? ((accountId: string) => getValidAccessToken(db, accountId));
    const token = await getToken(row.account_id).catch(() => null);
    if (!token) {
      await logTabFailure(db, row.account_id, tabs.completed?.tab ?? tabs.incomplete?.tab ?? null, row.flow_id, row.id, new Error("no_google_connection"));
      return { completed: false, removedIncomplete: false, error: "no_google_connection" };
    }

    let removedIncomplete = true;
    if (tabs.incomplete) {
      try {
        const live = await resolveAllTabWorksheet(db, tabs.incomplete.collection, tabs.incomplete.tab, token);
        const { data: states } = await db
          .from("all_sheet_tab_run_state")
          .select("flow_run_id")
          .eq("tab_id", live.id)
          .eq("flow_run_id", row.id);
        if ((states ?? []).length > 0) {
          await removeRunsFromIncompleteTab(db, tabs.incomplete.collection, live, token, [row.id]);
        }
      } catch (err) {
        // Removal failure must not block the completed append; the
        // background worker retries removal on its next pass.
        removedIncomplete = false;
        await logTabFailure(db, row.account_id, tabs.incomplete.tab, row.flow_id, row.id, err);
      }
    }

    let completed = false;
    if (tabs.completed) {
      try {
        const live = await resolveAllTabWorksheet(db, tabs.completed.collection, tabs.completed.tab, token);
        const { data: states } = await db
          .from("all_sheet_tab_run_state")
          .select("flow_run_id")
          .eq("tab_id", live.id)
          .eq("flow_run_id", row.id);
        if ((states ?? []).length > 0) {
          completed = true;
        } else {
          const { imported } = await importAllSheetCompleted(db, tabs.completed.collection, live, token, {
            runIds: [row.id],
          });
          completed = imported > 0;
          if (!completed) {
            // Already recorded between our check and the append (race) —
            // treat as done rather than as a failure.
            completed = true;
          }
        }
      } catch (err) {
        await logTabFailure(db, row.account_id, tabs.completed.tab, row.flow_id, row.id, err);
        return { completed: false, removedIncomplete, error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      completed = true; // no completed tab enrolled — nothing to do
    }

    return { completed, removedIncomplete };
  } catch (err) {
    console.error("[all-sheets] completion handler failed:", err);
    return { completed: false, removedIncomplete: false, error: err instanceof Error ? err.message : String(err) };
  }
}
