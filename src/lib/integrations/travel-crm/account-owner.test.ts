// Focused tests: account owner email resolution for the Travel CRM
// lookup locator. The email always comes from the authenticated
// account's own rows (accounts.owner_user_id → account-scoped
// profiles.email), normalized for identity matching — never from
// request input, the browser, or configuration.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAccountOwnerEmail } from "./account-owner";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    q.maybeSingle = async () => ({
      data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null,
      error: null,
    });
    return q;
  };
  return api as unknown as SupabaseClient;
}

describe("resolveAccountOwnerEmail", () => {
  it("resolves and normalizes the account owner's email", async () => {
    const db = fakeDb({
      accounts: [{ id: "acct-1", owner_user_id: "u-owner" }],
      profiles: [
        { account_id: "acct-1", user_id: "u-owner", email: "  Owner@Acct1.Test " },
        { account_id: "acct-1", user_id: "u-agent", email: "agent@acct1.test" },
      ],
    });
    await expect(resolveAccountOwnerEmail(db, "acct-1")).resolves.toBe("owner@acct1.test");
  });

  it("returns null when the account, owner link, or email is missing", async () => {
    const noAccount = fakeDb({ accounts: [], profiles: [] });
    await expect(resolveAccountOwnerEmail(noAccount, "acct-1")).resolves.toBeNull();

    const noOwnerLink = fakeDb({ accounts: [{ id: "acct-1" }], profiles: [] });
    await expect(resolveAccountOwnerEmail(noOwnerLink, "acct-1")).resolves.toBeNull();

    const noEmail = fakeDb({
      accounts: [{ id: "acct-1", owner_user_id: "u-owner" }],
      profiles: [{ account_id: "acct-1", user_id: "u-owner", email: "  " }],
    });
    await expect(resolveAccountOwnerEmail(noEmail, "acct-1")).resolves.toBeNull();
  });

  it("scopes the owner profile to the calling account", async () => {
    const db = fakeDb({
      accounts: [{ id: "acct-1", owner_user_id: "u-owner" }],
      profiles: [
        // Same user id under another account must never leak across.
        { account_id: "acct-2", user_id: "u-owner", email: "owner@acct2.test" },
      ],
    });
    await expect(resolveAccountOwnerEmail(db, "acct-1")).resolves.toBeNull();
  });

  it("returns null instead of throwing on database errors", async () => {
    const broken = {
      from: () => {
        throw new Error("db down");
      },
    } as unknown as SupabaseClient;
    await expect(resolveAccountOwnerEmail(broken, "acct-1")).resolves.toBeNull();
  });
});
