import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteSheetRow,
  deleteSheetRows,
  findExactValueRow,
  findHeaderColumn,
  insertSheetColumns,
  setSheetColumnHidden,
} from "./sheets";

afterEach(() => {
  vi.restoreAllMocks();
});

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Google Sheets keyed-row helpers", () => {
  it("finds the hidden Flow Run ID header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okJson({ values: [["Name", "Flow Run ID"]] })),
    );

    await expect(
      findHeaderColumn("token", "sheet", "Sheet1", "Flow Run ID"),
    ).resolves.toBe(1);
  });

  it("maps an exact column value back to its 1-based sheet row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okJson({ values: [["run-a", "", "run-c"]] })),
    );

    await expect(
      findExactValueRow("token", "sheet", "Sheet1", 8, "run-c"),
    ).resolves.toBe(4);
  });

  it("deletes only the requested data row", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ sheets: [{ properties: { sheetId: 42, title: "Sheet1" } }] }),
      )
      .mockResolvedValueOnce(okJson({}));
    vi.stubGlobal("fetch", fetchMock);

    await deleteSheetRow("token", "sheet", "Sheet1", 7);

    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(request.requests[0].deleteDimension.range).toEqual({
      sheetId: 42,
      dimension: "ROWS",
      startIndex: 6,
      endIndex: 7,
    });
  });

  it("deletes multiple rows bottom-to-top so indexes cannot shift", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ sheets: [{ properties: { sheetId: 42, title: "Sheet1" } }] }),
      )
      .mockResolvedValueOnce(okJson({}));
    vi.stubGlobal("fetch", fetchMock);

    await deleteSheetRows("token", "sheet", "Sheet1", [3, 9, 5]);

    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(
      request.requests.map(
        (item: { deleteDimension: { range: { startIndex: number } } }) =>
          item.deleteDimension.range.startIndex,
      ),
    ).toEqual([8, 4, 2]);
  });

  it("inserts answer columns before the stable run-id column", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ sheets: [{ properties: { sheetId: 42, title: "Sheet1" } }] }),
      )
      .mockResolvedValueOnce(okJson({}));
    vi.stubGlobal("fetch", fetchMock);

    await insertSheetColumns("token", "sheet", "Sheet1", 8, 2);

    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(request.requests[0].insertDimension.range).toEqual({
      sheetId: 42,
      dimension: "COLUMNS",
      startIndex: 8,
      endIndex: 10,
    });
  });

  it("hides the stable run-id column", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ sheets: [{ properties: { sheetId: 42, title: "Sheet1" } }] }),
      )
      .mockResolvedValueOnce(okJson({}));
    vi.stubGlobal("fetch", fetchMock);

    await setSheetColumnHidden("token", "sheet", "Sheet1", 9, true);

    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(request.requests[0].updateDimensionProperties).toMatchObject({
      range: {
        sheetId: 42,
        dimension: "COLUMNS",
        startIndex: 9,
        endIndex: 10,
      },
      properties: { hiddenByUser: true },
    });
  });
});
