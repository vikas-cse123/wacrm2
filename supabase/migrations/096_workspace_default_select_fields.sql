-- ============================================================
-- 096_workspace_default_select_fields.sql — convert two default
-- Workspace columns to dropdowns.
--
--   "No. of Calls Tried": number       → single_select ["1"…"10"]
--   "Quotation / Package": text        → single_select ["Sent","Not Yet"]
--
-- Only rows still carrying the OLD type convert. Name matching is
-- case-insensitive + trimmed (the same rule provisioning uses);
-- user-owned columns that merely share a name but already are
-- single_select — or any other type — are left untouched, as is
-- every other column (Assigned To, Call Status, …). Completed and
-- Incomplete are views over the SAME fields, so one conversion
-- serves both — no per-view records exist or are created.
--
-- Values (workspace_values) are NEVER modified by this migration:
-- compatible stored values ("1"…"10", "Sent"/"Not Yet") validate
-- unchanged under the new type; anything else stays stored,
-- keeps rendering as-is, and is REPORTED below via NOTICE
-- (counts + samples) for admin review — never rewritten and
-- never deleted. Column default_value cells are likewise left
-- untouched (incompatible ones are reported, not cleared).
--
-- Google Sheets is untouched: Sheets never reads
-- workspace_fields / workspace_values (migration 088).
--
-- Idempotent — safe to run multiple times (re-runs match zero
-- field rows; the report block is read-only).
-- ============================================================

-- 1. Convert the two default columns from their old types.
UPDATE workspace_fields
SET field_type = 'single_select'::workspace_field_type,
    options = '["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]'::jsonb
WHERE lower(btrim(name)) = 'no. of calls tried'
  AND field_type = 'number'::workspace_field_type;

UPDATE workspace_fields
SET field_type = 'single_select'::workspace_field_type,
    options = '["Sent", "Not Yet"]'::jsonb
WHERE lower(btrim(name)) = 'quotation / package'
  AND field_type = 'text'::workspace_field_type;

-- 2. Report (never rewrite) stored values outside the new options.
DO $$
DECLARE
  v_count INT;
  v_samples TEXT;
BEGIN
  -- "No. of Calls Tried" values outside 1–10.
  SELECT COUNT(*),
         (SELECT string_agg(s, ', ' ORDER BY s)
          FROM (SELECT DISTINCT left(v.value_text, 80) AS s
                FROM workspace_values v
                JOIN workspace_fields f ON f.id = v.field_id
                WHERE lower(btrim(f.name)) = 'no. of calls tried'
                  AND f.field_type = 'single_select'::workspace_field_type
                  AND v.value_text IS NOT NULL
                  AND v.value_text NOT IN
                    ('1', '2', '3', '4', '5', '6', '7', '8', '9', '10')
                LIMIT 20) samples)
  INTO v_count, v_samples
  FROM workspace_values v
  JOIN workspace_fields f ON f.id = v.field_id
  WHERE lower(btrim(f.name)) = 'no. of calls tried'
    AND f.field_type = 'single_select'::workspace_field_type
    AND v.value_text IS NOT NULL
    AND v.value_text NOT IN
      ('1', '2', '3', '4', '5', '6', '7', '8', '9', '10');

  IF COALESCE(v_count, 0) > 0 THEN
    RAISE NOTICE '[096] No. of Calls Tried: % stored value(s) outside 1–10 preserved as-is (not rewritten). Samples: %',
      v_count, v_samples;
  ELSE
    RAISE NOTICE '[096] No. of Calls Tried: all stored values compatible (or none stored).';
  END IF;

  -- "Quotation / Package" values outside Sent / Not Yet.
  SELECT COUNT(*),
         (SELECT string_agg(s, ', ' ORDER BY s)
          FROM (SELECT DISTINCT left(v.value_text, 80) AS s
                FROM workspace_values v
                JOIN workspace_fields f ON f.id = v.field_id
                WHERE lower(btrim(f.name)) = 'quotation / package'
                  AND f.field_type = 'single_select'::workspace_field_type
                  AND v.value_text IS NOT NULL
                  AND v.value_text NOT IN ('Sent', 'Not Yet')
                LIMIT 20) samples)
  INTO v_count, v_samples
  FROM workspace_values v
  JOIN workspace_fields f ON f.id = v.field_id
  WHERE lower(btrim(f.name)) = 'quotation / package'
    AND f.field_type = 'single_select'::workspace_field_type
    AND v.value_text IS NOT NULL
    AND v.value_text NOT IN ('Sent', 'Not Yet');

  IF COALESCE(v_count, 0) > 0 THEN
    RAISE NOTICE '[096] Quotation / Package: % stored value(s) outside Sent/Not Yet preserved as-is (not rewritten). Samples: %',
      v_count, v_samples;
  ELSE
    RAISE NOTICE '[096] Quotation / Package: all stored values compatible (or none stored).';
  END IF;

  -- Column defaults that no longer validate (left in place; the
  -- Edit-column UI enforces option membership on the next edit).
  SELECT string_agg(name, ', ' ORDER BY name)
  INTO v_samples
  FROM workspace_fields
  WHERE lower(btrim(name)) = 'no. of calls tried'
    AND default_value IS NOT NULL
    AND default_value NOT IN
      ('1', '2', '3', '4', '5', '6', '7', '8', '9', '10');
  IF v_samples IS NOT NULL THEN
    RAISE NOTICE '[096] No. of Calls Tried columns with a non-option default (left in place): %',
      v_samples;
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name)
  INTO v_samples
  FROM workspace_fields
  WHERE lower(btrim(name)) = 'quotation / package'
    AND default_value IS NOT NULL
    AND default_value NOT IN ('Sent', 'Not Yet');
  IF v_samples IS NOT NULL THEN
    RAISE NOTICE '[096] Quotation / Package columns with a non-option default (left in place): %',
      v_samples;
  END IF;
END $$;
