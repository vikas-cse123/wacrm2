// ============================================================
// Shared @supabase/ssr auth cookie options (browser + server +
// middleware).
//
// Persistence target: a signed-in session must survive browser
// restart, page refresh, and route navigation for at least 30 days,
// and the apex host (`https://whatsappmax.in`) and its `www`
// subdomain must share ONE session so a user is never "logged out"
// just by reaching the other hostname.
//
// Cookie lifetime: @supabase/ssr's cookie storage ALWAYS enforces
// `DEFAULT_COOKIE_OPTIONS.maxAge` (400 days) on every write
// (`setCookieOptions.maxAge = DEFAULT_COOKIE_OPTIONS.maxAge` in both
// the browser and server adapters), so the cookie survives far longer
// than the 30-day requirement. The Supabase refresh token is the
// long-lived credential; the access token (JWT) keeps its normal
// 1-hour expiry and is refreshed on demand. We deliberately do NOT
// lengthen the access token.
//
// Host sharing: the browser/SSR clients set auth cookies host-only by
// default (no `domain`), so apex and www hold separate sessions. Set
// `NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN` in production to the leading-dot
// registrable domain (e.g. `.whatsappmax.in`) so both hosts share one
// cookie. Leave it unset on localhost/CI — a domain cookie would be
// rejected for a different host. Never set it blindly.
// ============================================================

/** @supabase/ssr's enforced auth-cookie lifetime (400 days). */
export const AUTH_SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** The minimum required persistent-login window (30 days). */
export const MIN_SESSION_PERSISTENCE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Auth cookie options shared by every Supabase client factory.
 *
 * Only `domain` is configurable; `maxAge` is enforced to 400 days by
 * @supabase/ssr itself. Returns `{}` (host-only cookies) when no domain
 * is configured.
 */
export function getAuthCookieOptions(): { domain?: string } {
  const domain = (process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN ?? "").trim();
  return domain ? { domain } : {};
}