// ============================================================
// Google Sheets REST helpers — create a spreadsheet, resolve a pasted
// URL, and append a row. Direct fetch calls against the Sheets/Drive v4
// APIs (no googleapis SDK). All calls take an already-valid access token
// from lib/google/oauth.
// ============================================================

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Standard leading columns present on every synced sheet, in order.
 * "Name" is the contact's name when available (blank otherwise). */
export const STANDARD_COLUMNS = [
  "Name",
  "Phone Number",
  "Flow Name",
  "Submission Time",
  "User ID",
] as const;

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
