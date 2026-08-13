-- Make twelve hours the standard incomplete-flow timeout. Flows with a
-- minute-level or other custom timeout are preserved; only the previous
-- standard 24-hour value is migrated.
UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '12'::jsonb,
  true
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 24) = 24;
