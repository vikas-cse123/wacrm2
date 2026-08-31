import type { Conversation, Contact, Tag } from "@/types";
import { pickContactFlowRun, type ContactFlowRun } from "./contact-flow";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 *
 * Also embeds the contact's `flow_runs` (with the flow id/name joined),
 * which the same flattening reduces to `contact.flow_id`/`contact.flow_name`
 * (active run first, else most recent) for the Inbox flow filter and the
 * contact panel's FLOW display.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)), flow_runs(id, status, started_at, flow:flows(id, name)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & {
  contact_tags?: { tags: Tag | null }[];
  flow_runs?: ContactFlowRun[];
};
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`,
 * and the embedded `flow_runs` join into `contact.flow_id`/`flow_name`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, flow_runs, ...contact } = rawContact;
  const flowRun = pickContactFlowRun(flow_runs ?? []);
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
      flow_id: flowRun?.flow?.id ?? null,
      flow_name: flowRun?.flow?.name ?? null,
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[]
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
  /** Flow id (from contact.flow_id); null for no flow filter. */
  flowId?: string | null;
}

export type ConversationDateFilter = "all" | "today" | "yesterday" | "custom";

export interface ConversationDateRange {
  from: Date;
  to: Date;
}

export interface ConversationDateFilterState {
  filter: ConversationDateFilter;
  customFrom?: string;
  customTo?: string;
}

function parseLocalDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function localDayRange(date: Date): ConversationDateRange {
  return {
    from: new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      0,
      0,
      0,
      0
    ),
    to: new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      23,
      59,
      59,
      999
    ),
  };
}

/**
 * Builds inclusive local-day boundaries for Inbox date filters.
 * The returned Date objects can be sent to Supabase as ISO strings:
 * construction happens in the browser's local timezone, while
 * `toISOString()` converts those exact instants to UTC for TIMESTAMPTZ.
 */
export function getConversationDateRange(
  { filter, customFrom, customTo }: ConversationDateFilterState,
  now = new Date()
): ConversationDateRange | null {
  if (filter === "all") return null;

  if (filter === "today") {
    return localDayRange(now);
  }

  if (filter === "yesterday") {
    return localDayRange(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    );
  }

  const fromDate = customFrom ? parseLocalDateInput(customFrom) : null;
  const toDate = customTo ? parseLocalDateInput(customTo) : null;
  if (!fromDate || !toDate) return null;

  const fromRange = localDayRange(fromDate);
  const toRange = localDayRange(toDate);

  return fromRange.from <= toRange.to
    ? { from: fromRange.from, to: toRange.to }
    : { from: toRange.from, to: fromRange.to };
}

export function matchesConversationDateFilter(
  conversation: Pick<Conversation, "last_message_at">,
  range: ConversationDateRange | null
): boolean {
  if (!range) return true;
  if (!conversation.last_message_at) return false;

  const activity = new Date(conversation.last_message_at);
  return activity >= range.from && activity <= range.to;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds`, null `company` and null `flowId` are no-ops, so the
 * default (no filters) always matches. Tags use OR logic, consistent with
 * Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company, flowId }: ContactFilters
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  if (flowId != null && conversation.contact?.flow_id !== flowId) {
    return false;
  }

  return true;
}
