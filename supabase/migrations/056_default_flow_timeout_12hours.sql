-- New flows previously inherited the original database default of 24 hours,
-- regardless of the application default. Make the persistent Supabase default
-- twelve hours as well, and normalize any remaining old-default rows.
ALTER TABLE flows
  ALTER COLUMN fallback_policy SET DEFAULT
  '{"on_unknown_reply":"reprompt","max_reprompts":2,"on_timeout_hours":12,"on_exhaust":"handoff"}'::jsonb;

UPDATE flows
SET fallback_policy = jsonb_set(
  COALESCE(fallback_policy, '{}'::jsonb),
  '{on_timeout_hours}',
  '12'::jsonb,
  true
)
WHERE COALESCE((fallback_policy->>'on_timeout_hours')::numeric, 24) = 24;
