import { describe, it, expect } from "vitest";
import {
  getConversationDateRange,
  matchesConversationDateFilter,
  matchesContactFilters,
  normalizeConversation,
} from "./conversations";
import type { Conversation } from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      })
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null })
    ).toBe(true);
    expect(matchesContactFilters(conv, { tagIds: ["t9"], company: null })).toBe(
      false
    );
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(matchesContactFilters(conv, { tagIds: ["t1"], company: null })).toBe(
      false
    );
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      })
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(matchesContactFilters(conv, { tagIds: [], company: "Acme" })).toBe(
      true
    );
    expect(matchesContactFilters(conv, { tagIds: [], company: "Other" })).toBe(
      false
    );
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" })
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" })
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" })
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });
});

describe("getConversationDateRange", () => {
  it("returns null for all chats", () => {
    expect(
      getConversationDateRange({
        filter: "all",
      })
    ).toBeNull();
  });

  it("builds today's inclusive local-day range", () => {
    const range = getConversationDateRange(
      { filter: "today" },
      new Date(2026, 7, 22, 14, 30)
    );

    expect(range?.from).toEqual(new Date(2026, 7, 22, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 7, 22, 23, 59, 59, 999));
  });

  it("builds yesterday's inclusive local-day range", () => {
    const range = getConversationDateRange(
      { filter: "yesterday" },
      new Date(2026, 7, 1, 1, 15)
    );

    expect(range?.from).toEqual(new Date(2026, 6, 31, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 6, 31, 23, 59, 59, 999));
  });

  it("supports a custom single-day range", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-08-22",
      customTo: "2026-08-22",
    });

    expect(range?.from).toEqual(new Date(2026, 7, 22, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 7, 22, 23, 59, 59, 999));
  });

  it("supports a custom range across months", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-07-31",
      customTo: "2026-08-02",
    });

    expect(range?.from).toEqual(new Date(2026, 6, 31, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 7, 2, 23, 59, 59, 999));
  });

  it("normalizes a reversed custom date range", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-08-22",
      customTo: "2026-08-01",
    });

    expect(range?.from).toEqual(new Date(2026, 7, 1, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 7, 22, 23, 59, 59, 999));
  });
});

describe("matchesConversationDateFilter", () => {
  it("matches inclusive activity boundaries around local midnight", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-08-22",
      customTo: "2026-08-22",
    });

    expect(
      matchesConversationDateFilter(
        { last_message_at: new Date(2026, 7, 22, 0, 0, 0, 0).toISOString() },
        range
      )
    ).toBe(true);
    expect(
      matchesConversationDateFilter(
        {
          last_message_at: new Date(2026, 7, 22, 23, 59, 59, 999).toISOString(),
        },
        range
      )
    ).toBe(true);
    expect(
      matchesConversationDateFilter(
        {
          last_message_at: new Date(2026, 7, 21, 23, 59, 59, 999).toISOString(),
        },
        range
      )
    ).toBe(false);
    expect(
      matchesConversationDateFilter(
        { last_message_at: new Date(2026, 7, 23, 0, 0, 0, 0).toISOString() },
        range
      )
    ).toBe(false);
  });

  it("excludes conversations without latest activity when date-filtered", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-08-22",
      customTo: "2026-08-22",
    });

    expect(matchesConversationDateFilter({}, range)).toBe(false);
  });
});
