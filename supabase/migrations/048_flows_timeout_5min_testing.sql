-- Temporarily shorten the resumable incomplete-flow timeout to five minutes
-- for production verification. Runs remain resumable after timing out, and
-- completed runs are still removed from the incomplete sheet by the cron.
-- Preserve any flow whose timeout was customized away from the previous
-- three-hour default.
UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '0.0833333333'::jsonb,
  true
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 0) = 3;
