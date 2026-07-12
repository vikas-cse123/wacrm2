import { describe, expect, it } from "vitest";

import { excelToCsv, excelToJson } from "./serialize";
import type { ExcelData } from "./build-excel-data";

const data: ExcelData = {
  columns: [
    { key: "phone", label: "Phone", kind: "meta" },
    { key: "q:f:n", label: "May I know your Full Name?", kind: "question" },
  ],
  rows: [
    { id: "r1", flow: "Singapore", cells: { phone: "919411547145", "q:f:n": 'Ravi "R" Gupta' } },
    { id: "r2", flow: "Singapore", cells: { phone: "919797995932", "q:f:n": "" } },
  ],
  flows: ["Singapore"],
};

describe("excelToCsv", () => {
  it("emits a header row + escaped values", () => {
    const csv = excelToCsv(data);
    const lines = csv.split("\n");
    expect(lines[0]).toBe('"Phone","May I know your Full Name?"');
    // Embedded quotes are doubled per RFC-4180.
    expect(lines[1]).toBe('"919411547145","Ravi ""R"" Gupta"');
    expect(lines[2]).toBe('"919797995932",""');
  });

  it("returns just the header when there are no rows", () => {
    expect(excelToCsv({ ...data, rows: [] })).toBe(
      '"Phone","May I know your Full Name?"',
    );
  });
});

describe("excelToJson", () => {
  it("maps each row to a label-keyed object", () => {
    expect(excelToJson(data)).toEqual([
      { Phone: "919411547145", "May I know your Full Name?": 'Ravi "R" Gupta' },
      { Phone: "919797995932", "May I know your Full Name?": "" },
    ]);
  });
});
