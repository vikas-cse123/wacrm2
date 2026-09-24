import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/followups/admin-client";
import { drainDueFollowups } from "@/lib/followups/scheduler";

/**
 * GET /api/followups/cron — drain due reminders. Meant to be hit
 * every minute (Vercel Cron / external pinger / EC2 system cron via
 * scripts/setup-automation-cron.sh), same pattern as
 * /api/automations/cron: shared secret via `x-cron-secret`
 * (CRON_SECRET or AUTOMATION_CRON_SECRET — no new env required).
 * The scheduler claims rows atomically, so overlapping invocations
 * never double-send. Never throws — always JSON.
 *
 * Local development has no automatic trigger — invoke it manually:
 *   curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
 *     http://localhost:3000/api/followups/cron
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expectedSecrets = [
    process.env.CRON_SECRET,
    process.env.AUTOMATION_CRON_SECRET,
  ].filter((secret): secret is string => Boolean(secret));
  if (expectedSecrets.length === 0) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const authorization = request.headers.get("authorization");
  const supplied =
    request.headers.get("x-cron-secret") ??
    (authorization?.startsWith("Bearer ") ? authorization.slice(7) : "");
  const suppliedBuf = Buffer.from(supplied);
  const authorized = expectedSecrets.some((expected) => {
    const expectedBuf = Buffer.from(expected);
    return (
      suppliedBuf.length === expectedBuf.length &&
      timingSafeEqual(suppliedBuf, expectedBuf)
    );
  });
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Service-role client; every scheduler query is explicitly
  // account-scoped, sends resolve credentials per account, and
  // audit attribution uses each follow-up's creator.
  const admin = supabaseAdmin();
  const result = await drainDueFollowups(admin);
  return NextResponse.json({ processed: result.processed, sent: result.sent, failed: result.failed });
}
