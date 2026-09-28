import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthCookieOptions } from '@/lib/auth/cookie-options'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

export function createClient() {
  if (browserClient) return browserClient

  // Persistent session configuration:
  //   persistSession  – session survives browser restart (stored in cookies
  //                     with @supabase/ssr's 400-day max-age).
  //   autoRefreshToken– the access token is silently refreshed from the
  //                     long-lived refresh token when it nears expiry, so the
  //                     user never needs to log in again just because the
  //                     1-hour JWT expired.
  //   detectSessionInUrl – PKCE callback processing on the auth redirect.
  //   cookieOptions   – host-only by default; set
  //                     NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN (e.g.
  //                     ".whatsappmax.in") in production so the apex and www
  //                     hosts share one session instead of splitting.
  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: getAuthCookieOptions(),
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  )

  return browserClient
}