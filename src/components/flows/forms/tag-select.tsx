"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface TagOption {
  id: string;
  name: string;
  color?: string;
}

// ------------------------------------------------------------
// Pure helpers (unit-tested in tag-select.test.ts).
// ------------------------------------------------------------

/** Case-insensitive substring match on the tag name. */
export function filterTagsByQuery(
  tags: TagOption[],
  query: string,
): TagOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return tags;
  return tags.filter((t) => t.name.toLowerCase().includes(q));
}

export type TagSelection =
  | { status: "unselected" }
  | { status: "selected"; tag: TagOption }
  | { status: "missing"; tagId: string };

/**
 * Resolve a stored tag UUID against the account's tags. Never rewrites
 * the stored value: a UUID with no matching tag reports "missing" so
 * the UI can say so while the UUID stays intact in the flow JSON.
 */
export function resolveTagSelection(
  tags: TagOption[],
  tagId: string | undefined | null,
): TagSelection {
  if (!tagId) return { status: "unselected" };
  const tag = tags.find((t) => t.id === tagId);
  if (!tag) return { status: "missing", tagId };
  return { status: "selected", tag };
}

// ------------------------------------------------------------
// Data loading. RLS scopes every query to the caller's account, so
// we never pass account_id explicitly — same pattern as the Inbox
// tag filter (conversation-list.tsx).
// ------------------------------------------------------------

type TagsQueryResult = { id: string; name: string; color?: string }[] | null;

/** Fetch + normalize the account's tags. Exported for unit tests. */
export async function fetchAccountTags(
  client: Pick<SupabaseClient, "from">,
): Promise<TagOption[]> {
  try {
    const { data, error } = await client
      .from("tags")
      .select("id, name, color")
      .order("name");
    if (error || !data) return [];
    return (data as TagsQueryResult ?? [])
      .filter(
        (t): t is { id: string; name: string; color?: string } =>
          !!t && typeof t.id === "string" && typeof t.name === "string",
      )
      .map((t) => ({ id: t.id, name: t.name, color: t.color }));
  } catch {
    return [];
  }
}

// Module-level cache: the builder mounts one editor per selected node,
// so without this every node click refires the tags query. Entries live
// 60s — short enough that a tag created in Settings shows up promptly.
let cachedTags: TagOption[] | null = null;
let cachedAt = 0;
let inflight: Promise<TagOption[]> | null = null;
const CACHE_TTL_MS = 60_000;

/** Test hook — resets the module cache between unit tests. */
export function __resetTagCacheForTests() {
  cachedTags = null;
  cachedAt = 0;
  inflight = null;
}

export function useAccountTags(): { tags: TagOption[]; loading: boolean } {
  // Snapshot the module cache once on mount (lazy initializer — the
  // sanctioned place for a one-time impure read). The effect below
  // only fetches when the snapshot is stale; all state updates land
  // in async callbacks, never synchronously in the effect.
  const [snapshot] = useState(() => ({
    tags: cachedTags ?? [],
    fresh: cachedTags != null && Date.now() - cachedAt < CACHE_TTL_MS,
  }));
  const [tags, setTags] = useState<TagOption[]>(snapshot.tags);
  const [loading, setLoading] = useState<boolean>(!snapshot.fresh);

  useEffect(() => {
    if (snapshot.fresh) return;
    let cancelled = false;
    if (!inflight) {
      inflight = fetchAccountTags(createClient()).finally(() => {
        inflight = null;
      });
    }
    inflight
      .then((fresh) => {
        if (cancelled) return;
        cachedTags = fresh;
        cachedAt = Date.now();
        setTags(fresh);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `snapshot` is mount-only by construction; re-running on it
    // would refetch identically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { tags, loading };
}

// ------------------------------------------------------------
// Searchable tag dropdown. Displays names, stores UUIDs.
// ------------------------------------------------------------

export function TagSelect({
  value,
  onChange,
  tags,
  loading,
  placeholder = "Select a tag",
}: {
  /** Stored Tag UUID ("" = none). Passed through untouched. */
  value: string;
  /** Receives the selected Tag UUID ("" on clear). */
  onChange: (tagId: string) => void;
  tags: TagOption[];
  loading: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selection = resolveTagSelection(tags, value);
  const visible = useMemo(() => filterTagsByQuery(tags, query), [tags, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={selection.status === "selected" ? `Tag: ${selection.tag.name}` : "Select a tag"}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-muted px-3 text-sm text-foreground outline-none transition-colors hover:bg-muted/70 focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
        disabled={loading}
      >
        {loading ? (
          <span className="flex-1 truncate text-left text-muted-foreground">
            Loading tags…
          </span>
        ) : selection.status === "selected" ? (
          <>
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: selection.tag.color ?? "var(--muted-foreground)" }}
            />
            <span className="flex-1 truncate text-left">{selection.tag.name}</span>
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear selected tag"
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange("");
                }
              }}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          </>
        ) : selection.status === "missing" ? (
          <span className="flex-1 truncate text-left text-muted-foreground">
            Tag no longer exists
          </span>
        ) : (
          <span className="flex-1 truncate text-left text-muted-foreground">
            {tags.length === 0 ? "No tags found" : placeholder}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <div className="relative mb-1">
          <Search className="absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tags..."
            aria-label="Search tags"
            className="h-8 bg-muted pr-2 pl-7 text-sm"
          />
        </div>
        {/* Native scroll viewport for the tag list only: a plain div
            whose max-height actually constrains the box (unlike the
            previous ScrollArea, whose h-full Viewport resolved to
            content height against the auto-height Root and therefore
            never overflowed). The search input above stays pinned;
            overscroll-contain keeps wheel scrolling from hijacking
            the node panel behind the dropdown. */}
        <div className="max-h-[min(14rem,calc(100dvh-16rem))] overflow-y-auto overscroll-contain">
          {visible.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No tags found
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {visible.map((t) => {
                const active = t.id === value;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      onChange(t.id);
                      setQuery("");
                      setOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                      active ? "text-primary" : "text-popover-foreground",
                    )}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: t.color ?? "var(--muted-foreground)" }}
                    />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
