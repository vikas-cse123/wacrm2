-- 045_flows_timeout_3hours.sql
--
-- Move flows using the previous global 5-minute or interim 1-hour timeout to
-- the new 3-hour timeout. Other explicitly customized values are unchanged.

UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '3'::jsonb,
  true
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 0)
  IN (0.0833333333, 1);
