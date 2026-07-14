import webpush from 'web-push'
import { supabaseAdmin } from './admin-client'

/**
 * Web Push fan-out.
 *
 * When a new inbound message lands, the webhook calls
 * `sendPushToAccount` to notify every member of the account who has a
 * push subscription (i.e. who turned notifications on for a device).
 *
 * VAPID keys are read from the environment. If they're absent the whole
 * feature no-ops cleanly — the app still works, it just doesn't push.
 */

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY
// A `mailto:` (or https) contact is required by the Web Push spec so
// push services can reach the sender about problems.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com'

let configured = false

/** True when VAPID keys are present so pushes can actually be sent. */
export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC && VAPID_PRIVATE)
}

function ensureConfigured(): boolean {
  if (!isPushConfigured()) return false
  if (!configured) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC!, VAPID_PRIVATE!)
    configured = true
  }
  return true
}

export interface PushPayload {
  title: string
  body: string
  /** Where clicking the notification should take the user. */
  url?: string
  /** Groups/replaces notifications from the same conversation. */
  tag?: string
}

/**
 * Trims a message preview to a notification-friendly length without
 * cutting a word mid-way when avoidable. Pure + exported for tests.
 */
export function buildPreview(text: string | null | undefined, max = 120): string {
  if (!text) return ''
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const slice = trimmed.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice
  return `${cut.trimEnd()}…`
}

interface SubscriptionRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Sends a push to every subscription belonging to members of `accountId`.
 *
 * - Fire-and-forget from the caller's perspective: never throws; all
 *   errors are logged. A push failure must not break webhook ingestion.
 * - Dead subscriptions (404/410 from the push service) are pruned so
 *   they don't accumulate.
 * - `excludeUserId` skips a member (e.g. don't notify the agent who is
 *   the actor of the event).
 */
export async function sendPushToAccount(
  accountId: string,
  payload: PushPayload,
  opts: { excludeUserId?: string } = {},
): Promise<void> {
  if (!ensureConfigured()) {
    console.warn('[push] VAPID keys not configured — skipping push')
    return
  }

  console.log('[push] sending to account', accountId, 'payload:', payload.title)

  try {
    let query = supabaseAdmin()
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, user_id')
      .eq('account_id', accountId)

    if (opts.excludeUserId) {
      query = query.neq('user_id', opts.excludeUserId)
    }

    const { data, error } = await query

    if (error) {
      console.error('[push] failed to load subscriptions:', error.message)
      return
    }
    if (!data || data.length === 0) {
      console.warn('[push] no subscriptions found for account', accountId)
      return
    }

    console.log('[push] found', data.length, 'subscription(s) for account', accountId)

    const body = JSON.stringify(payload)
    const deadIds: string[] = []
    let sentCount = 0

    await Promise.all(
      (data as (SubscriptionRow & { user_id: string })[]).map(async (row) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            body,
          )
          sentCount++
          console.log('[push] sent OK to', row.endpoint.slice(0, 60) + '...')
        } catch (err: unknown) {
          const statusCode =
            typeof err === 'object' && err !== null && 'statusCode' in err
              ? (err as { statusCode?: number }).statusCode
              : undefined
          if (statusCode === 404 || statusCode === 410) {
            console.warn('[push] dead subscription (', statusCode, ') pruning', row.id)
            deadIds.push(row.id)
          } else {
            console.error('[push] send failed:', statusCode ?? err)
          }
        }
      }),
    )

    console.log('[push] done — sent:', sentCount, 'dead:', deadIds.length)

    if (deadIds.length > 0) {
      const { error: delErr } = await supabaseAdmin()
        .from('push_subscriptions')
        .delete()
        .in('id', deadIds)
      if (delErr) {
        console.error('[push] failed to prune dead subscriptions:', delErr.message)
      }
    }
  } catch (err) {
    console.error('[push] unexpected error during fan-out:', err)
  }
}

/**
 * Sends a push to a single user's devices only.
 *
 * Used when a conversation is assigned to a specific agent — only that
 * agent should receive the notification, not the entire account.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  if (!ensureConfigured()) {
    console.warn('[push] VAPID keys not configured — skipping push')
    return
  }

  console.log('[push] sending to user', userId, 'payload:', payload.title)

  try {
    const { data, error } = await supabaseAdmin()
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', userId)

    if (error) {
      console.error('[push] failed to load subscriptions for user:', error.message)
      return
    }
    if (!data || data.length === 0) {
      console.warn('[push] no subscriptions found for user', userId)
      return
    }

    console.log('[push] found', data.length, 'subscription(s) for user', userId)

    const body = JSON.stringify(payload)
    const deadIds: string[] = []
    let sentCount = 0

    await Promise.all(
      (data as SubscriptionRow[]).map(async (row) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            body,
          )
          sentCount++
        } catch (err: unknown) {
          const statusCode =
            typeof err === 'object' && err !== null && 'statusCode' in err
              ? (err as { statusCode?: number }).statusCode
              : undefined
          if (statusCode === 404 || statusCode === 410) {
            deadIds.push(row.id)
          } else {
            console.error('[push] send failed:', statusCode ?? err)
          }
        }
      }),
    )

    console.log('[push] user push done — sent:', sentCount, 'dead:', deadIds.length)

    if (deadIds.length > 0) {
      const { error: delErr } = await supabaseAdmin()
        .from('push_subscriptions')
        .delete()
        .in('id', deadIds)
      if (delErr) {
        console.error('[push] failed to prune dead subscriptions:', delErr.message)
      }
    }
  } catch (err) {
    console.error('[push] unexpected error during user push:', err)
  }
}
