// ============================================================
// Inbox pinned-chats logic — pure, unit-testable, no I/O.
//
// The Inbox renders pinned conversations in their own section above
// the regular list. All the ordering / partitioning / limit rules
// live here so they can be tested without a DOM or a database, and
// so the client and the (DB-enforced) server agree on MAX_PINNED.
//
// Pin state is held client-side as a plain map of
//   conversation_id -> pinned_at (ISO string)
// rather than a boolean flag on the Conversation, because pins are
// per-user and never travel on the shared conversation row.
// ============================================================

import type { Conversation } from "@/types";

/**
 * Maximum chats a single user may pin at once. Mirrors the `c_max`
 * constant enforced by the `pin_conversation` RPC (migration 054) —
 * the DB is the source of truth; this is the client-side mirror so
 * the UI can pre-empt the 31st pin without a round trip.
 */
export const MAX_PINNED_CHATS = 30;

/** conversation_id -> pinned_at (ISO). Presence of a key == pinned. */
export type PinnedAtMap = Readonly<Record<string, string>>;

/** One pin as returned by the API (`GET /api/inbox/pins`). */
export interface ConversationPinRecord {
  conversation_id: string;
  pinned_at: string;
}

/** Build the `PinnedAtMap` the UI works with from API pin records. */
export function pinnedAtMapFromRecords(
  records: ConversationPinRecord[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of records) map[r.conversation_id] = r.pinned_at;
  return map;
}

export function isConversationPinned(id: string, pinned: PinnedAtMap): boolean {
  return Object.prototype.hasOwnProperty.call(pinned, id);
}

export function pinnedCount(pinned: PinnedAtMap): number {
  return Object.keys(pinned).length;
}

/** Whether the user is under the pin cap (i.e. another pin is allowed). */
export function canPinMore(pinned: PinnedAtMap): boolean {
  return pinnedCount(pinned) < MAX_PINNED_CHATS;
}

// Milliseconds of a conversation's last message, or 0 when absent /
// unparseable — an unparseable timestamp sorts oldest rather than
// throwing, keeping the list render total.
function lastMessageMs(c: Conversation): number {
  if (!c.last_message_at) return 0;
  const t = Date.parse(c.last_message_at);
  return Number.isNaN(t) ? 0 : t;
}

function pinnedAtMs(id: string, pinned: PinnedAtMap): number {
  const raw = pinned[id];
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Ordering for the pinned section: most-recent message first (the
 * default, matching the regular inbox sort), tie-broken by most-
 * recently pinned, then by id for a stable, deterministic result.
 */
export function comparePinned(
  a: Conversation,
  b: Conversation,
  pinned: PinnedAtMap,
): number {
  const byMessage = lastMessageMs(b) - lastMessageMs(a);
  if (byMessage !== 0) return byMessage;
  const byPinned = pinnedAtMs(b.id, pinned) - pinnedAtMs(a.id, pinned);
  if (byPinned !== 0) return byPinned;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export interface PartitionedConversations {
  /** Pinned rows, sorted by {@link comparePinned}. */
  pinned: Conversation[];
  /** Everything else, in the SAME order it arrived (existing inbox sort). */
  regular: Conversation[];
}

/**
 * Split an (already filtered/searched) conversation list into its
 * pinned and regular sections.
 *
 * Because it operates on whatever list it's given, it composes with
 * search + filters for free: pass the filtered list and only pinned
 * chats that match the active search/filters appear in the pinned
 * section. The regular section preserves input order so the inbox's
 * existing `last_message_at desc` sort is left untouched (requirement 4).
 */
export function partitionPinnedConversations(
  conversations: Conversation[],
  pinned: PinnedAtMap,
): PartitionedConversations {
  const pinnedList: Conversation[] = [];
  const regular: Conversation[] = [];
  for (const c of conversations) {
    if (isConversationPinned(c.id, pinned)) pinnedList.push(c);
    else regular.push(c);
  }
  pinnedList.sort((a, b) => comparePinned(a, b, pinned));
  return { pinned: pinnedList, regular };
}

// ------------------------------------------------------------
// Optimistic-update helpers — return a NEW map, never mutate. Used
// by the UI to flip pin state instantly and roll back on API error.
// ------------------------------------------------------------

export function addPin(
  pinned: PinnedAtMap,
  id: string,
  pinnedAt: string,
): Record<string, string> {
  return { ...pinned, [id]: pinnedAt };
}

export function removePin(
  pinned: PinnedAtMap,
  id: string,
): Record<string, string> {
  const next = { ...pinned };
  delete next[id];
  return next;
}
