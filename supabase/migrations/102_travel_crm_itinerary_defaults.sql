-- ============================================================
-- 102_travel_crm_itinerary_defaults.sql — per-flow Travel CRM
-- itinerary defaults for Workspace lead creation.
--
-- Extends travel_crm_flow_settings (101) with one itinerary list
-- per (account, flow): the destination/city/nights rows
-- preselected when creating a Travel CRM lead from that flow's
-- Workspace. Per-lead dialog edits never touch these rows.
--
-- Stored as stable Travel CRM identifiers (lookup `value`s),
-- never invented display text:
--   [{ "destination": "<id>", "city": "<id>", "nights": 4 }]
-- Empty list = no defaults (dialog shows an empty itinerary).
--
-- Tenant isolation + RLS mirror 101 (same table, same policies).
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE travel_crm_flow_settings
  ADD COLUMN IF NOT EXISTS itinerary JSONB NOT NULL DEFAULT '[]'::jsonb;
