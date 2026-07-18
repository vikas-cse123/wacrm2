-- Temporarily shorten the standard three-hour timeout to five minutes for a
-- second production verification. Preserve independently customized values.
UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '0.0833333333'::jsonb,
  true
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 0) = 3;
