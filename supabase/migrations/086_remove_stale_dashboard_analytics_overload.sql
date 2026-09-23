-- ============================================================
-- 086_remove_stale_dashboard_analytics_overload.sql — drop the
-- legacy 8-argument get_dashboard_analytics() overload
--
-- Problem: migration 083 added `p_daily_from DATE DEFAULT NULL`
-- and `p_daily_to DATE DEFAULT NULL` via CREATE OR REPLACE
-- FUNCTION. In Postgres that creates a NEW 10-argument overload
-- instead of replacing the 8-argument one from 074–082, so the
-- database holds TWO live overloads. PostgREST cannot choose
-- between them for the application's 8-argument call and answers
-- PGRST203 ("Could not choose the best candidate function"),
-- which the API route surfaces as HTTP 500 on every dashboard
-- load. Verified live: the 8-arg call 300s, while the 10-arg
-- call resolves and executes (its own auth guard then applies).
--
-- Fix: drop ONLY the stale 8-argument overload. The current
-- 10-argument function is untouched — its DEFAULT NULL daily
-- params keep every existing caller working:
--   - 8 args → 10-arg function via defaults (default dashboard load)
--   - 10 args → 10-arg function (daily custom-range load)
--
-- The sole runtime caller is GET /api/dashboard/analytics; no
-- SQL body, test, or other route references the 8-arg signature.
--
-- Idempotent — IF EXISTS makes re-runs (and databases where the
-- stale overload is already absent) safe no-ops.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_dashboard_analytics(
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  INT,
  TEXT
);
