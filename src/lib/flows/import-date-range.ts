// Shared date-range presets for the "import responses into a sheet"
// actions (flow Google Sheets node, Data Export completed + incomplete
// tabs). Keeps the preset list and the preset → API window mapping in
// one place so every surface offers the same choices.

import { addDays, startOfDay, subDays } from "date-fns";
import type { DateRange } from "react-day-picker";

/** Range presets. "all" = no bound; "custom" = use the calendar range. */
export type ImportPreset = "1d" | "2d" | "3d" | "7d" | "all" | "custom";

export const IMPORT_PRESETS: Array<{ id: ImportPreset; label: string }> = [
  { id: "1d", label: "Last 1 day" },
  { id: "2d", label: "Last 2 days" },
  { id: "3d", label: "Last 3 days" },
  { id: "7d", label: "Last 7 days" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom range" },
];

/**
 * Resolve a preset (+ optional calendar range) to the `{from, to}` ISO
 * window the backfill/import routes expect. `from` is inclusive, `to`
 * exclusive. Returns null when "custom" is picked without a start date
 * (caller should keep the action disabled until then).
 *
 * `now` is injectable for testing; defaults to the current time.
 */
export function importPresetToWindow(
  preset: ImportPreset,
  range: DateRange | undefined,
  now: Date = new Date(),
): { from?: string; to?: string } | null {
  const days: Record<string, number> = { "1d": 1, "2d": 2, "3d": 3, "7d": 7 };
  if (preset in days) return { from: subDays(now, days[preset]).toISOString() };
  if (preset === "all") return {};
  if (!range?.from) return null;
  const from = startOfDay(range.from);
  const to = addDays(startOfDay(range.to ?? range.from), 1);
  return { from: from.toISOString(), to: to.toISOString() };
}
