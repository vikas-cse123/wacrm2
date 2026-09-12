// ============================================================
// Google Sheets REST helpers — create a spreadsheet, resolve a pasted
// URL, and append a row. Direct fetch calls against the Sheets/Drive v4
// APIs (no googleapis SDK). All calls take an already-valid access token
// from lib/google/oauth.
// ============================================================

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Standard leading columns, by schema version.
 *
 * v1 (legacy — sheets linked before the self-healing columns change):
 *   Name (WhatsApp profile name), Phone Number, Flow Name, Submission
 *   Time, User ID. Frozen — existing v1 sheets keep this exact layout.
 *
 * v2 (legacy — sheets linked before the V3 slim-columns change):
 *   Phone Number, Flow Name, Submission Time, User ID, with the
 *   flow-captured name (if any) promoted to a leading Name column.
 *   Frozen — existing v2 sheets keep this exact layout.
 *
 * v3 (current — any sheet linked from now on): Phone Number and
 * Submission Time only. "Flow Name" (a flows.name snapshot) and
 * "User ID" (a contacts.id snapshot) were display-only copies — never
 * lifecycle keys — so new sheets omit them. Existing V1/V2 sheets are
 * NEVER upgraded; writers branch on the stored schema_version.
 */
export const STANDARD_COLUMNS_V1 = [
  "Name",
  "Phone Number",
  "Flow Name",
  "Submission Time",
  "User ID",
] as const;

export const STANDARD_COLUMNS_V2 = [
  "Phone Number",
  "Flow Name",
  "Submission Time",
  "User ID",
] as const;

export const STANDARD_COLUMNS_V3 = [
  "Phone Number",
  "Submission Time",
] as const;

/** @deprecated use STANDARD_COLUMNS_V1 / STANDARD_COLUMNS_V2 */
export const STANDARD_COLUMNS = STANDARD_COLUMNS_V1;

export const CURRENT_SHEET_SCHEMA_VERSION = 3;

/**
 * Standard leading columns for a stored schema version. Unknown/nullish
 * versions fall back to v1 (the original layout), matching the
 * `?? 1` convention at every writer. Never reorders or mutates V1/V2.
 */
export function standardColumnsForSchemaVersion(
  version: number | null | undefined,
): readonly string[] {
  const v = version ?? 1;
  if (v >= 3) return STANDARD_COLUMNS_V3;
  if (v === 2) return STANDARD_COLUMNS_V2;
  return STANDARD_COLUMNS_V1;
}

/**
 * Format a timestamp as India Standard Time for the "Submission Time"
 * cell, time first, e.g. "2:25 PM, 14 Jul 2026". Falls back to empty
 * string on a bad input. Pass nothing to stamp "now".
 */
export function formatSubmissionTimeIST(input?: string | Date | null): string {
  const d = input ? new Date(input) : new Date();
  if (isNaN(d.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  const date = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
  return `${time}, ${date}`;
}

/** Derive a sheet header from a collect_input prompt, falling back to the var_key. */
export function headerFromPrompt(prompt: string | null | undefined, fallbackKey: string): string {
  const clean = (prompt ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return fallbackKey;
  return clean.length > 100 ? `${clean.slice(0, 99)}…` : clean;
}

/** Pull the spreadsheet id out of a full Google Sheets URL (or accept a bare id). */
export function parseSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  const m = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  // Bare id (no slashes/spaces) — accept as-is.
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

interface SpreadsheetMeta {
  spreadsheetId: string;
  title: string;
  firstSheetTitle: string;
  url: string;
}

/** Read a spreadsheet's metadata — used to validate a pasted link and grab its first tab. */
export async function getSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
): Promise<SpreadsheetMeta> {
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Google Sheets read failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    spreadsheetId: string;
    spreadsheetUrl: string;
    properties: { title: string };
    sheets: Array<{ properties: { title: string } }>;
  };
  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title ?? "Untitled",
    firstSheetTitle: data.sheets?.[0]?.properties?.title ?? "Sheet1",
    url: data.spreadsheetUrl,
  };
}

/** Create a brand-new spreadsheet and return its id/url/first-tab. */
export async function createSpreadsheet(
  accessToken: string,
  title: string,
): Promise<SpreadsheetMeta> {
  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties: { title } }),
  });
  if (!res.ok) {
    throw new Error(`Google Sheets create failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    spreadsheetId: string;
    spreadsheetUrl: string;
    properties: { title: string };
    sheets: Array<{ properties: { title: string } }>;
  };
  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title ?? title,
    firstSheetTitle: data.sheets?.[0]?.properties?.title ?? "Sheet1",
    url: data.spreadsheetUrl,
  };
}

/**
 * Append a single row to `{tab}`, letting Sheets find the first empty
 * row (INSERT_ROWS). Never updates existing rows — every call adds one.
 */
export async function appendRow(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  values: (string | number)[],
): Promise<void> {
  await appendRows(accessToken, spreadsheetId, tab, [values]);
}

/**
 * Append many rows in a single request (used for backfilling historical
 * responses). Still INSERT_ROWS, so it only ever adds — never overwrites.
 */
export async function appendRows(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  rows: (string | number)[][],
): Promise<void> {
  if (rows.length === 0) return;
  const range = `${encodeURIComponent(tab)}!A1`;
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!res.ok) {
    throw new Error(`Google Sheets append failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * Write one data cell without touching any other cell — used to enrich
 * an already-synced row (e.g. Assign) located by its exact hidden Run ID.
 * Each call is `{colIndex 0-based, rowNumber 1-based, value}`.
 */
export async function updateDataCell(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  colIndex: number,
  rowNumber: number,
  value: string | number,
): Promise<void> {
  if (rowNumber < 2) {
    throw new Error('Refusing to update a sheet header row');
  }
  const letter = columnLetter(colIndex);
  const cellRange = `${encodeURIComponent(tab)}!${letter}${rowNumber}`;
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${cellRange}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [[value]] }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Google Sheets cell update failed (${res.status}): ${await res.text()}`,
    );
  }
}

/** 0-based column index → A1 letters (0 → A, 25 → Z, 26 → AA, …). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Write specific header-row cells without touching any other cell — used
 * to extend an already-written header with newly-discovered columns, or
 * to rename an existing one, in place. Each update is `{colIndex, value}`
 * (0-based column index).
 */
export async function updateHeaderCells(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  updates: Array<{ colIndex: number; value: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: updates.map((u) => ({
          range: `${encodeURIComponent(tab)}!${columnLetter(u.colIndex)}1`,
          values: [[u.value]],
        })),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Google Sheets header update failed (${res.status}): ${await res.text()}`,
    );
  }
}

async function getSheetId(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
): Promise<number> {
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(
      `Google Sheets tab lookup failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const sheetId = data.sheets?.find((sheet) => sheet.properties?.title === tab)
    ?.properties?.sheetId;
  if (typeof sheetId !== "number") {
    throw new Error(`Google Sheets tab not found: ${tab}`);
  }
  return sheetId;
}

/** Insert blank columns before a 0-based column index. */
export async function insertSheetColumns(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  startIndex: number,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const sheetId = await getSheetId(accessToken, spreadsheetId, tab);
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "COLUMNS",
              startIndex,
              endIndex: startIndex + count,
            },
            inheritFromBefore: false,
          },
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Google Sheets column insert failed (${res.status}): ${await res.text()}`,
    );
  }
}

/** Hide or show one 0-based sheet column. */
export async function setSheetColumnHidden(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  colIndex: number,
  hidden: boolean,
): Promise<void> {
  const sheetId = await getSheetId(accessToken, spreadsheetId, tab);
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: colIndex,
              endIndex: colIndex + 1,
            },
            properties: { hiddenByUser: hidden },
            fields: "hiddenByUser",
          },
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Google Sheets column visibility update failed (${res.status}): ${await res.text()}`,
    );
  }
}

/** Find a header's 0-based column index, or null when absent. */
export async function findHeaderColumn(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  header: string,
): Promise<number | null> {
  const range = `${encodeURIComponent(tab)}!1:1`;
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${range}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(
      `Google Sheets header read failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { values?: unknown[][] };
  const row = data.values?.[0] ?? [];
  const index = row.findIndex((value) => String(value) === header);
  return index >= 0 ? index : null;
}

/**
 * Read the live value of the header row's first cell (A1), or null when
 * the sheet has no header row. Used to pin layout decisions that must
 * match the on-sheet truth (e.g. whether a sheet was created with an
 * optional leading column) so later node edits can never change row
 * widths mid-life. Throws on API failure — callers treat that as fatal
 * for the sync (nothing is written before this read resolves).
 */
export async function readFirstHeaderCell(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
): Promise<string | null> {
  const range = `${encodeURIComponent(tab)}!A1:A1`;
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${range}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(
      `Google Sheets header read failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { values?: unknown[][] };
  const cell = data.values?.[0]?.[0];
  return cell === undefined || cell === null ? null : String(cell);
}

/** Find the 1-based row number containing an exact value in one column. */
export async function findExactValueRow(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  colIndex: number,
  value: string,
): Promise<number | null> {
  const rows = await findExactValueRows(
    accessToken,
    spreadsheetId,
    tab,
    colIndex,
    [value],
  );
  return rows.get(value) ?? null;
}

/** Find exact values in one column with a single Google read request. */
export async function findExactValueRows(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  colIndex: number,
  wantedValues: string[],
): Promise<Map<string, number>> {
  if (wantedValues.length === 0) return new Map();
  const letter = columnLetter(colIndex);
  const range = `${encodeURIComponent(tab)}!${letter}2:${letter}`;
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${range}?majorDimension=COLUMNS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(
      `Google Sheets column read failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { values?: unknown[][] };
  const values = data.values?.[0] ?? [];
  const wanted = new Set(wantedValues);
  const found = new Map<string, number>();
  values.forEach((cell, index) => {
    const value = String(cell);
    if (wanted.has(value) && !found.has(value)) found.set(value, index + 2);
  });
  return found;
}

/** Delete one 1-based row from a sheet. */
export async function deleteSheetRow(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  rowNumber: number,
): Promise<void> {
  await deleteSheetRows(accessToken, spreadsheetId, tab, [rowNumber]);
}

/** Delete multiple 1-based rows in one request, bottom-to-top. */
export async function deleteSheetRows(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  rowNumbers: number[],
): Promise<void> {
  if (rowNumbers.length === 0) return;
  if (rowNumbers.some((rowNumber) => rowNumber < 2)) {
    throw new Error("Refusing to delete a sheet header row");
  }
  const sheetId = await getSheetId(accessToken, spreadsheetId, tab);
  const descendingRows = [...new Set(rowNumbers)].sort((a, b) => b - a);
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: descendingRows.map((rowNumber) => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        })),
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Google Sheets row delete failed (${res.status}): ${await res.text()}`,
    );
  }
}
