-- ============================================================
-- 093_workspace_currency_code.sql — per-column currency for
-- Workspace custom columns.
--
-- Currency columns previously rendered with a fixed app fallback
-- and carried no currency of their own. This adds an explicit
-- ISO-4217 code to the column definition so each Currency column
-- (Package Price → INR, Dubai Price → AED, …) formats with its
-- own currency.
--
-- Display/configuration only:
--   - New currency columns default to 'INR' (applied in the API
--     validator, not by rewriting data).
--   - Existing currency columns keep NULL and render as INR via
--     the code-level fallback — no value conversion, no backfill.
--   - All values stay numeric TEXT in workspace_values; only the
--     column definition gains metadata.
--   - RLS, indexes, and Google Sheets behavior are untouched
--     (Sheets never reads these tables, per migration 088).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE workspace_fields
  ADD COLUMN IF NOT EXISTS currency_code TEXT;

-- Document the contract for future readers.
COMMENT ON COLUMN workspace_fields.currency_code IS
  'ISO-4217 code for currency columns only (NULL for other types). Legacy currency columns keep NULL and render as INR; values stay numeric.';
