/**
 * Persistent-server fallback for flow timeouts.
 *
 * Vercel runs /api/flows/cron from vercel.json. The production CRM is a
 * long-lived Next.js process on AWS, where vercel.json is ignored. Start the
 * same sweep inside that Node process so abandoned flows do not depend on an
 * separately-installed OS crontab. The database update is status-guarded and
 * the sheet sync is watermarked, so an external cron can safely coexist.
 */
export async function register() {
  if (
    process.env.NEXT_RUNTIME !== 'nodejs' ||
    process.env.NODE_ENV !== 'production' ||
    process.env.VERCEL ||
    process.env.DISABLE_INTERNAL_FLOW_CRON === 'true'
  ) {
    return;
  }

  const globalState = globalThis as typeof globalThis & {
    __wacrmFlowCron?: {
      running: boolean;
      timer: ReturnType<typeof setInterval>;
    };
  };
  if (globalState.__wacrmFlowCron) return;

  const state = {
    running: false,
    timer: undefined as unknown as ReturnType<typeof setInterval>,
  };
  globalState.__wacrmFlowCron = state;

  const sweep = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const { runFlowCron } = await import('@/lib/flows/cron-runner');
      const result = await runFlowCron();
      if (
        result.swept > 0 ||
        result.incompleteSynced > 0 ||
        result.sweepErrors > 0 ||
        result.incompleteErrors > 0
      ) {
        console.info('[flows-cron] internal sweep:', result);
      }
    } catch (error) {
      console.error(
        '[flows-cron] internal sweep failed:',
        error instanceof Error ? error.message : error
      );
    } finally {
      state.running = false;
    }
  };

  // Start shortly after boot, then check every minute. With a 3-hour timeout,
  // incomplete rows normally appear between 180 and 181 minutes after the
  // last answer.
  const initial = setTimeout(() => void sweep(), 15_000);
  initial.unref();
  state.timer = setInterval(() => void sweep(), 60_000);
  state.timer.unref();
}
