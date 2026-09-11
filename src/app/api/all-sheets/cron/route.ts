// GET /api/all-sheets/cron
//
// Independent All Sheets background worker: timeout sweep (enrolled flows
// only), incomplete-tab sync, and completion reconciliation. Secret-gated
// exactly like the existing flows cron. Never invokes the existing flows
// cron, engine, or Google Sheets sync — the two schedules are fully
// independent operations on separate URLs.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runAllSheetsCron } from "@/lib/all-sheets/auto-sync";

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

  try {
    const result = await runAllSheetsCron();
    if (result.skipped) {
      return NextResponse.json(
        { ...result, error: "sweep already in progress" },
        { status: 200 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[all-sheets-cron] sweep failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
