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
  STANDARD_COLUMNS_V2,
  updateHeaderCells,
} from "@/lib/google/sheets";

/** Terminal statuses that count as "incomplete" for the live sheet. */
export const INCOMPLETE_STATUSES = ["timed_out", "failed", "handed_off"];

export interface IncompleteSheetConfigRow {
  flow_id: string;
  account_id: string;
  spreadsheet_id: string;
  spreadsheet_url: string | null;
  spreadsheet_name: string | null;
  sheet_tab: string;
  answer_columns: string[];
  header_written: boolean;
}

function stringifyVar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
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

  const { data: flow } = await db
    .from("flows")
    .select("name")
    .eq("id", config.flow_id)
    .maybeSingle();

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
  const storedKeys = config.answer_columns ?? [];
  const storedKeySet = new Set(storedKeys);
  const newKeys: string[] = [];
  for (const run of runs as RunRow[]) {
    for (const k of Object.keys(run.vars ?? {})) {
      if (!storedKeySet.has(k)) {
        storedKeySet.add(k);
        newKeys.push(k);
      }
    }
  }
  const answerColumns = [...storedKeys, ...newKeys];

  // Header layout: Name (from the contact record) + standard columns +
  // answer vars — same shape as the old one-shot dropped-off export.
  const headers = ["Name", ...STANDARD_COLUMNS_V2, ...answerColumns];
  const baseOffset = 1 + STANDARD_COLUMNS_V2.length;

  if (config.header_written && newKeys.length > 0) {
    await updateHeaderCells(
      accessToken,
      config.spreadsheet_id,
      config.sheet_tab,
      newKeys.map((k, i) => ({
        colIndex: baseOffset + storedKeys.length + i,
        value: k,
      })),
    );
  }

  const rows: (string | number)[][] = (runs as RunRow[]).map((run) => {
    const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
    const vars = (run.vars ?? {}) as Record<string, unknown>;
    return [
      contact?.name ?? "",
      contact?.phone ?? "",
      flow?.name ?? "",
      formatSubmissionTimeIST(run.ended_at ?? run.started_at),
      run.contact_id ?? "",
      ...answerColumns.map((k) => stringifyVar(vars[k])),
    ];
  });

  const toWrite = config.header_written ? rows : [headers, ...rows];
  await appendRows(accessToken, config.spreadsheet_id, config.sheet_tab, toWrite);

  // Persist header/column state, then stamp the watermark. If the stamp
  // failed after a successful append, the next sweep would re-append
  // those rows — accepted trade-off (duplicates over silent data loss).
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
 */
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
      try {
        synced += await syncIncompleteRunsForFlow(db, config, token);
      } catch (err) {
        errors += 1;
        console.error(
          `[incomplete-sheet-sync] flow ${config.flow_id} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { synced, errors };
}
