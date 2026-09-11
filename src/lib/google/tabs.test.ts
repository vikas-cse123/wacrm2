// google/tabs.ts regression tests: A1 quoting vs HTTP transport.
//
// The production bug: an A1 range reached Google as
//   'From%20Kashmir%20Diwali%20Ad%20Chat%20Flow'!K1
// (400 "Unable to parse range") because a URL-encoded title was embedded
// in a JSON request body, which Google parses as literal A1 (bodies are
// never URL-decoded). The rule under test:
//   - logical A1 ranges keep real titles: 'From Kashmir Diwali Ad Chat Flow'!K1
//   - single quotes inside titles are doubled per A1 notation.
//   - URL-encoding happens only at the HTTP transport layer, never inside
//     the logical range.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteWorksheetTab,
  ensureWorksheetTab,
  quoteSheetTitle,
  sanitizeWorksheetTitle,
  tabRange,
  updateTabHeaderCells,
} from "@/lib/google/tabs";

interface CapturedRequest {
  url: string;
  body: unknown;
}

function stubFetch(handler: (url: string, init?: { method?: string; body?: string }) => unknown): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: { method?: string; body?: string }) => {
    captured.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined });
    return Promise.resolve(handler(String(input), init));
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(payload),
  text: () => Promise.resolve(JSON.stringify(payload)),
});

describe("quoteSheetTitle", () => {
  it("keeps the reported flow title verbatim inside quotes (no %20)", () => {
    expect(quoteSheetTitle("From Kashmir Diwali Ad Chat Flow")).toBe(
      "'From Kashmir Diwali Ad Chat Flow'",
    );
  });

  it("keeps plus signs literal", () => {
    expect(quoteSheetTitle("Kashmir + Katra")).toBe("'Kashmir + Katra'");
  });

  it("doubles embedded apostrophes per A1 notation", () => {
    expect(quoteSheetTitle("Asha's Flow")).toBe("'Asha''s Flow'");
  });

  it("preserves unicode and punctuation", () => {
    expect(quoteSheetTitle("Kashmir ❄ Winter (2026) — New Year!")).toBe(
      "'Kashmir ❄ Winter (2026) — New Year!'",
    );
  });
});

describe("tabRange", () => {
  it("builds the exact reported range", () => {
    expect(tabRange("From Kashmir Diwali Ad Chat Flow", "K1")).toBe(
      "'From Kashmir Diwali Ad Chat Flow'!K1",
    );
    expect(tabRange("From Kashmir Diwali Ad Chat Flow", "K1")).not.toContain("%20");
  });
});

describe("sanitizeWorksheetTitle", () => {
  it("collapses whitespace, caps at 100 chars, falls back when empty", () => {
    expect(sanitizeWorksheetTitle("  Kashmir   Winter  ", "fb")).toBe("Kashmir Winter");
    expect(sanitizeWorksheetTitle("", "fb")).toBe("fb");
    expect(sanitizeWorksheetTitle("x".repeat(200), "fb")).toHaveLength(100);
  });
});

describe("updateTabHeaderCells transport", () => {
  it("sends the literal A1 range in the JSON body (the reported 400 case)", async () => {
    const captured = stubFetch(() => ok({}));
    await updateTabHeaderCells("tok", "SS1", "From Kashmir Diwali Ad Chat Flow", [
      { colIndex: 10, value: "Guests" },
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/SS1/values:batchUpdate");
    const data = (captured[0]?.body as { data: Array<{ range: string }> }).data;
    expect(data[0]?.range).toBe("'From Kashmir Diwali Ad Chat Flow'!K1");
    expect(JSON.stringify(captured[0]?.body)).not.toContain("%20");
  });

  it("doubles apostrophes in body ranges", async () => {
    const captured = stubFetch(() => ok({}));
    await updateTabHeaderCells("tok", "SS1", "Asha's Flow", [{ colIndex: 0, value: "Name" }]);
    const data = (captured[0]?.body as { data: Array<{ range: string }> }).data;
    expect(data[0]?.range).toBe("'Asha''s Flow'!A1");
  });

  it("is a no-op with no updates (no request sent)", async () => {
    const captured = stubFetch(() => ok({}));
    await updateTabHeaderCells("tok", "SS1", "Anything", []);
    expect(captured).toHaveLength(0);
  });
});

describe("ensureWorksheetTab", () => {
  const listTabs = (tabs: Array<{ sheetId: number; title: string }>) =>
    stubFetch((url) => {
      if (url.includes("?fields=")) {
        return ok({ sheets: tabs.map((t, i) => ({ properties: { sheetId: t.sheetId, title: t.title, index: i } })) });
      }
      if (url.endsWith(":batchUpdate")) {
        return ok({ replies: [{ addSheet: { properties: { sheetId: 777 } } }] });
      }
      throw new Error(`unexpected ${url}`);
    });

  it("reuses the stored worksheet id when still present", async () => {
    listTabs([{ sheetId: 111, title: "Old Name" }]);
    const res = await ensureWorksheetTab("tok", "SS1", "New Name", { storedWorksheetId: 111 });
    expect(res).toEqual({ worksheetId: 111, title: "Old Name", created: false });
  });

  it("adopts a same-titled tab when the stored id is gone", async () => {
    listTabs([{ sheetId: 222, title: "Wanted" }]);
    const res = await ensureWorksheetTab("tok", "SS1", "Wanted", { storedWorksheetId: 999 });
    expect(res).toEqual({ worksheetId: 222, title: "Wanted", created: false });
  });

  it("renames a lone default Sheet1 instead of leaving a stray tab", async () => {
    const captured = listTabs([{ sheetId: 0, title: "Sheet1" }]);
    const res = await ensureWorksheetTab("tok", "SS1", "First Flow", {
      storedWorksheetId: null,
      renameDefaultSheet: true,
    });
    expect(res).toEqual({ worksheetId: 0, title: "First Flow", created: true });
    const renameCall = captured.find((c) => c.url.endsWith(":batchUpdate"));
    expect(JSON.stringify(renameCall?.body)).toContain("First Flow");
  });
});

describe("deleteWorksheetTab", () => {
  it("refuses to delete the last remaining tab", async () => {
    stubFetch((url) => {
      if (url.includes("?fields=")) {
        return ok({ sheets: [{ properties: { sheetId: 5, title: "Only" } }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    await expect(deleteWorksheetTab("tok", "SS1", 5)).rejects.toThrow(/last worksheet/);
  });
});
