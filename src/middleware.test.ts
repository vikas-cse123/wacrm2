import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`             — what getUser() resolves to (a refreshed session ⇒ user,
//                          or null for the logged-out path).
// `mockFailure`          — when set, getUser() fails. An AuthApiError (has
//                          `__isAuthError: true`) RESOLVES with
//                          `{ data: { user: null }, error }` — mirroring real
//                          auth-js, which catches AuthApiErrors and resolves
//                          instead of throwing. Non-auth failures (network /
//                          timeout) THROW, as real auth-js does.
// `mockClearsOnFailure`  — when a failing refresh also removed the local
//                          session, @supabase/ssr writes CLEARING cookies via
//                          setAll(). Drives the "no clearing on transient"
//                          assertions.
// `mockHangForever`      — getUser() never settles (drives the 5s timeout
//                          via fake timers).
// `refreshedCookies`     — cookies Supabase writes via setAll() during getUser(),
//                          i.e. the freshly *rotated* auth token. The whole point
//                          of the test is that these must survive onto whatever
//                          response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let mockFailure: unknown = null;
let mockClearsOnFailure = false;
let mockHangForever = false;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];
// The `global.fetch` wrapper the middleware wires up (bound to its
// AbortController). Captured so tests can prove the auth timeout is a
// real abort, not an abandoned promise.
let capturedGlobalFetch:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | undefined;

function authApiError(message: string, status: number, code: string) {
  const err = new Error(message) as Error & {
    status: number;
    code: string;
    __isAuthError?: boolean;
  };
  err.name = "AuthApiError";
  err.status = status;
  err.code = code;
  // Real auth-js AuthApiErrors resolve (not throw) out of getUser().
  err.__isAuthError = true;
  return err;
}

function authSessionMissingError() {
  const err = new Error("Auth session missing!") as Error & {
    __isAuthError?: boolean;
  };
  err.name = "AuthSessionMissingError";
  err.__isAuthError = true;
  return err;
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      global?: { fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => {
    capturedGlobalFetch = opts.global?.fetch;
    return {
      auth: {
        // Mirrors real auth-js: an expired access token is transparently
        // refreshed inside getUser(), which rotates the refresh token and
        // pushes the new cookies through setAll() before resolving.
        // AuthApiError refresh failures RESOLVE with { user: null, error }
        // (they never throw); network/timeout failures throw.
        getUser: async () => {
          if (mockHangForever) {
            // Real auth-js rejects when the middleware aborts the
            // underlying fetch at the deadline (AbortError). Mimic that
            // so the middleware settles and classifies it as a timeout.
            await new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    Object.assign(new Error("This operation was aborted"), {
                      name: "AbortError",
                    }),
                  ),
                5_000,
              ),
            );
          }
          if (mockFailure) {
            if ((mockFailure as { __isAuthError?: boolean }).__isAuthError) {
              // A failed refresh with an already-expired access token
              // removes the local session and writes clearing cookies.
              if (mockClearsOnFailure) {
                opts.cookies.setAll([CLEARING_COOKIE]);
              }
              return { data: { user: null }, error: mockFailure };
            }
            throw mockFailure;
          }
          if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
          return { data: { user: mockUser } };
        },
      },
    };
  },
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  mockFailure = null;
  mockClearsOnFailure = false;
  mockHangForever = false;
  refreshedCookies = [];
  capturedGlobalFetch = undefined;
  vi.useRealTimers();
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

const CLEARING_COOKIE = {
  name: "sb-test-auth-token",
  value: "",
  options: { path: "/", httpOnly: true, maxAge: 0 },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — getUser() resolved auth errors are classified, never discarded", () => {
  it("does NOT redirect on a resolved refresh-token rotation race (400 invalid refresh)", async () => {
    // Real auth-js RESOLVES getUser() with { user: null, error } on this
    // failure — it never throws. The old middleware discarded the error,
    // classified the null as 'anonymous' and redirected to /login.
    mockFailure = authApiError(
      "Invalid Refresh Token: Refresh Token Not Found",
      400,
      "invalid_grant",
    );
    mockClearsOnFailure = true;

    const res = await middleware(new NextRequest("https://app.test/inbox"));

    // The losing request must not log the user out: the winner holds
    // fresh cookies and the client confirms on its side.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("does NOT forward the SDK's clearing cookie on a resolved rotation race", async () => {
    mockFailure = authApiError(
      "Invalid Refresh Token: Refresh Token Not Found",
      400,
      "invalid_grant",
    );
    mockClearsOnFailure = true;

    const res = await middleware(new NextRequest("https://app.test/inbox"));

    // The failed refresh removed the local session server-side (the SDK
    // wrote a clearing Set-Cookie); a transient race must never propagate
    // that wipe to the browser's still-valid session cookie.
    expect(res.cookies.get(CLEARING_COOKIE.name)).toBeUndefined();
  });

  it("does NOT redirect on a resolved invalid_grant error", async () => {
    mockFailure = authApiError("invalid_grant: token revoked", 400, "invalid_grant");

    const res = await middleware(new NextRequest("https://app.test/inbox"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("still redirects on AuthSessionMissingError (confirmed absence)", async () => {
    mockFailure = authSessionMissingError();
    mockClearsOnFailure = true;

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    // No session at all is a confirmed absence — clean redirect, and the
    // cleanup clear is fine to persist.
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(CLEARING_COOKIE.name)?.value).toBe("");
  });
});

describe("middleware — transient auth failures never redirect to /login", () => {
  it("passes a protected page through on getUser() timeout", async () => {
    vi.useFakeTimers();
    mockHangForever = true;
    try {
      const pending = middleware(new NextRequest("https://app.test/inbox"));
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await pending;
      // No redirect: a slow lookup must not decide the user's fate.
      // The client shell re-verifies with its own session instead.
      expect(res.headers.get("location")).toBeNull();
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the auth timeout is a REAL fetch abort, not an abandoned promise", async () => {
    // The middleware wires its AbortController into the client's global
    // fetch. After the deadline the controller is aborted, so the same
    // wrapper used for a pending refresh rejects instead of lingering —
    // an orphaned refresh can no longer consume a token whose rotated
    // cookies go nowhere.
    vi.useFakeTimers();
    mockHangForever = true;
    try {
      const pending = middleware(new NextRequest("https://app.test/inbox"));
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await pending;
      expect(res.headers.get("location")).toBeNull();
      expect(capturedGlobalFetch).toBeTypeOf("function");
      if (capturedGlobalFetch) {
        await expect(
          capturedGlobalFetch("https://test.supabase.co/auth/v1/token", {
            method: "POST",
            body: "{}",
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes through on rate limiting and server errors", async () => {
    mockFailure = authApiError("Too many requests", 429, "over_request_rate_limit");
    const rateLimited = await middleware(
      new NextRequest("https://app.test/contacts"),
    );
    expect(rateLimited.headers.get("location")).toBeNull();

    mockFailure = authApiError("Bad gateway", 502, "bad_gateway");
    const serverError = await middleware(
      new NextRequest("https://app.test/contacts"),
    );
    expect(serverError.headers.get("location")).toBeNull();
  });

  it("still redirects on deterministic rejection (401) and confirmed anonymous", async () => {
    mockFailure = authApiError("invalid JWT", 401, "invalid_jwt");
    const rejected = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );
    expect(rejected.headers.get("location")).toContain("/login");

    mockFailure = null;
    mockUser = null;
    const anonymous = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );
    expect(anonymous.headers.get("location")).toContain("/login");
  });

  it("passes protected API routes through on a transient failure (route returns 503)", async () => {
    mockFailure = authApiError(
      "Invalid Refresh Token: Refresh Token Not Found",
      400,
      "invalid_grant",
    );
    mockClearsOnFailure = true;
    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/send"),
    );
    // Transient — the middleware no longer short-circuits a 401; the route
    // handler's own classified auth check returns 503 for the blip.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
    expect(res.cookies.get(CLEARING_COOKIE.name)).toBeUndefined();
  });

  it("keeps the 401 JSON behavior for protected API routes on confirmed anonymous", async () => {
    mockFailure = null;
    mockUser = null;
    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/send"),
    );
    expect(res.status).toBe(401);
  });
});