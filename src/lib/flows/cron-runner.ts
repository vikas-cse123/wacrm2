import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveFallbackPolicy } from '@/lib/flows/fallback';
import { cleanupCompletedIncompleteRows } from '@/lib/flows/incomplete-sheet-cleanup';
import { syncAllIncompleteSheets } from '@/lib/flows/incomplete-sheet-sync';

export interface FlowCronResult {
  swept: number;
  sweepErrors: number;
  incompleteSynced: number;
  incompleteErrors: number;
  incompleteRemoved: number;
  incompleteRemovalErrors: number;
}

/**
 * Mark abandoned runs as timed out and append them to their configured
 * incomplete-run sheets. This contains no HTTP/auth logic so the persistent
 * Node server can run it internally as well as through the cron endpoint.
 */
export async function runFlowCron(): Promise<FlowCronResult> {
  const admin = supabaseAdmin();
  const now = new Date();

  const { data: runs, error } = await admin
    .from('flow_runs')
    .select(
      'id, flow_id, user_id, contact_id, last_advanced_at, flows ( fallback_policy )'
    )
    .eq('status', 'active');

  if (error) {
    throw new Error(`Active-run scan failed: ${error.message}`);
  }

  type Row = {
    id: string;
    flow_id: string;
    user_id: string;
    contact_id: string | null;
    last_advanced_at: string;
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null;
  };

  let swept = 0;
  let sweepErrors = 0;
  for (const run of (runs ?? []) as Row[]) {
    const flowsField = Array.isArray(run.flows) ? run.flows[0] : run.flows;
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null);
    const lastAdvanced = new Date(run.last_advanced_at);
    const ageHours =
      (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60);
    if (ageHours < policy.on_timeout_hours) continue;

    const { data: updated, error: updateError } = await admin
      .from('flow_runs')
      .update({
        status: 'timed_out',
        ended_at: now.toISOString(),
        end_reason: 'stale_sweep',
      })
      .eq('id', run.id)
      .eq('status', 'active')
      .select('id');

    if (updateError) {
      sweepErrors += 1;
      console.error(
        `[flows-cron] run ${run.id} timeout update failed:`,
        updateError.message
      );
      continue;
    }

    if (Array.isArray(updated) && updated.length > 0) {
      const { error: eventError } = await admin.from('flow_run_events').insert({
        flow_run_id: run.id,
        event_type: 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 100) / 100,
          policy_hours: policy.on_timeout_hours,
        },
      });
      if (eventError) {
        // The status transition succeeded, so do not count the run as unswept.
        // Keep the audit failure visible in logs and the response diagnostics.
        sweepErrors += 1;
        console.error(
          `[flows-cron] run ${run.id} timeout event failed:`,
          eventError.message
        );
      }
      swept += 1;
    }
  }

  const incomplete = await syncAllIncompleteSheets(admin);
  const cleanup = await cleanupCompletedIncompleteRows(admin);
  return {
    swept,
    sweepErrors,
    incompleteSynced: incomplete.synced,
    incompleteErrors: incomplete.errors,
    incompleteRemoved: cleanup.removed,
    incompleteRemovalErrors: cleanup.errors,
  };
}
