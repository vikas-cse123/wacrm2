// ============================================================
// Google Sheets REST helpers — create a spreadsheet, resolve a pasted
// URL, and append a row. Direct fetch calls against the Sheets/Drive v4
// APIs (no googleapis SDK). All calls take an already-valid access token
// from lib/google/oauth.
// ============================================================

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Standard leading columns present on every synced sheet, in order. */
export const STANDARD_COLUMNS = [
  "Name",
  "Phone Number",
  "Flow Name",
  "Submission Time",
  "User ID",
] as const;

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
  const range = `${encodeURIComponent(tab)}!A1`;
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [values] }),
    },
  );
  if (!res.ok) {
    throw new Error(`Google Sheets append failed (${res.status}): ${await res.text()}`);
  }
}
