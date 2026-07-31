import { describe, it, expect } from "vitest";
import type { Conversation } from "@/types";
import {
  MAX_PINNED_CHATS,
  addPin,
  canPinMore,
  comparePinned,
  isConversationPinned,
  partitionPinnedConversations,
  pinnedAtMapFromRecords,
  pinnedCount,
  removePin,
} from "./pins";

// Minimal Conversation factory — only the fields the pin logic reads
// (id, last_message_at) matter here.
function conv(id: string, lastMessageAt?: string): Conversation {
  return {
    id,
    user_id: "u1",
    contact_id: `ct-${id}`,
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    last_message_at: lastMessageAt,
  };
}

const T = {
  old: "2026-01-01T00:00:00.000Z",
  mid: "2026-06-01T00:00:00.000Z",
  new: "2026-08-01T00:00:00.000Z",
};

describe("MAX_PINNED_CHATS", () => {
  it("is 30 (matches the DB-enforced cap)", () => {
    expect(MAX_PINNED_CHATS).toBe(30);
  });
});

describe("pinnedAtMapFromRecords", () => {
  it("builds a conversation_id -> pinned_at map", () => {
    const map = pinnedAtMapFromRecords([
      { conversation_id: "a", pinned_at: T.old },
      { conversation_id: "b", pinned_at: T.new },
    ]);
    expect(map).toEqual({ a: T.old, b: T.new });
  });

  it("returns an empty map for no records", () => {
    expect(pinnedAtMapFromRecords([])).toEqual({});
  });
});

describe("isConversationPinned / pinnedCount / canPinMore", () => {
  it("detects membership by key presence", () => {
    const map = { a: T.old };
    expect(isConversationPinned("a", map)).toBe(true);
    expect(isConversationPinned("b", map)).toBe(false);
  });

  it("counts pins", () => {
    expect(pinnedCount({})).toBe(0);
    expect(pinnedCount({ a: T.old, b: T.new })).toBe(2);
  });

  it("allows more pins below the cap and blocks at the cap", () => {
    const under: Record<string, string> = {};
    for (let i = 0; i < MAX_PINNED_CHATS - 1; i++) under[`c${i}`] = T.old;
    expect(canPinMore(under)).toBe(true);

    const atCap: Record<string, string> = {};
    for (let i = 0; i < MAX_PINNED_CHATS; i++) atCap[`c${i}`] = T.old;
    expect(pinnedCount(atCap)).toBe(30);
    expect(canPinMore(atCap)).toBe(false);
  });
});

describe("comparePinned", () => {
  it("orders by most-recent message first", () => {
    const a = conv("a", T.old);
    const b = conv("b", T.new);
    expect(comparePinned(a, b, {})).toBeGreaterThan(0); // b before a
    expect(comparePinned(b, a, {})).toBeLessThan(0);
  });

  it("tie-breaks equal message times by most-recently pinned", () => {
    const a = conv("a", T.mid);
    const b = conv("b", T.mid);
    const pins = { a: T.old, b: T.new };
    expect(comparePinned(a, b, pins)).toBeGreaterThan(0); // b pinned later => first
  });

  it("falls back to a stable id order when all else is equal", () => {
    const a = conv("a", T.mid);
    const b = conv("b", T.mid);
    const pins = { a: T.old, b: T.old };
    expect(comparePinned(a, b, pins)).toBeLessThan(0); // "a" < "b"
  });
});

describe("partitionPinnedConversations", () => {
  it("puts pinned chats first (sorted by recent message) and keeps regular order", () => {
    // Input arrives already sorted by last_message_at desc (inbox default).
    const list = [
      conv("r1", T.new),
      conv("p_old", T.old),
      conv("r2", T.mid),
      conv("p_new", T.new),
    ];
    const pins = { p_old: T.mid, p_new: T.mid };

    const { pinned, regular } = partitionPinnedConversations(list, pins);

    // Pinned section: p_new (newer message) before p_old.
    expect(pinned.map((c) => c.id)).toEqual(["p_new", "p_old"]);
    // Regular section: original relative order preserved (r1 then r2).
    expect(regular.map((c) => c.id)).toEqual(["r1", "r2"]);
  });

  it("returns everything as regular when nothing is pinned", () => {
    const list = [conv("a", T.new), conv("b", T.old)];
    const { pinned, regular } = partitionPinnedConversations(list, {});
    expect(pinned).toEqual([]);
    expect(regular.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("composes with search/filter: only pins present in the input appear", () => {
    // Simulates a search that already filtered the list down to b + c.
    // Even though "a" is pinned, it's not in the input, so it can't show.
    const filtered = [conv("b", T.new), conv("c", T.old)];
    const pins = { a: T.new, c: T.old };
    const { pinned, regular } = partitionPinnedConversations(filtered, pins);
    expect(pinned.map((x) => x.id)).toEqual(["c"]);
    expect(regular.map((x) => x.id)).toEqual(["b"]);
  });

  it("does not mutate the input array", () => {
    const list = [conv("p", T.old), conv("r", T.new)];
    const copy = [...list];
    partitionPinnedConversations(list, { p: T.old });
    expect(list).toEqual(copy);
  });
});

describe("addPin / removePin (optimistic helpers)", () => {
  it("addPin returns a new map with the pin added", () => {
    const before = { a: T.old };
    const after = addPin(before, "b", T.new);
    expect(after).toEqual({ a: T.old, b: T.new });
    expect(before).toEqual({ a: T.old }); // input untouched
  });

  it("removePin returns a new map without the pin", () => {
    const before = { a: T.old, b: T.new };
    const after = removePin(before, "a");
    expect(after).toEqual({ b: T.new });
    expect(before).toEqual({ a: T.old, b: T.new }); // input untouched
  });

  it("round-trips: add then remove restores the original", () => {
    const start = { a: T.old };
    expect(removePin(addPin(start, "b", T.new), "b")).toEqual(start);
  });
});
