"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { CURRENCIES } from "@/lib/currency";
import {
  WORKSPACE_CURRENCY_DEFAULT,
  WORKSPACE_FIELD_NAME_MAX,
  WORKSPACE_FIELD_TYPE_LABELS,
  WORKSPACE_FIELD_TYPES,
  resolveWorkspaceCurrency,
  type WorkspaceField,
  type WorkspaceFieldType,
} from "@/lib/flows/workspace-fields";

/**
 * Searchable currency picker for Currency columns. Reuses the
 * app-wide CURRENCIES list (code/label/symbol) — no duplicated
 * currency data. Scoped to this dialog; deals/settings pickers
 * are untouched.
 */
function CurrencyPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = CURRENCIES.find((c) => c.code === value) ?? CURRENCIES[0];

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CURRENCIES;
    return CURRENCIES.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.symbol.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "border-border bg-card flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 text-sm",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        )}
        aria-label="Select currency"
      >
        <span className="truncate">
          {selected.flag} {selected.code} — {selected.label}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-1.5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search currencies…"
          aria-label="Search currencies"
          className="mb-1.5 h-8"
        />
        <div className="max-h-56 overflow-y-auto" role="listbox">
          {matches.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No currencies match “{query.trim()}”.
            </p>
          ) : (
            matches.map((c) => (
              <button
                key={c.code}
                type="button"
                role="option"
                aria-selected={c.code === value}
                onClick={() => {
                  onChange(c.code);
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                  c.code === value && "bg-muted",
                )}
              >
                <span className="shrink-0">{c.flag}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{c.code}</span>
                  <span className="text-muted-foreground"> — {c.label}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {c.symbol}
                </span>
                {c.code === value && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Add / edit a Workspace custom column. Edit mode reuses the same
 * form (type locked — changing types would orphan stored values).
 * On success the parent reloads definitions; nothing here touches
 * flow vars, Sheets, or history.
 */
export function AddColumnDialog({
  flowId,
  editing,
  open,
  onOpenChange,
  onSaved,
}: {
  flowId: string | null;
  /** Existing field for edit mode, null for create mode. */
  editing: WorkspaceField | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<WorkspaceFieldType>("text");
  const [currency, setCurrency] = useState<string>(WORKSPACE_CURRENCY_DEFAULT);
  const [options, setOptions] = useState<string[]>(["New"]);
  const [draftOption, setDraftOption] = useState("");
  const [useDefault, setUseDefault] = useState(false);
  const [defaultValue, setDefaultValue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setType(editing.field_type);
      setCurrency(
        editing.field_type === "currency"
          ? resolveWorkspaceCurrency(editing)
          : WORKSPACE_CURRENCY_DEFAULT,
      );
      setOptions(editing.options ?? []);
      setUseDefault(editing.default_value != null);
      setDefaultValue(editing.default_value ?? "");
    } else {
      setName("");
      setType("text");
      setCurrency(WORKSPACE_CURRENCY_DEFAULT);
      setOptions(["New"]);
      setUseDefault(false);
      setDefaultValue("");
    }
    setDraftOption("");
  }, [open, editing]);

  const isSelect = type === "single_select" || type === "multi_select";
  const isCurrency = type === "currency";
  const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
  const canSubmit =
    !saving &&
    flowId !== null &&
    name.trim().length > 0 &&
    (!isSelect || cleanOptions.length > 0);

  function addOption() {
    const trimmed = draftOption.trim();
    if (!trimmed) return;
    if (options.some((o) => o.trim().toLowerCase() === trimmed.toLowerCase())) {
      toast.error(`Option "${trimmed}" already exists.`);
      return;
    }
    setOptions((prev) => [...prev, trimmed]);
    setDraftOption("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !flowId) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = editing
        ? {
            name: name.trim(),
            options: isSelect ? cleanOptions : undefined,
            default_value: useDefault ? defaultValue.trim() || null : null,
            currency_code:
              editing.field_type === "currency" ? currency : undefined,
          }
        : {
            name: name.trim(),
            field_type: type,
            options: isSelect ? cleanOptions : undefined,
            default_value: useDefault ? defaultValue.trim() || null : undefined,
            currency_code: isCurrency ? currency : undefined,
          };
      const url = editing
        ? `/api/flows/${flowId}/workspace-fields/${editing.id}`
        : `/api/flows/${flowId}/workspace-fields`;
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save the column.");
      toast.success(editing ? "Column updated." : "Column added.");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the column.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit column" : "Add column"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Rename, options, currency, and default can change. The type is locked."
              : "Custom columns belong only to this flow's Workspace."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ws-col-name">Column name</Label>
            <Input
              id="ws-col-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Follow-up Date"
              maxLength={WORKSPACE_FIELD_NAME_MAX + 10}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ws-col-type">Type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as WorkspaceFieldType)}
              disabled={editing !== null}
            >
              <SelectTrigger id="ws-col-type" className="border-border bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKSPACE_FIELD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {WORKSPACE_FIELD_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isCurrency && (
            <div className="grid gap-2">
              <Label>Currency</Label>
              <CurrencyPicker value={currency} onChange={setCurrency} />
              <p className="text-xs text-muted-foreground">
                Every record in this column uses this currency. Values stay
                numeric — only the display changes.
              </p>
            </div>
          )}

          {isSelect && (
            <div className="grid gap-2">
              <Label>Options</Label>
              <div className="space-y-1.5">
                {options.map((opt, i) => (
                  <div key={`${i}-${opt}`} className="flex items-center gap-2">
                    <Input
                      value={opt}
                      onChange={(e) =>
                        setOptions((prev) =>
                          prev.map((o, j) => (j === i ? e.target.value : o)),
                        )
                      }
                      aria-label={`Option ${i + 1}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove option ${opt}`}
                      onClick={() =>
                        setOptions((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={draftOption}
                  onChange={(e) => setDraftOption(e.target.value)}
                  placeholder="New option"
                  aria-label="New option"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addOption();
                    }
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={addOption}>
                  <Plus className="h-4 w-4" />
                  Add option
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="ws-col-default-toggle">Default for new records</Label>
              <Switch
                id="ws-col-default-toggle"
                checked={useDefault}
                onCheckedChange={setUseDefault}
              />
            </div>
            {useDefault &&
              (isSelect ? (
                <Select value={defaultValue} onValueChange={(v) => { if (v !== null) setDefaultValue(v); }}>
                  <SelectTrigger className="border-border bg-card">
                    <SelectValue placeholder="Choose a default option" />
                  </SelectTrigger>
                  <SelectContent>
                    {cleanOptions.map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : type === "checkbox" ? (
                <Select value={defaultValue} onValueChange={(v) => { if (v !== null) setDefaultValue(v); }}>
                  <SelectTrigger className="border-border bg-card">
                    <SelectValue placeholder="Choose a default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Checked</SelectItem>
                    <SelectItem value="false">Unchecked</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={defaultValue}
                  onChange={(e) => setDefaultValue(e.target.value)}
                  placeholder="Default value (new records only)"
                />
              ))}
            <p className="text-xs text-muted-foreground">
              Defaults never rewrite existing records.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : editing ? (
                "Save changes"
              ) : (
                "Add column"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
