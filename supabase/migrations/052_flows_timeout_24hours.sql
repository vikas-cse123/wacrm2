-- Move the incomplete-flow timeout from three hours to twenty-four hours:
-- an unfinished run is only swept into the incomplete-runs sheet after the
-- customer has been idle for 24h (was 3h). Only touches flows still on the
-- standard timeout (3h, or unset → resolver default) — any independently
-- customized value is preserved.
UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '24'::jsonb,
  true
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 3) = 3;
