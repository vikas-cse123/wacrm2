import { describe, expect, it, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  __resetTagCacheForTests,
  clearTagCache,
  fetchAccountTags,
  filterTagsByQuery,
  readTagCache,
  resolveTagSelection,
  writeTagCache,
  type TagOption,
} from "./tag-select";

const TAGS: TagOption[] = [
  { id: "65380837-b289-44b0-a778-de8bc35af803", name: "meeting-booked", color: "#3b82f6" },
  { id: "b2", name: "Low Budget" },
  { id: "b3", name: "Meeting Completed" },
  { id: "b4", name: "Singapore" },
];

function fakeClient(
  data: unknown,
  error: unknown = null,
): Pick<SupabaseClient, "from"> {
  return {
    from: () => ({
      select: () => ({
        order: async () => ({ data, error }),
      }),
    }),
  } as unknown as Pick<SupabaseClient, "from">;
}

beforeEach(() => {
  __resetTagCacheForTests();
});

describe("resolveTagSelection", () => {
  it("resolves a stored UUID to its tag name", () => {
    const sel = resolveTagSelection(
      TAGS,
      "65380837-b289-44b0-a778-de8bc35af803",
    );
    expect(sel).toEqual({
      status: "selected",
      tag: TAGS[0],
    });
  });

  it("reports empty for no stored value", () => {
    expect(resolveTagSelection(TAGS, "")).toEqual({ status: "unselected" });
    expect(resolveTagSelection(TAGS, null)).toEqual({ status: "unselected" });
    expect(resolveTagSelection(TAGS, undefined)).toEqual({
      status: "unselected",
    });
  });

  it("reports missing (never rewrites) for a deleted UUID", () => {
    expect(resolveTagSelection(TAGS, "gone-uuid")).toEqual({
      status: "missing",
      tagId: "gone-uuid",
    });
  });
});

describe("filterTagsByQuery", () => {
  it("matches case-insensitively on the name", () => {
    expect(filterTagsByQuery(TAGS, "meeting").map((t) => t.name)).toEqual([
      "meeting-booked",
      "Meeting Completed",
    ]);
    expect(filterTagsByQuery(TAGS, "SINGA").map((t) => t.name)).toEqual([
      "Singapore",
    ]);
  });

  it("returns everything on an empty query and [] on no match", () => {
    expect(filterTagsByQuery(TAGS, "  ")).toHaveLength(4);
    expect(filterTagsByQuery(TAGS, "zzz")).toEqual([]);
  });
});

describe("fetchAccountTags", () => {
  it("normalizes rows and drops malformed ones", async () => {
    const rows = await fetchAccountTags(
      fakeClient([
        { id: "a", name: "Alpha", color: "#fff" },
        { id: "b", name: "Beta" },
        { id: null, name: "NoId" },
        { id: "c", name: 42 },
        null,
      ]),
    );
    expect(rows).toEqual([
      { id: "a", name: "Alpha", color: "#fff" },
      { id: "b", name: "Beta", color: undefined },
    ]);
  });

  it("returns [] on query error or null data (never throws)", async () => {
    expect(await fetchAccountTags(fakeClient(null, { message: "rls" }))).toEqual(
      [],
    );
    expect(await fetchAccountTags(fakeClient(null))).toEqual([]);
    expect(
      await fetchAccountTags({
        from: () => {
          throw new Error("offline");
        },
      } as unknown as Pick<SupabaseClient, "from">),
    ).toEqual([]);
  });

  it("queries only id/name/color ordered by name (account-scoped by RLS)", async () => {
    const seen: string[][] = [];
    const client = {
      from: (table: string) => {
        seen.push([table]);
        return {
          select: (cols: string) => {
            seen.push([cols]);
            return {
              order: (col: string) => {
                seen.push([col]);
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        };
      },
    } as unknown as Pick<SupabaseClient, "from">;
    await fetchAccountTags(client);
    expect(seen).toEqual([
      ["tags"],
      ["id, name, color"],
      ["name"],
    ]);
  });
});

describe("account-scoped tag cache", () => {
  const TAG_A = { id: "tag-a-1", name: "Alpha" };
  const TAG_B = { id: "tag-b-1", name: "Beta" };

  it("serves an account only its own cached tags", () => {
    writeTagCache("acct-A", [TAG_A]);
    expect(readTagCache("acct-A")).toEqual([TAG_A]);
    // Account B must never read Account A's entry.
    expect(readTagCache("acct-B")).toBeNull();
  });

  it("keeps both accounts' entries isolated", () => {
    writeTagCache("acct-A", [TAG_A]);
    writeTagCache("acct-B", [TAG_B]);
    expect(readTagCache("acct-A")).toEqual([TAG_A]);
    expect(readTagCache("acct-B")).toEqual([TAG_B]);
    // No UUID from A is reachable via B's entry.
    expect(
      readTagCache("acct-B")!.some((t) => t.id === TAG_A.id),
    ).toBe(false);
  });

  it("reuses an account's own cache on revisit (no refetch needed)", () => {
    writeTagCache("acct-A", [TAG_A], 1000);
    expect(readTagCache("acct-A", 1000 + 59_000)).toEqual([TAG_A]);
  });

  it("expires entries after the TTL so new tags appear", () => {
    writeTagCache("acct-A", [TAG_A], 1000);
    expect(readTagCache("acct-A", 1000 + 60_000)).toBeNull();
    expect(readTagCache("acct-A", 1000 + 61_000)).toBeNull();
  });

  it("clearing one account leaves the other intact; full clear empties all", () => {
    writeTagCache("acct-A", [TAG_A]);
    writeTagCache("acct-B", [TAG_B]);
    clearTagCache("acct-A");
    expect(readTagCache("acct-A")).toBeNull();
    expect(readTagCache("acct-B")).toEqual([TAG_B]);
    clearTagCache();
    expect(readTagCache("acct-B")).toBeNull();
  });

  it("logout transition (clear all) isolates the next login", () => {
    writeTagCache("acct-A", [TAG_A]);
    clearTagCache();
    // Next session starts with a cold cache even for the same key.
    expect(readTagCache("acct-A")).toBeNull();
  });
});
