"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  type ConversationDateFilter,
  getConversationDateRange,
  matchesContactFilters,
  matchesConversationDateFilter,
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
import type {
  AccountMember,
  Conversation,
  ConversationStatus,
  Tag,
} from "@/types";
import { Search, ChevronDown, Users, X, Pin, Loader2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

const DATE_FILTER_OPTIONS: { label: string; value: ConversationDateFilter }[] =
  [
    { label: "All Chats", value: "all" },
    { label: "Today", value: "today" },
    { label: "Yesterday", value: "yesterday" },
    { label: "Custom...", value: "custom" },
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
  const [dateFilter, setDateFilter] = useState<ConversationDateFilter>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [draftCustomFrom, setDraftCustomFrom] = useState("");
  const [draftCustomTo, setDraftCustomTo] = useState("");
  const [customDateOpen, setCustomDateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  // Flow matches the contact's active (or most recent) flow run.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([]);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
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
      setLoading(true);
      const dateRange = getConversationDateRange({
        filter: dateFilter,
        customFrom,
        customTo,
      });
      let query = supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (dateRange) {
        query = query
          .gte("last_message_at", dateRange.from.toISOString())
          .lte("last_message_at", dateRange.to.toISOString());
      }

      const { data, error } = await query;

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
  }, [resyncToken, dateFilter, customFrom, customTo]);

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
    return () => {
      cancelled = true;
    };
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

  // Flow definitions for the filter picker — same pattern as tags. RLS
  // scopes this to the account; a conversation can only ever match one
  // of the account's own flows.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("flows")
        .select("id, name")
        .order("name");
      if (!cancelled && data) setFlows(data);
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
    const dateRange = getConversationDateRange({
      filter: dateFilter,
      customFrom,
      customTo,
    });

    if (dateRange) {
      result = result.filter((c) =>
        matchesConversationDateFilter(c, dateRange)
      );
    }

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match,
    // flow via the contact's active/most-recent flow run).
    if (
      selectedTagIds.length > 0 ||
      selectedCompany !== null ||
      selectedFlowId != null
    ) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
          flowId: selectedFlowId,
        })
      );
    }

    if (selectedMemberIds.length > 0) {
      result = result.filter((c) =>
        selectedMemberIds.includes(c.assigned_agent_id ?? "unassigned")
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
  }, [
    conversations,
    dateFilter,
    customFrom,
    customTo,
    filter,
    search,
    selectedTagIds,
    selectedCompany,
    selectedFlowId,
    selectedMemberIds,
  ]);

  // Split the (already filtered/searched) list into pinned + regular.
  // Partitioning AFTER filtering means the pinned section only shows
  // pins that match the active search/filters, and the regular section
  // keeps the existing last_message_at-desc order untouched.
  const { pinned, regular } = useMemo(
    () => partitionPinnedConversations(filtered, pinnedAt),
    [filtered, pinnedAt]
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
        nextPinned
          ? addPin(prev, id, new Date().toISOString())
          : removePin(prev, id)
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
              : addPin(prev, id, prevPinnedAtValue ?? new Date().toISOString())
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
            : addPin(prev, id, prevPinnedAtValue ?? new Date().toISOString())
        );
        toast.error("Unable to update pinned chat. Please try again.");
      } finally {
        setPinBusy(id, false);
      }
    },
    [pinBusyIds, pinnedAt, setPinBusy]
  );

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
    setSelectedFlowId(null);
    setSelectedMemberIds([]);
  }, []);

  const toggleMember = useCallback((id: string) => {
    setSelectedMemberIds((prev) =>
      prev.includes(id)
        ? prev.filter((memberId) => memberId !== id)
        : [...prev, id]
    );
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 ||
    selectedCompany !== null ||
    selectedFlowId != null ||
    selectedMemberIds.length > 0;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleDateFilterSelect = useCallback(
    (next: ConversationDateFilter) => {
      if (next === "custom") {
        setDateFilter("custom");
        setDraftCustomFrom(customFrom);
        setDraftCustomTo(customTo);
        setCustomDateOpen(true);
        return;
      }

      setDateFilter(next);
      setCustomDateOpen(false);
      if (next === "all") {
        setCustomFrom("");
        setCustomTo("");
        setDraftCustomFrom("");
        setDraftCustomTo("");
      }
    },
    [customFrom, customTo]
  );

  const applyCustomDateFilter = useCallback(() => {
    if (!draftCustomFrom || !draftCustomTo) return;
    setDateFilter("custom");
    setCustomFrom(draftCustomFrom);
    setCustomTo(draftCustomTo);
    setCustomDateOpen(false);
  }, [draftCustomFrom, draftCustomTo]);

  const clearDateFilter = useCallback(() => {
    setDateFilter("all");
    setCustomFrom("");
    setCustomTo("");
    setDraftCustomFrom("");
    setDraftCustomTo("");
    setCustomDateOpen(false);
  }, []);

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);
  const activeFlow = flows.find((f) => f.id === selectedFlowId);
  const activeDateFilter = DATE_FILTER_OPTIONS.find(
    (o) => o.value === dateFilter
  );
  const activeDateRange = getConversationDateRange({
    filter: dateFilter,
    customFrom,
    customTo,
  });
  const hasDateFilter = activeDateRange !== null;
  const customDateReady = draftCustomFrom !== "" && draftCustomTo !== "";

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="border-border bg-card flex h-full w-full min-w-0 flex-col border-r">
      {/* Search + Filter */}
      <div className="border-border space-y-2 border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Search conversations..."
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs">
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

          <div className="flex items-center gap-1">
            <Popover open={customDateOpen} onOpenChange={setCustomDateOpen}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-7 max-w-36 gap-1 px-2 text-xs",
                      hasDateFilter
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  />
                }
              >
                <span className="truncate">
                  {activeDateFilter?.label ?? "All Chats"}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 gap-2 p-2">
                <div className="grid gap-1">
                  {DATE_FILTER_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleDateFilterSelect(opt.value)}
                      className={cn(
                        "hover:bg-muted rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        dateFilter === opt.value
                          ? "text-primary"
                          : "text-popover-foreground"
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {dateFilter === "custom" && (
                  <div className="border-border space-y-2 border-t pt-2">
                    <div className="space-y-1">
                      <label className="text-foreground text-xs font-medium">
                        From Date
                      </label>
                      <Input
                        type="date"
                        value={draftCustomFrom}
                        onChange={(e) => setDraftCustomFrom(e.target.value)}
                        className="border-border bg-muted h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-foreground text-xs font-medium">
                        To Date
                      </label>
                      <Input
                        type="date"
                        value={draftCustomTo}
                        onChange={(e) => setDraftCustomTo(e.target.value)}
                        className="border-border bg-muted h-8 text-sm"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={clearDateFilter}
                        className="text-muted-foreground"
                      >
                        Clear
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={applyCustomDateFilter}
                        disabled={!customDateReady}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Tags
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-popover-foreground text-sm"
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
                  "hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs",
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
                className="border-border bg-popover max-h-64 w-56"
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

          {flows.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedFlowId
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Workflow className="h-3 w-3" />
                <span className="max-w-24 truncate">
                  {activeFlow?.name ?? "Flow"}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedFlowId(null)}
                  className={cn(
                    "text-sm",
                    selectedFlowId === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  All flows
                </DropdownMenuItem>
                {flows.map((flow) => (
                  <DropdownMenuItem
                    key={flow.id}
                    onClick={() => setSelectedFlowId(flow.id)}
                    className={cn(
                      "text-sm",
                      selectedFlowId === flow.id
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{flow.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {members.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedMemberIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Users className="h-3 w-3" />
                Team
                {selectedMemberIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedMemberIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuCheckboxItem
                  checked={selectedMemberIds.includes("unassigned")}
                  onCheckedChange={() => toggleMember("unassigned")}
                  className="text-popover-foreground text-sm"
                >
                  Unassigned
                </DropdownMenuCheckboxItem>
                {members.map((member) => (
                  <DropdownMenuCheckboxItem
                    key={member.user_id}
                    checked={selectedMemberIds.includes(member.user_id)}
                    onCheckedChange={() => toggleMember(member.user_id)}
                    className="text-popover-foreground text-sm"
                  >
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
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? "var(--muted-foreground)",
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? "Tag"}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedFlowId && (
              <button
                onClick={() => setSelectedFlowId(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <Workflow className="h-3 w-3 shrink-0" />
                <span className="max-w-24 truncate">
                  {activeFlow?.name ?? "Flow"}
                </span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedMemberIds.map((id) => {
              const member = members.find((item) => item.user_id === id);
              return (
                <button
                  key={id}
                  onClick={() => toggleMember(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span className="max-w-24 truncate">
                    {id === "unassigned"
                      ? "Unassigned"
                      : member?.full_name || "Team member"}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            <button
              onClick={clearContactFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              Clear all
            </button>
          </div>
        )}
        {hasDateFilter && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={clearDateFilter}
              className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
            >
              <span className="max-w-40 truncate">
                {dateFilter === "custom" && customFrom && customTo
                  ? `${customFrom} to ${customTo}`
                  : activeDateFilter?.label ?? "Date filter"}
              </span>
              <X className="h-3 w-3" />
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
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {hasDateFilter
                ? "No chats found for this date."
                : "No conversations found"}
            </p>
            {hasDateFilter && (
              <button
                type="button"
                onClick={clearDateFilter}
                className="text-primary mt-2 text-xs hover:underline"
              >
                Clear date filter
              </button>
            )}
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
                  <div className="border-border border-b" aria-hidden="true" />
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
    [onSelect, conversation]
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
        "group hover:bg-muted/50 focus-visible:bg-muted/60 relative flex w-full cursor-pointer items-start gap-3 px-3 py-3 text-left transition-colors focus:outline-none",
        isActive && "border-primary bg-muted/70 border-l-2"
      )}
    >
      {/* Avatar */}
      <div className="bg-muted text-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
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
          <span className="text-foreground truncate text-sm font-medium">
            {displayName}
          </span>
          <span className="text-muted-foreground shrink-0 pr-4 text-xs whitespace-nowrap">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="text-muted-foreground truncate text-xs">
            {conversation.last_message_text || "No messages yet"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
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
                      "text-muted-foreground hover:bg-muted flex h-5 w-5 items-center justify-center rounded transition-colors disabled:opacity-60",
                      // Pinned: always shown (filled). Unpinned: always
                      // tappable on touch (no hover there), but only
                      // hover/focus-revealed on desktop to keep the list clean.
                      isPinned
                        ? "opacity-100"
                        : "opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 lg:opacity-0"
                    )}
                  >
                    {isPinBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Pin
                        className={cn(
                          "h-3.5 w-3.5",
                          isPinned && "fill-current"
                        )}
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
