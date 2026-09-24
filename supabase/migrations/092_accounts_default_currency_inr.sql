-- ============================================================
-- 092_accounts_default_currency_inr.sql — INR default currency
--
-- Changes the DEFAULT for `accounts.default_currency` (added in
-- migration 021) from 'USD' to 'INR', matching the app-wide
-- DEFAULT_CURRENCY in src/lib/currency.ts.
--
-- New accounts (created by the signup trigger without an explicit
-- currency) now store 'INR'. EXISTING ROWS ARE UNTOUCHED — any
-- account with a saved value keeps it; only future inserts that
-- omit the column pick up the new default. The format CHECK
-- constraint already accepts any 3-letter code, so 'INR' needs no
-- constraint change.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ALTER COLUMN default_currency SET DEFAULT 'INR';
