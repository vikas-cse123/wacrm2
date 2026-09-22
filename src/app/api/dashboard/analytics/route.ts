// ============================================================
// GET /api/dashboard/analytics — single-call dashboard data.
//
// Replaces ~89 chunked browser -> PostgREST requests
// (`messages?select=conversation_id...` pages + 200-id
// conversation chunks, each metric re-downloading the same
// rows) with ONE analytics request. All aggregation happens
// inside Postgres via get_dashboard_analytics() (see
// supabase/migrations/074_dashboard_analytics.sql).
//
// Security: uses the RLS-scoped SSR client (caller's JWT) and
// a SECURITY INVOKER RPC that derives the account from
// auth.uid() — no account_id param, no service role, no
// cross-workspace reads.
//
// Query params (all required except tz):
//   start, end, prevStart, prevEnd, yearStart, yearEnd — ISO
//   year — calendar year for the monthly chart
//   tz   — IANA timezone for month bucketing (default UTC)
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

function parseISO(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const url = new URL(request.url);
    const start = parseISO(url.searchParams.get("start"));
    const end = parseISO(url.searchParams.get("end"));
    const prevStart = parseISO(url.searchParams.get("prevStart"));
    const prevEnd = parseISO(url.searchParams.get("prevEnd"));
    const yearStart = parseISO(url.searchParams.get("yearStart"));
    const yearEnd = parseISO(url.searchParams.get("yearEnd"));
    const yearRaw = url.searchParams.get("year");
    const year = yearRaw ? Number(yearRaw) : NaN;
    const tz = (url.searchParams.get("tz") || "UTC").slice(0, 64);

    if (!start || !end || !prevStart || !prevEnd || !yearStart || !yearEnd) {
      return NextResponse.json(
        { error: "start, end, prevStart, prevEnd, yearStart and yearEnd are required ISO timestamps" },
        { status: 400 },
      );
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return NextResponse.json(
        { error: "year must be an integer between 2000 and 2100" },
        { status: 400 },
      );
    }
    if (Date.parse(end) <= Date.parse(start)) {
      return NextResponse.json(
        { error: "end must be after start" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase.rpc("get_dashboard_analytics", {
      p_start: start,
      p_end: end,
      p_prev_start: prevStart,
      p_prev_end: prevEnd,
      p_year_start: yearStart,
      p_year_end: yearEnd,
      p_year: year,
      p_tz: tz,
    });

    if (error) {
      console.error("[dashboard/analytics] rpc error:", error);
      return NextResponse.json(
        { error: "Failed to load dashboard analytics" },
        { status: 500 },
      );
    }

    const res = NextResponse.json(data);
    // Never cache analytics: every dashboard load must show one
    // live request in the Network tab, not a cached response.
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
