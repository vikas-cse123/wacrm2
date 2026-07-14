-- 039_flow_sheet_answer_headers.sql
--
-- Store the human-readable question text for each answer column so the
-- sheet header row can read "Which hotel category would you prefer?"
-- instead of the raw var_key ("hotelCategory"). Parallel to
-- answer_columns (the var_keys, kept for value lookup); same length/order.

ALTER TABLE flow_sheet_configs
  ADD COLUMN IF NOT EXISTS answer_headers TEXT[] NOT NULL DEFAULT '{}';
