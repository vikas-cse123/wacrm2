import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runFlowCron } from '@/lib/flows/cron-runner';

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 5m), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: Vercel calls this endpoint from vercel.json. Persistent Node
 * deployments also run the same job internally from instrumentation.ts.
 */
export async function GET(request: Request) {
  const expectedSecrets = [
    process.env.CRON_SECRET,
    process.env.AUTOMATION_CRON_SECRET,
  ].filter((secret): secret is string => Boolean(secret));
  if (expectedSecrets.length === 0) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
  const authorization = request.headers.get('authorization');
  const supplied =
    request.headers.get('x-cron-secret') ??
    (authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
  const suppliedBuf = Buffer.from(supplied);
  const authorized = expectedSecrets.some((expected) => {
    const expectedBuf = Buffer.from(expected);
    return (
      suppliedBuf.length === expectedBuf.length &&
      timingSafeEqual(suppliedBuf, expectedBuf)
    );
  });
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return NextResponse.json(await runFlowCron());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[flows-cron] sweep failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
