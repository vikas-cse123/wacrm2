import { createServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { getAuthCookieOptions } from '@/lib/auth/cookie-options'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Same cookie options as the browser client (domain sharing for
      // apex/www) so server reads and writes stay consistent.
      cookieOptions: getAuthCookieOptions(),
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}

export interface BufferedServerClient {
  /** Supabase SSR client whose auth-cookie writes are buffered, not persisted. */
  client: SupabaseClient
  /** Persist the buffered auth-cookie writes (rotations, intentional clears). */
  commit: () => void
  /** Discard the buffered auth-cookie writes (transient refresh failure). */
  discard: () => void
}

/**
 * Server client with deferred auth-cookie persistence.
 *
 * @supabase/ssr's server adapter writes clearing Set-Cookie headers when
 * a background refresh fails with the access token already expired (it
 * treats the failure as SIGNED_OUT and calls `_removeSession`). A request
 * that merely LOSES a refresh-token rotation race must not wipe the
 * browser's valid session cookie — so auth checks that use this client
 * persist the writes (commit) only when the outcome is authenticated or
 * confirmed unauthenticated, and drop them (discard) on a transient
 * failure. Successful refreshes still commit their rotated tokens; explicit
 * sign-outs still clear cookies (they are client-side operations and don't
 * use this factory).
 */
export async function createBufferedServerClient(): Promise<BufferedServerClient> {
  const cookieStore = await cookies()
  const pending: Array<{ name: string; value: string; options: CookieOptions }> = []

  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: getAuthCookieOptions(),
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            pending.push({ name, value, options })
          })
        },
      },
    }
  )

  return {
    client,
    commit: () => {
      if (pending.length === 0) return
      const writes = pending.splice(0)
      for (const { name, value, options } of writes) {
        try {
          cookieStore.set(name, value, options)
        } catch {
          // Same as createClient — ignore writes from a Server Component.
        }
      }
    },
    discard: () => {
      pending.length = 0
    },
  }
}