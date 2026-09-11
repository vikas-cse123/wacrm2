// All Sheets — independent background worker (isolated).
//
// Runs on its own schedule via GET /api/all-sheets/cron (see vercel.json;
// the endpoint is secret-gated exactly like the existing flows cron).
// It NEVER calls the existing flows cron, engine, or Google Sheets sync:
//
//   1. Timeout sweep (enrolled flows only): active runs past their
//      per-flow `fallback_policy.on_timeout_hours` (timed from
//      `last_advanced_at`, default 12h) transition active → timed_out with
//      the identical guarded update + timeout event the existing sweep
//      performs, so the two can never diverge (status precondition makes
//      double-processing a no-op).
//   2. Incomplete sync: terminal non-completed runs missing own tab state
//      are appended to their flow's Incomplete tab (bounded per pass).
//   3. Completion reconcile: completed runs missing completed-tab state
//      are appended; completed runs still carrying incomplete-tab state
//      have their Incomplete rows removed.
//
// Only flows enrolled in All Sheets (having tabs) are processed — the
// worker never creates collections or tabs. Enrollment stays manual via
// "Add to All Sheets". Idempotent: re-running appends nothing twice
// (own tab state + hidden Run ID presence checks).
//
// Tables written: flow_runs (timeout transition on enrolled flows only,
// byte-identical to the existing sweep), flow_run_events (timeout audit),
// all_sheet_* (own state). Never: flow_sheet_configs,
// flow_incomplete_sheet_configs, flow_runs.incomplete_synced_at,
// google_sheets_sync_failures.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getValidAccessToken } from "@/lib/google/oauth";
import { resolveFallbackPolicy } from "@/lib/flows/fallback";
import { handleAllSheetCompletion } from "./completion";
import { refreshAllSheetIncomplete } from "./sync";
import type {
  AllSheetCollectionRow,
  AllSheetFlowTabRow,
} from "./types";

export const ALL_SHEETS_WORKER_BATCH = 50;

export interface AllSheetsCronResult {
  swept: number;
  sweepErrors: number;
  incompleteSynced: number;
  incompleteErrors: number;
  completedSynced: number;
  completedErrors: number;
  incompleteRemoved: number;
  incompleteRemovalErrors: number;
  skipped: boolean;
}

export interface AllSheetsCronDeps {
  db?: SupabaseClient;
  getToken?: (accountId: string) => Promise<string | null>;
}

// Process-local re-entrancy guard (mirrors the existing cron-runner:
// overlapping passes are dropped, never queued).
let sweepInFlight = false;

export function isAllSheetsCronRunning(): boolean {
  return sweepInFlight;
}

interface EnrolledFlow {
  accountId: string;
  flowId: string;
  incomplete: { collection: AllSheetCollectionRow; tab: AllSheetFlowTabRow } | null;
  completed: { collection: AllSheetCollectionRow; tab: AllSheetFlowTabRow } | null;
}

async function loadEnrolledFlows(db: SupabaseClient): Promise<EnrolledFlow[]> {
  const { data: collections } = await db.from("all_sheet_collections").select("*");
  const cols = (collections ?? []) as AllSheetCollectionRow[];
  if (cols.length === 0) return [];
  const { data: tabs } = await db
    .from("all_sheet_flow_tabs")
    .select("*")
    .in(
      "collection_id",
      cols.map((c) => c.id),
    );
  const byFlow = new Map<string, EnrolledFlow>();
  for (const t of (tabs ?? []) as AllSheetFlowTabRow[]) {
    const col = cols.find((c) => c.id === t.collection_id);
    if (!col) continue;
    let entry = byFlow.get(t.flow_id);
    if (!entry) {
      entry = { accountId: col.account_id, flowId: t.flow_id, incomplete: null, completed: null };
      byFlow.set(t.flow_id, entry);
    }
    if (col.kind === "incomplete") entry.incomplete = { collection: col, tab: t };
    else entry.completed = { collection: col, tab: t };
  }
  return [...byFlow.values()];
}

/**
 * Guarded timeout transition for ONE flow's active runs, mirroring the
 * existing sweep's effect exactly (status, ended_at, end_reason,
 * timeout event). Only runs past the flow's own threshold move.
 */
export async function sweepAllSheetTimeouts(
  db: SupabaseClient,
  flowId: string,
  now: Date = new Date(),
): Promise<{ swept: number; errors: number }> {
  const { data: flow } = await db
    .from("flows")
    .select("fallback_policy")
    .eq("id", flowId)
    .maybeSingle();
  const policy = resolveFallbackPolicy(
    (flow as { fallback_policy?: unknown } | null)?.fallback_policy ?? null,
  );

  const { data: runs, error } = await db
    .from("flow_runs")
    .select("id, last_advanced_at")
    .eq("flow_id", flowId)
    .eq("status", "active");
  if (error) throw error;

  let swept = 0;
  let errors = 0;
  for (const run of (runs ?? []) as Array<{ id: string; last_advanced_at: string }>) {
    const ageHours = (now.getTime() - new Date(run.last_advanced_at).getTime()) / (1000 * 60 * 60);
    if (ageHours < policy.on_timeout_hours) continue;
    const { data: updated, error: updateError } = await db
      .from("flow_runs")
      .update({ status: "timed_out", ended_at: now.toISOString(), end_reason: "stale_sweep" })
      .eq("id", run.id)
      .eq("status", "active")
      .select("id");
    if (updateError || !updated || (updated as unknown[]).length === 0) {
      // Lost a race with the existing cron (or a concurrent pass) — the
      // run already moved. Not an error for our purposes unless the DB
      // itself failed.
      if (updateError) errors += 1;
      continue;
    }
    const { error: eventError } = await db.from("flow_run_events").insert({
      flow_run_id: run.id,
      event_type: "timeout",
      payload: { age_hours: Math.round(ageHours * 100) / 100, policy_hours: policy.on_timeout_hours },
    });
    if (eventError) errors += 1;
    else swept += 1;
  }
  return { swept, errors };
}

/**
 * Completion reconciliation for ONE flow: completed runs missing
 * completed-tab state get appended (bounded, oldest first); completed
 * runs still carrying incomplete-tab state are handled through the
 * completion handler (which removes then appends as needed).
 */
async function reconcileCompleted(
  db: SupabaseClient,
  enrolled: EnrolledFlow,
  token: string,
): Promise<{ synced: number; errors: number; removed: number; removalErrors: number }> {
  const out = { synced: 0, errors: 0, removed: 0, removalErrors: 0 };
  if (!enrolled.completed) return out;

  const { tab } = enrolled.completed;
  const { data: states } = await db
    .from("all_sheet_tab_run_state")
    .select("flow_run_id")
    .eq("tab_id", tab.id);
  const syncedIds = new Set((states ?? []).map((s) => s.flow_run_id as string));

  // Oldest-first candidate window; the state filter below keeps it exact.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id, ended_at")
    .eq("flow_id", enrolled.flowId)
    .eq("status", "completed")
    .order("ended_at", { ascending: true })
    .limit(ALL_SHEETS_WORKER_BATCH * 4);
  const missing = ((runs ?? []) as Array<{ id: string }>)
    .map((r) => r.id)
    .filter((id) => !syncedIds.has(id))
    .slice(0, ALL_SHEETS_WORKER_BATCH);

  for (const runId of missing) {
    try {
      const res = await handleAllSheetCompletion(db, runId, {
        getToken: () => Promise.resolve(token),
      });
      if (res.completed) out.synced += 1;
      else out.errors += 1;
      if (!res.removedIncomplete) out.removalErrors += 1;
    } catch {
      out.errors += 1;
    }
  }

  // Removal-only pass: completed runs that ARE completed-synced but still
  // carry incomplete-tab state (hook appended, removal failed earlier).
  if (enrolled.incomplete) {
    try {
      const { data: incStates } = await db
        .from("all_sheet_tab_run_state")
        .select("flow_run_id")
        .eq("tab_id", enrolled.incomplete.tab.id)
        .limit(200);
      const ids = (incStates ?? []).map((s) => s.flow_run_id as string);
      if (ids.length > 0) {
        const { data: done } = await db.from("flow_runs").select("id").in("id", ids).eq("status", "completed");
        for (const row of (done ?? []) as Array<{ id: string }>) {
          try {
            const res = await handleAllSheetCompletion(db, row.id, {
              getToken: () => Promise.resolve(token),
            });
            if (res.removedIncomplete) out.removed += 1;
            else out.removalErrors += 1;
          } catch {
            out.removalErrors += 1;
          }
        }
      }
    } catch {
      out.removalErrors += 1;
    }
  }
  return out;
}

export async function runAllSheetsCron(deps?: AllSheetsCronDeps): Promise<AllSheetsCronResult> {
  if (sweepInFlight) {
    return {
      swept: 0, sweepErrors: 0, incompleteSynced: 0, incompleteErrors: 0,
      completedSynced: 0, completedErrors: 0, incompleteRemoved: 0,
      incompleteRemovalErrors: 0, skipped: true,
    };
  }
  sweepInFlight = true;
  try {
    return await runAllSheetsCronUnlocked(deps);
  } finally {
    sweepInFlight = false;
  }
}

async function runAllSheetsCronUnlocked(deps?: AllSheetsCronDeps): Promise<AllSheetsCronResult> {
  const db = deps?.db ?? supabaseAdmin();
  const getToken =
    deps?.getToken ?? ((accountId: string) => getValidAccessToken(db, accountId));
  const result: AllSheetsCronResult = {
    swept: 0, sweepErrors: 0, incompleteSynced: 0, incompleteErrors: 0,
    completedSynced: 0, completedErrors: 0, incompleteRemoved: 0,
    incompleteRemovalErrors: 0, skipped: false,
  };

  const enrolled = await loadEnrolledFlows(db);
  const byAccount = new Map<string, EnrolledFlow[]>();
  for (const e of enrolled) {
    const list = byAccount.get(e.accountId) ?? [];
    list.push(e);
    byAccount.set(e.accountId, list);
  }

  for (const [accountId, flows] of byAccount) {
    let token: string | null = null;
    try {
      token = await getToken(accountId);
    } catch {
      token = null;
    }
    if (!token) continue;

    for (const flow of flows) {
      // 1. Timeout sweep for flows with an incomplete tab.
      if (flow.incomplete) {
        try {
          const sweep = await sweepAllSheetTimeouts(db, flow.flowId);
          result.swept += sweep.swept;
          result.sweepErrors += sweep.errors;
        } catch {
          result.sweepErrors += 1;
          continue; // without fresh terminal states, sync would be stale anyway
        }
        // 2. Incomplete sync (bounded, idempotent).
        try {
          const r = await refreshAllSheetIncomplete(db, flow.incomplete.collection, flow.incomplete.tab, token, {
            limit: ALL_SHEETS_WORKER_BATCH,
          });
          result.incompleteSynced += r.imported;
        } catch {
          result.incompleteErrors += 1;
        }
      }
      // 3. Completion reconcile (both directions).
      try {
        const c = await reconcileCompleted(db, flow, token);
        result.completedSynced += c.synced;
        result.completedErrors += c.errors;
        result.incompleteRemoved += c.removed;
        result.incompleteRemovalErrors += c.removalErrors;
      } catch {
        result.completedErrors += 1;
      }
    }
  }
  return result;
}
