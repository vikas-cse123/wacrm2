// ============================================================
// Auth failure classification + bounded timeout helper.
//
// Used by the middleware and the client auth provider to tell
// apart:
//
//   A. confirmed unauthenticated — no session, or the server
//      deterministically rejected the token (401/403). Safe to
//      redirect to /login immediately.
//   B. temporary infrastructure failure — timeout, network blip,
//      rate limit, 5xx, or the refresh-token rotation race
//      ("Invalid Refresh Token" from a concurrent request that lost
//      the rotation). Must NEVER convert straight into /login;
//      the request passes through and the client re-verifies.
//
// Supabase config context: JWT expiry 3600s, rotation enabled with
// a 10s reuse interval, refresh rate limit 150/5min/IP. The reuse
// interval absorbs most rotation races server-side; this
// classification covers the remainder app-side. Rotation stays
// enabled — see middleware.ts.
// ============================================================

export type AuthFailureKind =
  /** getUser() resolved with user: null — definitively no session. */
  | "anonymous"
  /** Server rejected the token outright (401/403) — deterministic. */
  | "rejected"
  /** 400 invalid-grant / refresh-not-found — rotation-race signature. */
  | "invalid_refresh"
  /** HTTP 429 (or rate-limit code) — back off, session may recover. */
  | "rate_limited"
  /** HTTP 5xx from the auth backend. */
  | "server_error"
  /** Our own lookup timeout / AbortError / ETIMEDOUT. */
  | "timeout"
  /** Fetch/network-layer failure (no HTTP response at all). */
  | "network"
  /** Anything unrecognized — treated as transient (fail open to the
   *  client verifier, never straight to /login). */
  | "unknown";

interface ErrorShape {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
}

function asShape(err: unknown): ErrorShape {
  if (typeof err !== "object" || err === null) return {};
  const e = err as Record<string, unknown>;
  return { name: e.name, message: e.message, status: e.status, code: e.code };
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Classify a getUser()/auth failure. `null`/`undefined` means the
 * call resolved cleanly with no user — confirmed anonymous.
 * Never throws; unrecognized input maps to "unknown".
 */
export function classifyAuthFailure(err: unknown): AuthFailureKind {
  if (err === null || err === undefined) return "anonymous";

  const { name, message, status, code } = asShape(err);
  const text = `${asText(name)} ${asText(message)} ${asText(code)}`;

  if (
    /timed out|timeout|aborterror|etimedout|timedout/i.test(text) ||
    asText(code) === "ETIMEDOUT"
  ) {
    return "timeout";
  }

  if (
    typeof status === "number" &&
    Number.isFinite(status) &&
    status !== 0
  ) {
    if (status === 429) return "rate_limited";
    if (status >= 500) return "server_error";
    if (status === 401 || status === 403) return "rejected";
    if (status === 400) {
      if (
        /invalid_grant|invalid[^a-z]*refresh|refresh[^a-z]*not[^a-z]*found|expired/i.test(
          text,
        )
      ) {
        return "invalid_refresh";
      }
      // Other 400s from the user endpoint are overwhelmingly grant
      // problems too — pass through and let the client confirm rather
      // than converting a race into a logout.
      return "invalid_refresh";
    }
    return "unknown";
  }

  if (
    /rate[_-]?limit|over[_-]?request|too many requests|429/.test(
      `${text} ${asText(status)}`.toLowerCase(),
    )
  ) {
    return "rate_limited";
  }

  if (
    /fetch failed|failed to fetch|networkerror|network error|network request failed|enotfound|econnrefused|econnreset|eai_again|econnaborted|socket hang up|load failed/i.test(
      text,
    )
  ) {
    return "network";
  }

  if (/invalid[^a-z]*refresh|refresh[^a-z]*not[^a-z]*found|invalid_grant/i.test(text)) {
    return "invalid_refresh";
  }

  return "unknown";
}

/**
 * True only when the session is proven dead: no session at all, or
 * the server deterministically rejected the token. Everything else
 * (timeout, network, rate limit, 5xx, rotation race, unknown) must
 * recover-or-confirm elsewhere, never redirect blindly.
 */
export function isConfirmedUnauthenticated(kind: AuthFailureKind): boolean {
  return kind === "anonymous" || kind === "rejected";
}

/** Stable log code per failure kind — no tokens, no cookies, no PII. */
export function authFailureCode(kind: AuthFailureKind): string {
  switch (kind) {
    case "anonymous":
      return "AUTH_CONFIRMED_SIGNED_OUT";
    case "rejected":
      return "AUTH_TOKEN_REJECTED";
    case "invalid_refresh":
      return "AUTH_REFRESH_INVALID_TOKEN";
    case "rate_limited":
      return "AUTH_REFRESH_RATE_LIMITED";
    case "server_error":
      return "AUTH_REFRESH_SERVER_ERROR";
    case "timeout":
      return "AUTH_REFRESH_TIMEOUT";
    case "network":
      return "AUTH_REFRESH_NETWORK_ERROR";
    case "unknown":
      return "AUTH_REFRESH_UNKNOWN_ERROR";
  }
}

/**
 * Race a promise against a timeout. Rejects with `Error('auth lookup
 * timed out after ${ms}ms')` — a message the classifier recognizes
 * as "timeout". Clears the timer on settle; the underlying promise
 * is left alone (no AbortController — getUser() has no signal).
 */
export function withAuthTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`auth lookup timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    );
  });
}
