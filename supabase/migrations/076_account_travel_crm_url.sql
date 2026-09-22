-- ============================================================
-- 076_account_travel_crm_url.sql — cross-app navigation target
--
-- Adds `accounts.travel_crm_url`: the Travel CRM URL opened when a
-- user clicks the "Travel CRM" card pinned to the bottom of the
-- WACRM sidebar (new tab). NULL/empty = card hidden entirely.
--
-- Storage follows the `default_currency` precedent (migration 021):
-- a plain nullable scalar on `accounts`, read through the auth
-- context, written from Settings via a direct client update. No
-- RLS change needed — `accounts_select` (member+) covers the
-- sidebar read and `accounts_update` (admin+) covers the Settings
-- write (see 017_account_sharing.sql).
--
-- No URL CHECK constraint: values are validated app-side
-- (http(s) required) so a future scheme never bricks the
-- migration, and legacy NULL rows are unaffected regardless.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS travel_crm_url TEXT;
