import { describe, expect, it } from "vitest";

import {
  authFailureCode,
  classifyAuthFailure,
  isConfirmedUnauthenticated,
  withAuthTimeout,
} from "./auth-errors";

function apiError(message: string, status: number, code = "test_code") {
  const err = new Error(message) as Error & { status: number; code: string };
  err.name = "AuthApiError";
  err.status = status;
  err.code = code;
  return err;
}

describe("classifyAuthFailure", () => {
  it("treats a clean null user as confirmed anonymous", () => {
    expect(classifyAuthFailure(null)).toBe("anonymous");
    expect(classifyAuthFailure(undefined)).toBe("anonymous");
  });

  it("treats deterministic server rejections as confirmed", () => {
    expect(classifyAuthFailure(apiError("invalid JWT", 401))).toBe("rejected");
    expect(classifyAuthFailure(apiError("forbidden", 403))).toBe("rejected");
  });

  it("treats invalid-refresh-token as the rotation-race signature", () => {
    expect(
      classifyAuthFailure(
        apiError("Invalid Refresh Token: Refresh Token Not Found", 400),
      ),
    ).toBe("invalid_refresh");
    expect(classifyAuthFailure(apiError("invalid_grant", 400))).toBe(
      "invalid_refresh",
    );
  });

  it("treats timeouts, network blips, rate limits, and 5xx as transient", () => {
    expect(classifyAuthFailure(new Error("auth lookup timed out"))).toBe(
      "timeout",
    );
    expect(classifyAuthFailure(new TypeError("fetch failed"))).toBe("network");
    expect(classifyAuthFailure(new Error("NetworkError when attempting to fetch resource"))).toBe(
      "network",
    );
    expect(classifyAuthFailure(apiError("too many requests", 429))).toBe(
      "rate_limited",
    );
    expect(classifyAuthFailure(apiError("bad gateway", 502))).toBe(
      "server_error",
    );
  });

  it("treats unrecognized failures as unknown (never confirmed)", () => {
    expect(classifyAuthFailure(new Error("weird"))).toBe("unknown");
    expect(classifyAuthFailure("a string")).toBe("unknown");
    expect(classifyAuthFailure(42)).toBe("unknown");
  });
});

describe("isConfirmedUnauthenticated", () => {
  it("redirects only on anonymous or rejected", () => {
    expect(isConfirmedUnauthenticated("anonymous")).toBe(true);
    expect(isConfirmedUnauthenticated("rejected")).toBe(true);
    for (const kind of [
      "invalid_refresh",
      "rate_limited",
      "server_error",
      "timeout",
      "network",
      "unknown",
    ] as const) {
      expect(isConfirmedUnauthenticated(kind)).toBe(false);
    }
  });
});

describe("authFailureCode", () => {
  it("emits stable non-sensitive codes", () => {
    expect(authFailureCode("timeout")).toBe("AUTH_REFRESH_TIMEOUT");
    expect(authFailureCode("network")).toBe("AUTH_REFRESH_NETWORK_ERROR");
    expect(authFailureCode("invalid_refresh")).toBe(
      "AUTH_REFRESH_INVALID_TOKEN",
    );
    expect(authFailureCode("rate_limited")).toBe("AUTH_REFRESH_RATE_LIMITED");
    expect(authFailureCode("anonymous")).toBe("AUTH_CONFIRMED_SIGNED_OUT");
  });
});

describe("withAuthTimeout", () => {
  it("resolves fast promises untouched", async () => {
    await expect(withAuthTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });

  it("rejects a hanging promise with a classifiable timeout error", async () => {
    const hanging = new Promise<never>(() => {});
    const err = await withAuthTimeout(hanging, 10).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(classifyAuthFailure(err)).toBe("timeout");
  });

  it("passes through the original rejection", async () => {
    const boom = new Error("boom");
    await expect(withAuthTimeout(Promise.reject(boom), 50)).rejects.toBe(
      boom,
    );
  });
});
