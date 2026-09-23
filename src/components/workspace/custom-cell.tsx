"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { DEFAULT_CURRENCY, formatCurrency } from "@/lib/currency";
import {
  displayWorkspaceValue,
  parseMultiSelectValue,
  type WorkspaceField,
} from "@/lib/flows/workspace-fields";

function formatDisplay(field: WorkspaceField, stored: string | null): string {
  const shown = displayWorkspaceValue(field, stored);
  if (shown === null || shown === "") return "—";
  switch (field.field_type) {
    case "currency": {
      const n = Number(shown);
      if (!Number.isFinite(n)) return shown;
      try {
        return formatCurrency(n, DEFAULT_CURRENCY);
      } catch {
        return shown;
      }
    }
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(shown);
      if (!m) return shown;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime())
        ? shown
        : d.toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          });
    }
    case "datetime": {
      const t = Date.parse(shown);
      if (Number.isNaN(t)) return shown;
      return new Date(t).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    case "multi_select":
      return parseMultiSelectValue(shown).join(", ") || "—";
    case "checkbox":
      return shown === "true" ? "Yes" : "No";
    default:
      return shown;
  }
}

/**
 * One editable custom cell. Click to edit inline with a type-aware
 * editor; saves server-side on commit (blur/Enter/select). Flow
 * answers are never touched — only workspace_values rows.
 */
export function CustomCell({
  flowId,
  runId,
  field,
  stored,
  canEdit,
  onSaved,
}: {
  flowId: string;
  runId: string;
  field: WorkspaceField;
  stored: string | null | undefined;
  canEdit: boolean;
  onSaved: (fieldId: string, runId: string, value: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function save(raw: unknown) {
    setSaving(true);
    try {
      const res = await fetch(`/api/flows/${flowId}/workspace-values`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_id: field.id,
          flow_run_id: runId,
          value: raw,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        value?: string | null;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save the value.");
      onSaved(field.id, runId, json?.value ?? null);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the value.");
    } finally {
      setSaving(false);
    }
  }

  const shown = displayWorkspaceValue(field, stored ?? null);

  if (!canEdit) {
    if (field.field_type === "url" && shown) {
      return (
        <a
          href={shown}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {formatDisplay(field, stored ?? null)}
        </a>
      );
    }
    return <span>{formatDisplay(field, stored ?? null)}</span>;
  }

  // Checkbox + single-select commit immediately, no edit mode.
  if (field.field_type === "checkbox") {
    return (
      <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={shown === "true"}
          disabled={saving}
          onCheckedChange={(v) => save(v === true)}
          aria-label={`${field.name} value`}
        />
        {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </span>
    );
  }

  if (field.field_type === "single_select") {
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <Select
          value={shown ?? ""}
          disabled={saving}
          onValueChange={(v) => save(v === "__clear__" ? null : v)}
        >
          <SelectTrigger className="h-8 min-w-28 border-transparent bg-transparent px-1 text-[13px] hover:border-border data-[state=open]:border-border">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__clear__">
              <span className="text-muted-foreground">Clear</span>
            </SelectItem>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
    );
  }

  if (field.field_type === "multi_select") {
    const picked = parseMultiSelectValue(shown);
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "inline-flex h-8 max-w-44 items-center gap-1 rounded-md px-1 text-[13px] transition-colors",
              "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            )}
          >
            <span className="truncate">
              {picked.length > 0 ? picked.join(", ") : "—"}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {(field.options ?? []).map((o) => (
              <DropdownMenuCheckboxItem
                key={o}
                checked={picked.includes(o)}
                onCheckedChange={() => {
                  const next = picked.includes(o)
                    ? picked.filter((p) => p !== o)
                    : [...picked, o];
                  save(next);
                }}
                onSelect={(e) => e.preventDefault()}
              >
                {o}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    );
  }

  if (!editing) {
    const text = formatDisplay(field, stored ?? null);
    if (field.field_type === "url" && shown) {
      return (
        <span className="inline-flex items-center gap-1">
          <a
            href={shown}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {text}
          </a>
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setDraft(shown ?? "");
          setEditing(true);
        }}
        className="block max-w-44 truncate rounded px-1 py-0.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        title="Click to edit"
      >
        <span className={cn(text === "—" && "text-muted-foreground")}>{text}</span>
      </button>
    );
  }

  const inputType =
    field.field_type === "date"
      ? "date"
      : field.field_type === "datetime"
        ? "datetime-local"
        : field.field_type === "number" || field.field_type === "currency"
          ? "number"
          : "text";

  return (
    <span
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      <Input
        ref={inputRef}
        type={inputType}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!saving) save(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-8 w-36"
        aria-label={`${field.name} value`}
      />
      {saving ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Check className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      {field.field_type === "url" && shown && (
        <a
          href={shown}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open link"
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}
