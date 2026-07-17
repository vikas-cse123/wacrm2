"use client";

import { useState } from "react";
import { CalendarDays, Loader2 } from "lucide-react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  IMPORT_PRESETS,
  importPresetToWindow,
  type ImportPreset,
} from "@/lib/flows/import-date-range";

/**
 * A trigger button that opens a popover of date-range presets (+ a
 * custom calendar range), then hands the resolved `{from, to}` window to
 * `onConfirm`. Shared by the flow Google Sheets node and the Data Export
 * page so every "import into sheet" action offers the same filter.
 *
 * `onConfirm` should do the fetch and resolve/throw; the popover shows a
 * spinner while it's pending and closes on success. Keep the parent's
 * own busy state in `disabled` to block the trigger during other work.
 */
export function ImportDateRangePopover({
  triggerLabel,
  heading = "Which responses to import?",
  confirmLabel = "Import",
  onConfirm,
  disabled,
  busy,
  triggerClassName,
  triggerVariant = "outline",
  triggerSize = "sm",
}: {
  triggerLabel: string;
  heading?: string;
  confirmLabel?: string;
  onConfirm: (window: { from?: string; to?: string }) => Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  triggerClassName?: string;
  triggerVariant?: React.ComponentProps<typeof Button>["variant"];
  triggerSize?: React.ComponentProps<typeof Button>["size"];
}) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<ImportPreset>("all");
  const [range, setRange] = useState<DateRange | undefined>();
  const [pending, setPending] = useState(false);

  const running = pending || busy;

  async function handleConfirm() {
    const window_ = importPresetToWindow(preset, range);
    if (!window_) return;
    setPending(true);
    try {
      await onConfirm(window_);
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={triggerVariant}
            size={triggerSize}
            className={triggerClassName}
            disabled={disabled || running}
          />
        }
      >
        {running ? (
          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
        ) : (
          <CalendarDays className="mr-1.5 size-3.5" />
        )}
        {triggerLabel}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        <p className="text-xs font-medium text-foreground">{heading}</p>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {IMPORT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] transition-colors",
                preset === p.id
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted/60",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="mt-2 rounded-md border border-border">
            <Calendar
              mode="range"
              selected={range}
              onSelect={setRange}
              numberOfMonths={1}
              disabled={{ after: new Date() }}
              autoFocus
            />
            <p className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
              {range?.from
                ? `${format(range.from, "d MMM yyyy")} — ${format(range.to ?? range.from, "d MMM yyyy")}`
                : "Pick a start and end date"}
            </p>
          </div>
        )}
        <p className="mt-2 max-w-[15rem] text-[11px] text-muted-foreground">
          Appends rows — importing the same range twice adds the rows again.
        </p>
        <Button
          size="sm"
          className="mt-2 h-7 w-full text-xs"
          onClick={handleConfirm}
          disabled={running || (preset === "custom" && !range?.from)}
        >
          {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          {confirmLabel}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
