import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";

import { confirmSignedOut, verifySessionActive } from "./session-recovery";

const USER = { id: "user-1" } as User;

function authError(name: string, message: string, status?: number) {
  return { name, message, status };
}

function fakeClient(opts: {
  sessionUser?: User | null | "throw";
  getUserUser?: User | null | "throw" | "hang";
  getUserError?: unknown;
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
          error: opts.getUserError ?? null,
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

  it("reports unknown (never dead) on a rotation-race refresh error", async () => {
    // Tab lost a refresh-token rotation race: getUser resolves
    // user:null WITH an invalid-grant error. Must not wipe.
    const result = await verifySessionActive(
      fakeClient({
        sessionUser: null,
        getUserUser: null,
        getUserError: authError(
          "AuthApiError",
          "Invalid Refresh Token: Refresh Token Not Found",
          400,
        ),
      }),
    );
    expect(result).toEqual({ status: "unknown" });
  });

  it("reports unknown on invalid_grant without a status code", async () => {
    const result = await verifySessionActive(
      fakeClient({
        sessionUser: null,
        getUserUser: null,
        getUserError: authError("AuthApiError", "invalid_grant: token revoked"),
      }),
    );
    expect(result).toEqual({ status: "unknown" });
  });

  it("reports dead on a genuinely missing session", async () => {
    const result = await verifySessionActive(
      fakeClient({
        sessionUser: null,
        getUserUser: null,
        getUserError: authError("AuthSessionMissingError", "Auth session missing!", 400),
      }),
    );
    expect(result).toEqual({ status: "dead" });
  });

  it("reports dead on a deterministic 401 rejection", async () => {
    const result = await verifySessionActive(
      fakeClient({
        sessionUser: null,
        getUserUser: null,
        getUserError: authError("AuthApiError", "invalid JWT: expired", 401),
      }),
    );
    expect(result).toEqual({ status: "dead" });
  });

  it("prefers a present user over any accompanying error", async () => {
    const result = await verifySessionActive(
      fakeClient({
        sessionUser: null,
        getUserUser: USER,
        getUserError: authError("AuthApiError", "noise", 400),
      }),
    );
    expect(result).toEqual({ status: "active", user: USER });
  });
});

describe("confirmSignedOut", () => {
  it("returns false when the session is alive (no wipe)", async () => {
    await expect(
      confirmSignedOut(fakeClient({ sessionUser: USER })),
    ).resolves.toBe(false);
  });

  it("returns false on rotation-race errors (transient, not death)", async () => {
    await expect(
      confirmSignedOut(
        fakeClient({
          sessionUser: null,
          getUserUser: null,
          getUserError: authError(
            "AuthApiError",
            "Invalid Refresh Token: Refresh Token Not Found",
            400,
          ),
        }),
      ),
    ).resolves.toBe(false);
  });

  it("returns true only on confirmed absence", async () => {
    await expect(
      confirmSignedOut(
        fakeClient({
          sessionUser: null,
          getUserUser: null,
          getUserError: authError("AuthSessionMissingError", "Auth session missing!", 400),
        }),
      ),
    ).resolves.toBe(true);
  });

  it("returns false when verification cannot run (never confirm on blips)", async () => {
    await expect(
      confirmSignedOut(fakeClient({ sessionUser: null, getUserUser: "throw" })),
    ).resolves.toBe(false);
  });
});
