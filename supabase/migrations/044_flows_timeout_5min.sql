-- 044_flows_timeout_5min.sql
--
-- Bring existing flows in line with the new 5-minute stale-run sweep.
-- Earlier rows may already have been updated to 10 minutes, so this
-- migration normalizes both the old 24-hour default and the interim
-- 10-minute value to 5 minutes while preserving custom overrides.

UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '0.0833333333'::jsonb,
  false
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 24) IN (24, 0.1666666667);
