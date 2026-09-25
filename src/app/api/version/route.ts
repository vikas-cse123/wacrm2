import { NextResponse } from "next/server";

/**
 * GET /api/version — lightweight build/version signal (no auth).
 * Lets operators verify which build a deployment actually runs:
 * compare `commit` against the expected git SHA after deploys.
 * Exposes only the commit SHA + build timestamp — no secrets,
 * no environment contents.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    commit:
      process.env.NEXT_PUBLIC_BUILD_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      "unknown",
    builtAt: process.env.NEXT_PUBLIC_BUILD_TIME ?? null,
  });
}
