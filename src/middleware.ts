import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
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
  // Found). Left uncaught, that throw escapes the middleware mid-request
  // and can leave the response in a malformed state. Treat a failed
  // refresh as "not authenticated for this request" instead of letting
  // it bubble — the request that actually won the race will refresh the
  // session, and the next request from this same client will pick up
  // the new cookies normally.
  let user = null
  try {
    // Bound the auth round-trip. When Supabase auth is slow or the
    // VPS→Supabase path is degraded, `getUser()` can hang (the Edge
    // sandbox's fetch has no built-in timeout) and wedge the request
    // past Nginx's proxy_read_timeout → 504 on every page. Failing fast
    // to "not authenticated" lets protected pages redirect to /login
    // (which loads without auth) instead of hanging the site.
    const userOrTimeout = await Promise.race([
      supabase.auth.getUser(),
      new Promise<{ data: { user: null } }>((_, reject) =>
        setTimeout(() => reject(new Error('auth lookup timed out')), 5_000)
      ),
    ])
    user = userOrTimeout.data.user
  } catch {
    user = null
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

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
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