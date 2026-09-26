-- ============================================================
-- 103_travel_crm_departure_defaults.sql — per-flow Travel CRM
-- departure defaults for Workspace lead creation.
--
-- Extends travel_crm_flow_settings (101/102) with one departure
-- default per (account, flow): the departure country/city
-- preselected when creating a Travel CRM lead from that flow's
-- Workspace. Per-lead dialog edits never touch these columns.
--
-- Stored as stable Travel CRM identifiers (lookup `value`s),
-- never invented display text. NULL country = no defaults (the
-- dialog stays empty); a city is only stored alongside its
-- country. Compatibility is validated against live Travel CRM
-- lookup data at save time (API route), not here.
--
-- Tenant isolation + RLS mirror 101 (same table, same policies).
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE travel_crm_flow_settings
  ADD COLUMN IF NOT EXISTS departure_country TEXT;
ALTER TABLE travel_crm_flow_settings
  ADD COLUMN IF NOT EXISTS departure_city TEXT;
