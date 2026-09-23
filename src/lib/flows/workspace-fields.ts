// ============================================================
// Workspace custom columns — shared field model + validation.
//
// Custom columns live ONLY in Workspace (workspace_fields /
// workspace_values, migration 088). They never touch flow vars,
// node config, or Google Sheets. Field identity is the UUID;
// display names are unique per flow (case-insensitive) but are
// not identity. All values persist as TEXT (checkbox
// "true"/"false", multi-select JSON array string).
// ============================================================

export const WORKSPACE_FIELD_TYPES = [
  "text",
  "number",
  "currency",
  "date",
  "datetime",
  "single_select",
  "multi_select",
  "checkbox",
  "url",
] as const;

export type WorkspaceFieldType = (typeof WORKSPACE_FIELD_TYPES)[number];

export const WORKSPACE_FIELD_TYPE_LABELS: Record<WorkspaceFieldType, string> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  date: "Date",
  datetime: "Date & Time",
  single_select: "Single Select",
  multi_select: "Multi Select",
  checkbox: "Checkbox",
  url: "URL",
};

export function isWorkspaceFieldType(value: unknown): value is WorkspaceFieldType {
  return (
    typeof value === "string" &&
    (WORKSPACE_FIELD_TYPES as readonly string[]).includes(value)
  );
}

export interface WorkspaceField {
  id: string;
  account_id: string;
  flow_id: string;
  name: string;
  field_type: WorkspaceFieldType;
  position: number;
  /** Select options (single/multi). Null for other types. */
  options: string[] | null;
  /** Default for NEW records only — never backfilled. Null = none. */
  default_value: string | null;
  created_at: string;
  updated_at: string;
}

/** Values keyed by run id, then field id. Missing = unset. */
export type WorkspaceValuesByRun = Record<string, Record<string, string | null>>;

export const WORKSPACE_FIELD_NAME_MAX = 80;
export const WORKSPACE_FIELD_TEXT_MAX = 2000;
export const WORKSPACE_FIELD_OPTIONS_MAX = 50;
export const WORKSPACE_FIELD_OPTION_MAX = 80;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (
    d.getFullYear() === Number(match[1]) &&
    d.getMonth() === Number(match[2]) - 1 &&
    d.getDate() === Number(match[3])
  );
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeOptions(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("Options must be a list.");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("Options must be non-empty text.");
    }
    const trimmed = raw.trim();
    if (trimmed.length > WORKSPACE_FIELD_OPTION_MAX) {
      throw new Error(
        `Each option must be ${WORKSPACE_FIELD_OPTION_MAX} characters or fewer.`,
      );
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate option "${trimmed}".`);
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export interface WorkspaceFieldInput {
  name: unknown;
  field_type: unknown;
  options?: unknown;
  default_value?: unknown;
}

export interface ValidWorkspaceFieldDef {
  name: string;
  field_type: WorkspaceFieldType;
  options: string[] | null;
  default_value: string | null;
}

/**
 * Validate a new/edited field definition. Type changes are rejected
 * by the caller (values would orphan) — this validates one shape.
 * Throws with a human-readable message; never returns partial data.
 */
export function validateWorkspaceFieldDef(
  input: WorkspaceFieldInput,
): ValidWorkspaceFieldDef {
  if (!isNonEmptyString(input.name)) {
    throw new Error("Column name is required.");
  }
  const name = input.name.trim();
  if (name.length > WORKSPACE_FIELD_NAME_MAX) {
    throw new Error(
      `Column name must be ${WORKSPACE_FIELD_NAME_MAX} characters or fewer.`,
    );
  }
  if (!isWorkspaceFieldType(input.field_type)) {
    throw new Error("Unknown column type.");
  }
  const field_type = input.field_type;
  const isSelect = field_type === "single_select" || field_type === "multi_select";

  let options: string[] | null = null;
  if (isSelect) {
    options = normalizeOptions(input.options);
    if (!options || options.length === 0) {
      throw new Error("Select columns need at least one option.");
    }
    if (options.length > WORKSPACE_FIELD_OPTIONS_MAX) {
      throw new Error(
        `At most ${WORKSPACE_FIELD_OPTIONS_MAX} options per column.`,
      );
    }
  } else if (
    input.options !== undefined &&
    input.options !== null &&
    (!Array.isArray(input.options) || input.options.length > 0)
  ) {
    throw new Error("Only select columns take options.");
  }

  let default_value: string | null = null;
  const rawDefault = input.default_value;
  if (rawDefault !== undefined && rawDefault !== null && rawDefault !== "") {
    if (typeof rawDefault !== "string") {
      throw new Error("Default value must be text.");
    }
    const trimmed = rawDefault.trim();
    if (field_type === "single_select") {
      if (!options!.some((o) => o === trimmed)) {
        throw new Error("Default must be one of the options.");
      }
      default_value = trimmed;
    } else if (field_type === "multi_select") {
      if (!options!.some((o) => o === trimmed)) {
        throw new Error("Default must be one of the options.");
      }
      default_value = trimmed;
    } else if (field_type === "checkbox") {
      if (trimmed !== "true" && trimmed !== "false") {
        throw new Error("Checkbox default must be true or false.");
      }
      default_value = trimmed;
    } else {
      // Text-like defaults validate exactly like a cell value.
      default_value = validateWorkspaceValue(field_type, options, trimmed);
    }
  }

  return { name, field_type, options, default_value };
}

/**
 * Validate + normalize one cell value for storage. Returns the
 * TEXT to persist, or null when the cell is being cleared.
 * Throws with a human-readable message on invalid input.
 */
export function validateWorkspaceValue(
  field_type: WorkspaceFieldType,
  options: string[] | null,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  switch (field_type) {
    case "text":
    case "url": {
      if (typeof value !== "string") throw new Error("Value must be text.");
      const trimmed = value.trim();
      if (trimmed.length > WORKSPACE_FIELD_TEXT_MAX) {
        throw new Error(
          `Value must be ${WORKSPACE_FIELD_TEXT_MAX} characters or fewer.`,
        );
      }
      if (field_type === "url" && !isValidHttpUrl(trimmed)) {
        throw new Error("Enter a valid http(s) URL.");
      }
      return trimmed;
    }
    case "number":
    case "currency": {
      const num = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(num)) throw new Error("Enter a valid number.");
      return String(num);
    }
    case "date": {
      if (typeof value !== "string" || !isValidDateKey(value.trim())) {
        throw new Error("Enter a valid date (YYYY-MM-DD).");
      }
      return value.trim();
    }
    case "datetime": {
      if (typeof value !== "string") throw new Error("Enter a valid date and time.");
      const t = Date.parse(value.trim());
      if (Number.isNaN(t)) throw new Error("Enter a valid date and time.");
      return new Date(t).toISOString();
    }
    case "checkbox": {
      if (value === true || value === "true") return "true";
      if (value === false || value === "false") return "false";
      throw new Error("Checkbox value must be true or false.");
    }
    case "single_select": {
      if (typeof value !== "string" || !(options ?? []).some((o) => o === value.trim())) {
        throw new Error("Choose one of the column options.");
      }
      return value.trim();
    }
    case "multi_select": {
      const arr = Array.isArray(value) ? value : [value];
      const allowed = options ?? [];
      const picked: string[] = [];
      for (const raw of arr) {
        if (typeof raw !== "string" || !allowed.some((o) => o === raw.trim())) {
          throw new Error("Choose only from the column options.");
        }
        if (!picked.includes(raw.trim())) picked.push(raw.trim());
      }
      return JSON.stringify(picked);
    }
  }
}

/** Parse a stored multi-select value back into its option list. */
export function parseMultiSelectValue(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return stored ? [stored] : [];
  }
}

/**
 * Display value for a cell: stored value, else the field default
 * (defaults populate NEW records visually without ever writing
 * history — existing rows are never backfilled).
 */
export function displayWorkspaceValue(
  field: Pick<WorkspaceField, "default_value">,
  stored: string | null | undefined,
): string | null {
  if (stored !== null && stored !== undefined) return stored;
  return field.default_value;
}
