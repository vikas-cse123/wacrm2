'use client';

import { useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  HEADER_COLOR_PRESETS,
  headerTextColor,
  normalizeHeaderColor,
} from '@/lib/flows/header-colors';

/**
 * Header color swatches for one Workspace column (rendered inside
 * the Columns manager's color dialog — never inside header cells,
 * so the table header stays uncluttered).
 *
 *   Default swatch → the column's default pastel (reset)
 *   Preset grid    → curated light enterprise tints
 *   Custom input   → native color picker, any color (header text
 *                    auto-contrasts, so dark picks stay readable)
 *   Reset button   → back to the default
 *
 * Every pick calls onPick immediately (null = reset) so the
 * caller can persist + paint without a second confirmation step.
 */
export function HeaderColorSwatches({
  label,
  defaultHex,
  custom,
  takenColors,
  onPick,
}: {
  /** Column display label (for accessible names only). */
  label: string;
  /** This column's default pastel. */
  defaultHex: string;
  /** Stored override, or null when the default applies. */
  custom: string | null;
  /**
   * Effective colors already used by OTHER visible columns
   * (normalized hex). Picking one is blocked with an explicit
   * message — every column keeps its own color.
   */
  takenColors?: ReadonlyArray<string>;
  /** Immediate save; null resets to the default. */
  onPick: (color: string | null) => void;
}) {
  const [draftCustom, setDraftCustom] = useState(defaultHex);
  const [takenError, setTakenError] = useState<string | null>(null);
  const usingDefault = custom === null;
  const taken = new Set(
    (takenColors ?? []).map((c) => c.trim().toLowerCase()),
  );

  function attemptPick(raw: string) {
    let hex: string;
    try {
      hex = normalizeHeaderColor(raw);
    } catch {
      return;
    }
    if (taken.has(hex)) {
      setTakenError(
        "That color is already used by another column — choose a different one.",
      );
      return;
    }
    setTakenError(null);
    onPick(hex);
  }

  function pickCustom(value: string) {
    setDraftCustom(value);
    attemptPick(value);
  }

  function resetToDefault() {
    // Resetting never collides: defaults resolve uniquely.
    setTakenError(null);
    onPick(null);
  }

  return (
    <div className="grid gap-3">
      {takenError && (
        <p role="alert" className="text-destructive text-xs font-medium">
          {takenError}
        </p>
      )}
      <div>
        <p className="text-muted-foreground text-[11px] tracking-wide uppercase">
          Default
        </p>
        <button
          type="button"
          onClick={resetToDefault}
          aria-label={`Use default header color for ${label}`}
          aria-pressed={usingDefault}
          title="Default"
          className={cn(
            'mt-1.5 flex h-9 w-full items-center justify-between rounded-md border px-2.5 text-[13px] font-medium transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            usingDefault && 'ring-primary ring-2 ring-offset-1 ring-offset-transparent'
          )}
          style={{
            backgroundColor: defaultHex,
            color: headerTextColor(defaultHex),
          }}
        >
          Default
          {usingDefault && <Check className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>

      <div>
        <p className="text-muted-foreground text-[11px] tracking-wide uppercase">
          Presets
        </p>
        <div className="mt-1.5 grid grid-cols-6 gap-1.5" role="group" aria-label="Preset header colors">
          {HEADER_COLOR_PRESETS.map((hex) => {
            const selected = !usingDefault && custom === hex;
            const takenByOther = !selected && taken.has(hex);
            return (
              <button
                key={hex}
                type="button"
                onClick={() => attemptPick(hex)}
                aria-label={`Header color ${hex} for ${label}`}
                aria-pressed={selected}
                title={takenByOther ? `${hex} (already used)` : hex}
                className={cn(
                  'flex h-8 items-center justify-center rounded-md border border-border transition-transform hover:scale-105',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                  selected && 'ring-primary ring-2 ring-offset-1 ring-offset-transparent',
                  takenByOther && 'opacity-40'
                )}
                style={{ backgroundColor: hex, color: headerTextColor(hex) }}
              >
                {selected && <Check className="h-4 w-4" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`ws-color-custom-${label}`} className="text-muted-foreground text-[11px] tracking-wide uppercase">
          Custom
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id={`ws-color-custom-${label}`}
            type="color"
            value={custom ?? draftCustom}
            onChange={(e) => pickCustom(e.target.value)}
            aria-label={`Custom header color for ${label}`}
            className="h-9 w-14 shrink-0 cursor-pointer p-1"
          />
          <span className="text-muted-foreground font-mono text-xs">
            {(custom ?? draftCustom).toUpperCase()}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          Any color works — header text switches for readability automatically.
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={resetToDefault}
          disabled={usingDefault}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Reset to default
        </Button>
      </div>
    </div>
  );
}
