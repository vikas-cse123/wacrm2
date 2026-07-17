-- 047_flows_timeout_3hours_resumable.sql
--
-- Report abandoned runs to the incomplete sheet after 3 hours. Timed-out
-- runs remain resumable by the flow engine when the customer replies later.

UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '3'::jsonb,
  true
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 0)
  = 0.0833333333;
