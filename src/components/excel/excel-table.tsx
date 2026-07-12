"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Search, Download } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ExcelColumn, ExcelData, ExcelRow } from "@/lib/excel/build-excel-data";

/**
 * Excel-like grid for the flow-completions page.
 *
 * Deliberately data-driven off {columns, rows} so future features slot in
 * without touching the row rendering:
 *   • search  — implemented below (client-side, all cells).
 *   • sorting — add a click handler on <th> that sorts `rows` by a key.
 *   • filtering — add per-column predicates over `rows`.
 *   • export — CSV implemented; XLSX would swap the serializer only.
 */

function formatCell(col: ExcelColumn, value: string): string {
  if (!value) return "";
  if (col.format === "datetime") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return format(d, "d MMM yyyy, HH:mm");
  }
  return value;
}

function toCsv(columns: ExcelColumn[], rows: ExcelRow[]): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = columns.map((c) => esc(c.label)).join(",");
  const body = rows
    .map((r) =>
      columns.map((c) => esc(formatCell(c, r.cells[c.key] ?? ""))).join(","),
    )
    .join("\n");
  return `${header}\n${body}`;
}

export function ExcelTable({ data }: { data: ExcelData }) {
  const { columns, rows } = data;
  const [query, setQuery] = useState("");

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      columns.some((c) =>
        formatCell(c, r.cells[c.key] ?? "")
          .toLowerCase()
          .includes(q),
      ),
    );
  }, [rows, columns, query]);

  const handleExport = () => {
    const csv = toCsv(columns, filteredRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flow-completions.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      {/* Toolbar — search + export. Sorting/column filters slot in here. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all columns…"
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {filteredRows.length} {filteredRows.length === 1 ? "row" : "rows"}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={handleExport}
            disabled={filteredRows.length === 0}
          >
            <Download className="size-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Grid. Horizontal scroll lives inside this container so the page
          body never scrolls sideways. */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted/60">
              {columns.map((col, i) => (
                <th
                  key={col.key}
                  className={cn(
                    "whitespace-nowrap border-b border-border px-3 py-2 text-left font-semibold text-foreground",
                    // Freeze the first column (Name) so it stays visible
                    // while scrolling the wide question columns.
                    i === 0 &&
                      "sticky left-0 z-10 bg-muted/60",
                    col.kind === "question" && "max-w-[16rem] font-medium",
                  )}
                  title={col.label}
                >
                  <span className={cn(col.kind === "question" && "line-clamp-2 block")}>
                    {col.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  {rows.length === 0
                    ? "No one has completed a tracked flow yet."
                    : "No rows match your search."}
                </td>
              </tr>
            ) : (
              filteredRows.map((row, ri) => (
                <tr
                  key={row.id}
                  className={cn(
                    "transition-colors hover:bg-muted/40",
                    ri % 2 === 1 && "bg-muted/20",
                  )}
                >
                  {columns.map((col, ci) => {
                    const value = formatCell(col, row.cells[col.key] ?? "");
                    return (
                      <td
                        key={col.key}
                        className={cn(
                          "whitespace-nowrap border-b border-border px-3 py-2 text-foreground",
                          ci === 0 &&
                            "sticky left-0 z-10 bg-background font-medium",
                          col.kind === "question" &&
                            "max-w-[16rem] truncate text-muted-foreground",
                        )}
                        title={value}
                      >
                        {value || <span className="text-muted-foreground/40">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
