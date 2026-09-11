-- ============================================================
-- Allow the new 'send_cta_url' (link button) flow node type.
--
-- flow_nodes.node_type is guarded by a CHECK constraint that whitelists
-- known node types (last set in 038). Without this the builder saves a
-- send_cta_url node and Postgres rejects the insert with
-- "flow_nodes_node_type_check" violation.
-- ============================================================
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'send_cta_url',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'google_sheets_sync',
    'end'
  ));
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
