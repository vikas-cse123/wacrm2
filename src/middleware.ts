import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import {
  authFailureCode,
  classifyAuthFailure,
  isConfirmedUnauthenticated,
  type AuthFailureKind,
} from '@/lib/auth/auth-errors'
import { getAuthCookieOptions } from '@/lib/auth/cookie-options'

// Bound on the auth round-trip in the middleware. Kept short so a slow
// Supabase auth lookup never wedges a request past Nginx's
// proxy_read_timeout. A timeout here is a TRANSIENT failure (see the
// classification below) — it must never redirect to /login.
const AUTH_LOOKUP_TIMEOUT_MS = 5000

export async function middleware(request: NextRequest) {
  // Public pages - always accessible, signed in or not. This check MUST
  // run before any Supabase call: previously `supabase.auth.getUser()`
  // ran for every request (including the homepage) and only then was the
  // public-path fast path taken. When Supabase auth is slow/unreachable,
  // that awaited network call hangs past Nginx's proxy_read_timeout and
  // every page — including the homepage — returns 504 on every device.
  // Public pages never need auth, so they must never block on it.
  const publicPaths = ['/', '/privacy-policy', '/terms-and-conditions']
  if (publicPaths.includes(request.nextUrl.pathname)) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  // AbortController-based auth timeout. The old implementation raced
  // getUser() against a timer and ABANDONED the promise on timeout.
  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token server-side; an abandoned-but-still-running
  // refresh could consume the old refresh token and write new cookies to
  // an object no response carries, wedging the session (the browser is
  // left holding an already-consumed refresh token with no replacement).
  // Wired into the client's global fetch, aborting actually CANCELS the
  // in-flight request: if it never reached Supabase, no rotation happens;
  // if it did, Supabase's refresh-token reuse interval (10s) lets the next
  // request succeed with the old token. getUser() settles (throws) at the
  // deadline instead of lingering, so a slow-but-successful refresh can no
  // longer deliver rotated cookies that go nowhere.
  const authController = new AbortController()
  const authTimer = setTimeout(() => authController.abort(), AUTH_LOOKUP_TIMEOUT_MS)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Same cookie options as the browser/server clients so apex and www
      // share one session when NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN is set.
      cookieOptions: getAuthCookieOptions(),
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: authController.signal,
          }),
      },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Refresh tokens are single-use. When several requests fire close
  // together (a page nav plus its data fetches, or several tabs), more
  // than one of them can read the SAME not-yet-rotated refresh token
  // from cookies before any of them has written the new one back. The
  // first request to reach Supabase wins and gets a new token pair; the
  // others present an already-consumed refresh token and getUser()
  // throws (AuthApiError: Invalid Refresh Token: Refresh Token Not
  // Found). Rotation stays enabled (with its 10s server-side reuse
  // interval); the app side handles the losers below instead of
  // treating them as logged out.
  //
  // Failure handling distinguishes two cases (see
  // src/lib/auth/auth-errors.ts):
  //   A. confirmed unauthenticated — getUser() resolved user:null, or
  //      the server deterministically rejected the token (401/403).
  //      These redirect to /login exactly as before.
  //   B. temporary infrastructure failure — lookup timeout (now a real
  //      abort, so the refresh can't linger and consume a token without
  //      delivering cookies), network blip, rate limit, 5xx, or the
  //      rotation race above. These PASS THROUGH untouched: the
  //      dashboard shell (client) holds a session of its own and
  //      re-verifies with a bounded check before ever redirecting — a
  //      single slow request must not decide the user's fate. This is
  //      safe: downstream server code still enforces auth per-request
  //      (RLS everywhere), and a truly dead session fails the client
  //      check within seconds.
  let user = null
  let failure: AuthFailureKind | null = null
  try {
    const { data } = await supabase.auth.getUser()
    const resolved = data.user
    if (resolved) {
      user = resolved
    } else {
      failure = 'anonymous'
    }
  } catch (err) {
    failure = classifyAuthFailure(err)
    // Log codes only — never tokens, cookies, or error internals that
    // could carry credential fragments.
    console.warn('[auth] middleware auth failure', {
      code: authFailureCode(failure),
      path: request.nextUrl.pathname,
    })
  } finally {
    clearTimeout(authTimer)
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login only when the session is
  // proven dead (case A above). On transient failures the request
  // passes through so the client can recover in place.
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/followups', '/qr-codes', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    if (failure !== null && !isConfirmedUnauthenticated(failure)) {
      return supabaseResponse
    }
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}