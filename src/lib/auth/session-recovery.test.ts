import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";

import { verifySessionActive } from "./session-recovery";

const USER = { id: "user-1" } as User;

function fakeClient(opts: {
  sessionUser?: User | null | "throw";
  getUserUser?: User | null | "throw" | "hang";
}): SupabaseClient {
  return {
    auth: {
      getSession: async () => {
        if (opts.sessionUser === "throw") throw new Error("storage blew up");
        return { data: { session: opts.sessionUser ? { user: opts.sessionUser } : null } };
      },
      getUser: () => {
        if (opts.getUserUser === "throw") {
          return Promise.reject(new TypeError("fetch failed"));
        }
        if (opts.getUserUser === "hang") {
          return new Promise(() => {});
        }
        return Promise.resolve({
          data: { user: opts.getUserUser ?? null },
        });
      },
    },
  } as unknown as SupabaseClient;
}

describe("verifySessionActive", () => {
  it("restores from the local session without any network call", async () => {
    const getUser = vi.fn();
    const client = fakeClient({ sessionUser: USER });
    (client.auth as unknown as Record<string, unknown>).getUser = getUser;
    const result = await verifySessionActive(client);
    expect(result).toEqual({ status: "active", user: USER });
    expect(getUser).not.toHaveBeenCalled();
  });

  it("recovers via the server check when local storage reads empty", async () => {
    const result = await verifySessionActive(
      fakeClient({ sessionUser: null, getUserUser: USER }),
    );
    expect(result).toEqual({ status: "active", user: USER });
  });

  it("reports dead when both local and server confirm no session", async () => {
    const result = await verifySessionActive(
      fakeClient({ sessionUser: null, getUserUser: null }),
    );
    expect(result).toEqual({ status: "dead" });
  });

  it("reports unknown (never dead) when the server check cannot run", async () => {
    const result = await verifySessionActive(
      fakeClient({ sessionUser: null, getUserUser: "throw" }),
    );
    expect(result).toEqual({ status: "unknown" });
  });

  it("reports unknown when the server check hangs past its bound", async () => {
    const result = await verifySessionActive(
      fakeClient({ sessionUser: "throw", getUserUser: "hang" }),
      { getUserTimeoutMs: 10 },
    );
    expect(result).toEqual({ status: "unknown" });
  }, 5000);
});
