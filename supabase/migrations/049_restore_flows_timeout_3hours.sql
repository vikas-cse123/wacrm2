-- Restore the normal three-hour incomplete-flow timeout after the temporary
-- five-minute production verification. Preserve independently customized
-- flow timeouts.
UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '3'::jsonb,
  true
)
WHERE (fallback_policy->>'on_timeout_hours')::numeric
  BETWEEN 0.083 AND 0.084;
