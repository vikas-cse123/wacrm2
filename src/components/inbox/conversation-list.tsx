"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import {
  addPin,
  canPinMore,
  isConversationPinned,
  partitionPinnedConversations,
  pinnedAtMapFromRecords,
  removePin,
} from "@/lib/inbox/pins";
import { cn } from "@/lib/utils";
import type { AccountMember, Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, Users, X, Pin, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

type InboxFilter = ConversationStatus | "all" | "unread";

const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = [
  { label: "All", value: "all" },
  { label: "Unread", value: "unread" },
  { label: "Open", value: "open" },
  { label: "Pending", value: "pending" },
  { label: "Closed", value: "closed" },
];

const PIN_LIMIT_TITLE = "Pin limit reached";
const PIN_LIMIT_DESCRIPTION =
  "You can pin up to 30 chats at a time. Unpin an existing chat before pinning another one.";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  // Pinned chats (migration 054). Per-user, held as a
  // conversation_id -> pinned_at map. `pinBusyIds` tracks in-flight
  // pin/unpin calls so a row can show a spinner and ignore double
  // clicks. Both are pure UI state; the DB is the source of truth.
  const [pinnedAt, setPinnedAt] = useState<Record<string, string>>({});
  const [pinBusyIds, setPinBusyIds] = useState<Set<string>>(new Set());

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Load the caller's pinned chats. Runs on mount and on resync so the
  // pin state stays correct after a reconnect / tab refocus, and so
  // opening the inbox on another device reflects pins made elsewhere.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/inbox/pins");
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && Array.isArray(data.pins)) {
          setPinnedAt(pinnedAtMapFromRecords(data.pins));
        }
      } catch {
        // Best-effort: a failed pin fetch just renders an unpinned inbox.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // Assignment is account-wide, so load the roster through the scoped API
  // instead of exposing profile queries from this client component.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/account/members");
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok && Array.isArray(data.members)) {
        setMembers(data.members as AccountMember[]);
      }
    })();
    return () => { cancelled = true; };
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (selectedMemberIds.length > 0) {
      result = result.filter((c) =>
        selectedMemberIds.includes(c.assigned_agent_id ?? "unassigned"),
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany, selectedMemberIds]);

  // Split the (already filtered/searched) list into pinned + regular.
  // Partitioning AFTER filtering means the pinned section only shows
  // pins that match the active search/filters, and the regular section
  // keeps the existing last_message_at-desc order untouched.
  const { pinned, regular } = useMemo(
    () => partitionPinnedConversations(filtered, pinnedAt),
    [filtered, pinnedAt],
  );

  const setPinBusy = useCallback((id: string, busy: boolean) => {
    setPinBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleTogglePin = useCallback(
    async (conv: Conversation, nextPinned: boolean) => {
      const id = conv.id;
      if (pinBusyIds.has(id)) return;

      // Client-side cap pre-empt so we don't even fire the request for
      // the 31st pin — the backend enforces this too (source of truth).
      if (
        nextPinned &&
        !isConversationPinned(id, pinnedAt) &&
        !canPinMore(pinnedAt)
      ) {
        toast.error(PIN_LIMIT_TITLE, { description: PIN_LIMIT_DESCRIPTION });
        return;
      }

      // Snapshot the previous pinned_at so an unpin can be rolled back
      // to its exact prior value if the request fails.
      const prevPinnedAtValue = pinnedAt[id];

      // Optimistic flip (functional update so concurrent toggles on
      // other rows don't clobber each other).
      setPinnedAt((prev) =>
        nextPinned ? addPin(prev, id, new Date().toISOString()) : removePin(prev, id),
      );
      setPinBusy(id, true);

      try {
        const res = nextPinned
          ? await fetch("/api/inbox/pins", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ conversationId: id }),
            })
          : await fetch(`/api/inbox/pins/${id}`, { method: "DELETE" });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          // Roll back the optimistic change.
          setPinnedAt((prev) =>
            nextPinned
              ? removePin(prev, id)
              : addPin(prev, id, prevPinnedAtValue ?? new Date().toISOString()),
          );
          if (res.status === 409) {
            toast.error(data.error ?? PIN_LIMIT_TITLE, {
              description: data.message ?? PIN_LIMIT_DESCRIPTION,
            });
          } else {
            toast.error("Unable to update pinned chat. Please try again.");
          }
          return;
        }

        toast.success(nextPinned ? "Chat pinned" : "Chat unpinned");
      } catch {
        setPinnedAt((prev) =>
          nextPinned
            ? removePin(prev, id)
            : addPin(prev, id, prevPinnedAtValue ?? new Date().toISOString()),
        );
        toast.error("Unable to update pinned chat. Please try again.");
      } finally {
        setPinBusy(id, false);
      }
    },
    [pinBusyIds, pinnedAt, setPinBusy],
  );

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
    setSelectedMemberIds([]);
  }, []);

  const toggleMember = useCallback((id: string) => {
    setSelectedMemberIds((prev) =>
      prev.includes(id) ? prev.filter((memberId) => memberId !== id) : [...prev, id],
    );
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null || selectedMemberIds.length > 0;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div
      className="flex h-full w-full min-w-0 flex-col border-r border-border bg-card"
    >
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Search conversations..."
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? "All"}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Tags
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? "Company"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  All companies
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {members.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedMemberIds.length > 0 ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Users className="h-3 w-3" />
                Team
                {selectedMemberIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">{selectedMemberIds.length}</span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 w-56 border-border bg-popover">
                <DropdownMenuCheckboxItem checked={selectedMemberIds.includes("unassigned")} onCheckedChange={() => toggleMember("unassigned")} className="text-sm text-popover-foreground">
                  Unassigned
                </DropdownMenuCheckboxItem>
                {members.map((member) => (
                  <DropdownMenuCheckboxItem key={member.user_id} checked={selectedMemberIds.includes(member.user_id)} onCheckedChange={() => toggleMember(member.user_id)} className="text-sm text-popover-foreground">
                    {member.full_name || "Unnamed member"}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? "Tag"}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedMemberIds.map((id) => {
              const member = members.find((item) => item.user_id === id);
              return (
                <button key={id} onClick={() => toggleMember(id)} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70">
                  <span className="max-w-24 truncate">{id === "unassigned" ? "Unassigned" : member?.full_name || "Team member"}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">No conversations found</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {/* Pinned chats float to the top (only those matching the
                current search/filters). No section labels — a thin
                divider separates them from the rest, WhatsApp-style. */}
            {pinned.length > 0 && (
              <>
                {pinned.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={conv.id === activeConversationId}
                    onSelect={handleSelect}
                    isPinned
                    isPinBusy={pinBusyIds.has(conv.id)}
                    onTogglePin={handleTogglePin}
                  />
                ))}
                {regular.length > 0 && (
                  <div className="border-b border-border" aria-hidden="true" />
                )}
              </>
            )}

            {regular.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                isPinned={false}
                isPinBusy={pinBusyIds.has(conv.id)}
                onTogglePin={handleTogglePin}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  isPinned: boolean;
  isPinBusy: boolean;
  onTogglePin: (conversation: Conversation, nextPinned: boolean) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  isPinned,
  isPinBusy,
  onTogglePin,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Unknown";
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  // The row is a div (not a button) so it can host the pin/menu controls
  // — nesting buttons inside a button is invalid HTML. Re-implement the
  // keyboard affordance a button gave us for free.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(conversation);
      }
    },
    [onSelect, conversation],
  );

  const handlePinClick = useCallback(() => {
    onTogglePin(conversation, !isPinned);
  }, [onTogglePin, conversation, isPinned]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  // `contact.tags` is already hydrated Tag[] by CONVERSATION_SELECT's
  // `contact_tags(tags(*))` embed — no id lookup needed here, unlike
  // the filter-bar chips which start from raw selectedTagIds.
  const contactTags = contact?.tags ?? [];

  const pinTooltip = isPinned ? "Unpin chat" : "Pin chat";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={displayName}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "group relative flex w-full cursor-pointer items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:bg-muted/60",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 pr-4 text-xs text-muted-foreground whitespace-nowrap">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || "No messages yet"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />

            {/* Pin toggle — WhatsApp-style: a filled pin sits in the
                bottom-right of pinned chats; for unpinned chats it stays
                hidden and reveals on hover/focus. Clicking it toggles the
                pin without selecting the row. */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePinClick();
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    disabled={isPinBusy}
                    aria-label={pinTooltip}
                    aria-pressed={isPinned}
                    className={cn(
                      "flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60",
                      // Pinned: always shown (filled). Unpinned: always
                      // tappable on touch (no hover there), but only
                      // hover/focus-revealed on desktop to keep the list clean.
                      isPinned
                        ? "opacity-100"
                        : "opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 lg:opacity-0",
                    )}
                  >
                    {isPinBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Pin
                        className={cn("h-3.5 w-3.5", isPinned && "fill-current")}
                      />
                    )}
                  </button>
                }
              />
              <TooltipContent>{pinTooltip}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Tag pill(s) — only rendered when the contact has at least one
            tag. Matches the screenshot: a small rounded label sitting
            below the last-message line. */}
        {contactTags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {contactTags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: `${tag.color}26`, // ~15% tint of the tag color
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
