-- 043_flows_timeout_10min.sql
--
-- Bring existing flows in line with the new 10-minute stale-run sweep.
-- Earlier rows were created with `on_timeout_hours = 24`, so merely
-- changing the app default would leave older flows timing out far too
-- late. This migration updates any flow still carrying the old default
-- to 10 minutes while preserving flows that were already customized.

UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '0.1666666667'::jsonb,
  false
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 24) = 24;
