"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
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

// Module-level cache, strictly keyed by account_id: entries (and
// in-flight fetches) for one account are never served to another.
// Without the key, an account switch or logout→login without a full
// page reload could surface Account A's tag UUIDs inside Account B's
// editor — and those UUIDs could then be saved into B's flows.
// Entries live 60s — short enough that a tag created in Settings
// shows up promptly.
interface TagCacheEntry {
  tags: TagOption[];
  at: number;
}
const tagCache = new Map<string, TagCacheEntry>();
const tagInflight = new Map<string, Promise<TagOption[]>>();
const CACHE_TTL_MS = 60_000;

/** Read a fresh cache entry for this account, or null. Testable. */
export function readTagCache(accountId: string, now: number = Date.now()): TagOption[] | null {
  const entry = tagCache.get(accountId);
  if (!entry) return null;
  if (now - entry.at >= CACHE_TTL_MS) {
    tagCache.delete(accountId);
    return null;
  }
  return entry.tags;
}

/** Store this account's tags. Testable. */
export function writeTagCache(
  accountId: string,
  tags: TagOption[],
  now: number = Date.now(),
): void {
  tagCache.set(accountId, { tags, at: now });
}

/** Drop one account's entry, or everything when omitted (logout). */
export function clearTagCache(accountId?: string): void {
  if (accountId === undefined) {
    tagCache.clear();
    tagInflight.clear();
    return;
  }
  tagCache.delete(accountId);
  tagInflight.delete(accountId);
}

/** Test hook — resets the module cache between unit tests. */
export function __resetTagCacheForTests() {
  clearTagCache();
}

export function useAccountTags(): { tags: TagOption[]; loading: boolean } {
  // The account comes from auth context (same RLS identity as the
  // query itself). It doubles as the cache key: switching accounts
  // (or logging out) can never serve another account's tags.
  const { account } = useAuth();
  const accountId = account?.id ?? null;

  const [state, setState] = useState<{ tags: TagOption[]; loading: boolean }>({
    tags: [],
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!accountId) {
        // Logged out / still resolving: show nothing, never another
        // account's leftovers.
        if (!cancelled) setState({ tags: [], loading: false });
        return;
      }
      const cached = readTagCache(accountId);
      if (cached) {
        if (!cancelled) setState({ tags: cached, loading: false });
        return;
      }
      if (!cancelled) setState({ tags: [], loading: true });
      let inflight = tagInflight.get(accountId);
      if (!inflight) {
        inflight = fetchAccountTags(createClient()).finally(() => {
          if (tagInflight.get(accountId) === inflight) {
            tagInflight.delete(accountId);
          }
        });
        tagInflight.set(accountId, inflight);
      }
      const fresh = await inflight;
      if (cancelled) return;
      writeTagCache(accountId, fresh);
      setState({ tags: fresh, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return state;
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
