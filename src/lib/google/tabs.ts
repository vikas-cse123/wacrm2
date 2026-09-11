// ============================================================
// Google Sheets worksheet/tab operations for All Sheets collections.
//
// All Sheets owns exactly ONE spreadsheet per (account, kind), with one
// worksheet/tab per flow inside it. These helpers manage tabs inside an
// EXISTING spreadsheet: resolve, create, rename, delete, list.
//
// Tab identity is ALWAYS the numeric Google sheetId (`worksheet_id`).
// Tab titles are display metadata only — flow names can contain spaces,
// plus signs, unicode, and punctuation, and can be renamed later.
//
// This module intentionally duplicates the two-line Sheets API base URL
// instead of importing it from `@/lib/google/sheets`, so that file (and
// oauth.ts) remain byte-identical and the existing Google Sheets feature
// cannot be affected by this addition. Same raw-fetch style, no SDK.
// ============================================================

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

export interface WorksheetTab {
  /** Stable numeric Google sheetId — the ONLY safe tab identity. */
  worksheetId: number;
  /** Display title. May change; never use as identity. */
  title: string;
  /** 0-based position among tabs. Display ordering only. */
  index: number;
}

/**
 * Quote a worksheet title for A1 notation: `'O''Brien'`.
 * Required because flow-derived titles can contain spaces, `+`,
 * unicode, and punctuation.
 */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Build a tab-scoped A1 range, e.g. `'My Flow'!A1` or `'My Flow'!A2:A`. */
export function tabRange(title: string, a1: string): string {
  return `${quoteSheetTitle(title)}!${a1}`;
}

/** Sanitize a flow name into a worksheet title (max 100 chars per Google). */
export function sanitizeWorksheetTitle(name: string, fallback: string): string {
  const clean = (name ?? "").replace(/\s+/g, " ").trim();
  const base = clean || fallback;
  return base.length > 100 ? `${base.slice(0, 99)}…` : base;
}

async function throwOnError(res: Response, context: string): Promise<never> {
  const err = new Error(`${context} (${res.status}): ${await res.text()}`) as Error & {
    status?: number;
  };
  err.status = res.status;
  throw err;
}

/** True only for Google 404s (file/tab genuinely gone in Drive). */
export function isGoogleNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: unknown }).status === 404
  );
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** List all worksheet tabs in a spreadsheet, in tab order. */
export async function listWorksheetTabs(
  accessToken: string,
  spreadsheetId: string,
): Promise<WorksheetTab[]> {
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.index`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) await throwOnError(res, "Google Sheets tab list failed");
  const data = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string; index?: number } }>;
  };
  return (data.sheets ?? []).map((s, i) => ({
    worksheetId: s.properties?.sheetId ?? -1,
    title: s.properties?.title ?? `Sheet${i + 1}`,
    index: s.properties?.index ?? i,
  }));
}

/** Rename a worksheet tab by its stable sheetId. */
export async function renameWorksheetTab(
  accessToken: string,
  spreadsheetId: string,
  worksheetId: number,
  newTitle: string,
): Promise<void> {
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: worksheetId, title: newTitle },
            fields: "title",
          },
        },
      ],
    }),
  });
  if (!res.ok) await throwOnError(res, "Google Sheets tab rename failed");
}

/** Create a new worksheet tab; returns its stable sheetId. */
export async function addWorksheetTab(
  accessToken: string,
  spreadsheetId: string,
  title: string,
): Promise<number> {
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  if (!res.ok) await throwOnError(res, "Google Sheets tab create failed");
  const data = (await res.json()) as {
    replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
  };
  const sheetId = data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (typeof sheetId !== "number") {
    throw new Error("Google Sheets tab create returned no sheetId");
  }
  return sheetId;
}

export interface EnsuredTab {
  worksheetId: number;
  title: string;
  /** True when a new tab was created (or Sheet1 renamed) for this call. */
  created: boolean;
}

/**
 * Resolve the worksheet for a flow inside a collection spreadsheet:
 *   1. Stored `worksheetId` still present → reuse (title drift tolerated;
 *      the caller persists any rename it observes).
 *   2. A tab already carries the desired title → adopt its sheetId.
 *   3. The spreadsheet holds exactly one untouched default `Sheet1` tab
 *      and the caller allows it → rename it to the desired title instead
 *      of leaving a stray empty tab.
 *   4. Otherwise → `addSheet` a fresh tab.
 *
 * Never creates a spreadsheet — only tabs. Never touches other tabs.
 */
export async function ensureWorksheetTab(
  accessToken: string,
  spreadsheetId: string,
  desiredTitle: string,
  opts?: { storedWorksheetId?: number | null; renameDefaultSheet?: boolean },
): Promise<EnsuredTab> {
  const tabs = await listWorksheetTabs(accessToken, spreadsheetId);

  if (opts?.storedWorksheetId != null) {
    const live = tabs.find((t) => t.worksheetId === opts.storedWorksheetId);
    if (live) return { worksheetId: live.worksheetId, title: live.title, created: false };
    // Stored id is gone (tab deleted in Drive) — fall through and recreate.
  }

  const byTitle = tabs.find((t) => t.title === desiredTitle);
  if (byTitle) return { worksheetId: byTitle.worksheetId, title: byTitle.title, created: false };

  if (
    opts?.renameDefaultSheet &&
    tabs.length === 1 &&
    tabs[0]?.title === "Sheet1" &&
    typeof tabs[0]?.worksheetId === "number"
  ) {
    await renameWorksheetTab(accessToken, spreadsheetId, tabs[0].worksheetId, desiredTitle);
    return { worksheetId: tabs[0].worksheetId, title: desiredTitle, created: true };
  }

  const worksheetId = await addWorksheetTab(accessToken, spreadsheetId, desiredTitle);
  return { worksheetId, title: desiredTitle, created: true };
}

/**
 * Delete one worksheet tab by its stable sheetId. Refuses to delete the
 * last remaining tab (Google forbids a spreadsheet with zero worksheets) —
 * callers surface this as "unlink instead" rather than failing silently.
 * Never deletes the spreadsheet itself.
 */export async function deleteWorksheetTab(
  accessToken: string,
  spreadsheetId: string,
  worksheetId: number,
): Promise<void> {
  const tabs = await listWorksheetTabs(accessToken, spreadsheetId);
  if (tabs.length <= 1 && tabs.some((t) => t.worksheetId === worksheetId)) {
    throw new Error(
      "Refusing to delete the last worksheet of a collection spreadsheet — unlink the tab instead.",
    );
  }
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: worksheetId } }] }),
  });
  if (!res.ok) await throwOnError(res, "Google Sheets tab delete failed");
}

/**
 * Write specific header-row cells of one tab without touching any other
 * cell — the tab-scoped equivalent of `updateHeaderCells`, but with the
 * range built correctly for flow-derived titles.
 *
 * CRITICAL DIFFERENCE: the range goes into the JSON request BODY
 * (`values:batchUpdate`), which Google parses as literal A1 notation —
 * bodies are never URL-decoded. So the range MUST be the literal quoted
 * title (`'From Kashmir Diwali Ad Chat Flow'!K1`) and MUST NOT pass
 * through encodeURIComponent (that produces the literal, unparseable
 * `'From%20Kashmir%20...%20Flow'!K1` → 400 "Unable to parse range").
 *
 * Takes the RAW title and quotes it internally. Callers must not pre-quote.
 */
export async function updateTabHeaderCells(
  accessToken: string,
  spreadsheetId: string,
  rawTitle: string,
  updates: Array<{ colIndex: number; value: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: updates.map((u) => ({
        range: `${quoteSheetTitle(rawTitle)}!${columnLetter(u.colIndex)}1`,
        values: [[u.value]],
      })),
    }),
  });
  if (!res.ok) await throwOnError(res, "Google Sheets tab header update failed");
}

/**
 * Permanently delete a spreadsheet file from Google Drive.
 *
 * Allowed under the `drive.file` scope for spreadsheets this app created.
 * Used ONLY when the final flow tab of an All Sheets collection is
 * removed: zero tabs = no spreadsheet. Never called for sibling tabs,
 * never called on existing-Google-Sheets spreadsheets.
 */
export async function deleteSpreadsheet(accessToken: string, spreadsheetId: string): Promise<void> {
  const res = await fetch(`${DRIVE_API}/${encodeURIComponent(spreadsheetId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await throwOnError(res, "Google Drive spreadsheet delete failed");
}
