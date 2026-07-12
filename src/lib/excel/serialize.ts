import type { ExcelData } from "./build-excel-data";

/**
 * Machine-facing serializers for the flow-completions export endpoint.
 *
 * Values are emitted RAW (timestamps stay ISO-8601) so a downstream CRM
 * or spreadsheet can parse/sort them; the on-screen table does its own
 * human formatting. Column labels become the field names, so the output
 * is self-describing.
 */

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** RFC-4180 CSV. First row = column labels. */
export function excelToCsv(data: ExcelData): string {
  const header = data.columns.map((c) => csvEscape(c.label)).join(",");
  const body = data.rows
    .map((r) =>
      data.columns.map((c) => csvEscape(r.cells[c.key] ?? "")).join(","),
    )
    .join("\n");
  return body ? `${header}\n${body}` : header;
}

/** Array of label-keyed objects — the friendliest shape for a CRM importer. */
export function excelToJson(data: ExcelData): Record<string, string>[] {
  return data.rows.map((r) => {
    const obj: Record<string, string> = {};
    for (const c of data.columns) obj[c.label] = r.cells[c.key] ?? "";
    return obj;
  });
}
