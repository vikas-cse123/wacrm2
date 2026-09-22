import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `mockFailure`      — when set, getUser() throws it instead of resolving
//                      (timeout / rotation race / rejected token / 429).
// `mockHangForever`  — getUser() never settles (drives the 5s timeout
//                      via fake timers).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let mockFailure: unknown = null;
let mockHangForever = false;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

function authApiError(message: string, status: number, code: string) {
  const err = new Error(message) as Error & { status: number; code: string };
  err.name = "AuthApiError";
  err.status = status;
  err.code = code;
  return err;
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (mockHangForever) await new Promise<never>(() => {});
        if (mockFailure) throw mockFailure;
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  mockFailure = null;
  mockHangForever = false;
  refreshedCookies = [];
  vi.useRealTimers();
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
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

  it("passes through on the refresh-token rotation race (400 invalid refresh)", async () => {
    mockFailure = authApiError(
      "Invalid Refresh Token: Refresh Token Not Found",
      400,
      "invalid_grant",
    );

    const res = await middleware(new NextRequest("https://app.test/inbox"));

    // The losing request must not log the user out: the winner holds
    // fresh cookies and the client confirms on its side.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
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

  it("keeps the 401 JSON behavior for protected API routes on any failure", async () => {
    mockFailure = authApiError(
      "Invalid Refresh Token: Refresh Token Not Found",
      400,
      "invalid_grant",
    );
    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/send"),
    );
    expect(res.status).toBe(401);
  });
});
