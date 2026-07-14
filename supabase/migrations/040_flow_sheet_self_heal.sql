-- 040_flow_sheet_self_heal.sql
--
-- Supports self-healing sheet columns (new/renamed questions picked up
-- automatically on the next sync, no manual relink) and the v2 column
-- layout (no automatic WhatsApp-profile Name column; a flow-captured
-- name, if any, is promoted to the first column instead).
--
-- schema_version: 1 = legacy layout (Name/Phone/Flow/Time/UserID + answer
--   columns, exactly as originally shipped). Existing rows default here
--   so already-linked sheets keep their exact column layout.
-- 2 = current layout (Phone/Flow/Time/UserID, with the flow-captured
--   name promoted first when present). Any NEW link uses this version.

ALTER TABLE flow_sheet_configs
  ADD COLUMN IF NOT EXISTS schema_version INT NOT NULL DEFAULT 1;

ALTER TABLE flow_sheet_configs
  ADD COLUMN IF NOT EXISTS name_column_key TEXT;

ALTER TABLE flow_sheet_configs
  ADD COLUMN IF NOT EXISTS name_column_header TEXT;
