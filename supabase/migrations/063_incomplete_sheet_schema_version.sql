-- 063_incomplete_sheet_schema_version.sql
--
-- Version the live incomplete-runs sheet layout (flow_incomplete_sheet_configs),
-- mirroring flow_sheet_configs.schema_version from migration 040.
--
-- Layout versions:
--   2 = frozen legacy layout (Name, Phone Number, Flow Name, Submission
--       Time, User ID, + answer columns, + hidden Flow Run ID). Every
--       incomplete sheet written before this change is v2.
--   3 = slim layout for NEW sheets (Name, Phone Number, Submission Time,
--       + answer columns, + hidden Flow Run ID). "Flow Name" and "User ID"
--       were display-only copies, never lifecycle keys.
--
-- DEFAULT 2 is intentional: all existing configs keep their exact on-sheet
-- layout with zero data movement. Only genuinely NEW incomplete-sheet
-- configurations are stamped schema_version = 3 by the application
-- (see POST /api/flows/[id]/incomplete-sheet). Existing sheets are NEVER
-- upgraded — writers branch on the stored version.
--
-- Idempotent — safe to run multiple times. Schema-only change: no Google
-- Sheets are modified, no rows rewritten, no data migrated.

ALTER TABLE flow_incomplete_sheet_configs
  ADD COLUMN IF NOT EXISTS schema_version INT NOT NULL DEFAULT 2;
