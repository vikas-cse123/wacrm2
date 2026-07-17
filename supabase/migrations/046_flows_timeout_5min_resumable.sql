-- 046_flows_timeout_5min_resumable.sql
--
-- Temporary verification window: report abandoned runs to the incomplete
-- sheet after 5 minutes. Timed-out runs remain resumable by the flow engine.

UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '0.0833333333'::jsonb,
  true
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 0) = 3;
