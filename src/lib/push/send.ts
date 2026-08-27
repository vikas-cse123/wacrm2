import webpush from 'web-push'
import { supabaseAdmin } from './admin-client'

/**
 * Web Push fan-out.
 *
 * When a new inbound message lands, the webhook calls
 * `sendPushToAccount` to notify every member of the account who has a
 * push subscription (i.e. who turned notifications on for a device).
 *
 * Delivery model — why this file looks the way it does:
 *   - Every subscription is dispatched IMMEDIATELY and CONCURRENTLY
 *     (`Promise.allSettled` over all rows). A slow/failed subscription
 *     on one device can never delay the other devices' notifications.
 *   - Each individual push-service round trip is BOUNDED by
 *     `PUSH_REQUEST_TIMEOUT_MS` (default 10s). Without this, a push
 *     service that accepts the TCP connection but never answers holds
 *     the HTTPS request open for the OS-level socket timeout (~2
 *     minutes), which is exactly the kind of "one device gets it
 *     minutes later" symptom we're hardening against.
 *   - `urgency: 'high'` asks FCM/APNs to prioritise the message instead
 *     of batching it, keeping delivery as close to real-time as the
 *     provider allows.
 *   - Timing logs (dispatch start, per-subscription send start/end,
 *     latency) are emitted on every fan-out so server-side vs
 *     device-side delay can be told apart from the logs alone. The
 *     payload also carries a `sentAt` watermark the service worker logs
 *     as "server → device" latency.
 *
 * VAPID keys are read from the environment. If they're absent the whole
 * feature no-ops cleanly — the app still works, it just doesn't push.
 */

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY
// A `mailto:` (or https) contact is required by the Web Push spec so
// push services can reach the sender about problems.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com'

// Per-subscription HTTP round-trip budget. Default 10s — generous for a
// healthy push service (<1s typical) but short enough that a hung one
// can't pin the server for minutes. Tune via env if a deployment's
// push service is unusually slow.
const PUSH_REQUEST_TIMEOUT_MS = Number(
  process.env.PUSH_REQUEST_TIMEOUT_MS || '10000',
)

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
  user_id: string
}

/** Short, stable, safe device identifier for logs — never the full endpoint. */
export function shortDeviceId(id: string): string {
  return id.slice(0, 8)
}

type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'dead'; status: number }
  | { kind: 'error'; detail: string }

/**
 * Send to ONE subscription, bounded + timed. The `timeout` option makes
 * `webpush.sendNotification` destroy the request if the push service
 * doesn't answer in time, so a hung subscription fails fast instead of
 * holding the process for minutes. Pure fan-out helper — one sub's
 * outcome never affects the others.
 */
async function sendToSubscription(
  row: SubscriptionRow,
  body: string,
): Promise<SendOutcome> {
  const id = shortDeviceId(row.id)
  const startedAt = Date.now()
  console.log(`[push] sub ${id} send start at ${new Date(startedAt).toISOString()}`)

  try {
    await webpush.sendNotification(
      {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      },
      body,
      // `urgency: 'high'` asks the push service to deliver promptly;
      // `timeout` bounds the round trip (see file header).
      { timeout: PUSH_REQUEST_TIMEOUT_MS, urgency: 'high' },
    )
    const ms = Date.now() - startedAt
    console.log(`[push] sub ${id} send ok in ${ms}ms`)
    return { kind: 'ok' }
  } catch (err) {
    const ms = Date.now() - startedAt
    const statusCode =
      typeof err === 'object' && err !== null && 'statusCode' in err
        ? (err as { statusCode?: number }).statusCode
        : undefined
    if (statusCode === 404 || statusCode === 410) {
      // Push service says this subscription no longer exists — prune it
      // so it doesn't accumulate. A dead row never blocks live devices.
      console.warn(`[push] sub ${id} dead (${statusCode}) in ${ms}ms — pruning`)
      return { kind: 'dead', status: statusCode }
    }
    const detail = statusCode
      ? `status ${statusCode}`
      : err instanceof Error
        ? err.message
        : String(err)
    console.error(`[push] sub ${id} send failed in ${ms}ms: ${detail}`)
    return { kind: 'error', detail }
  }
}

/**
 * Send one notification to every subscription that belongs to a member
 * of `accountId`.
 *
 * - Fire-and-forget from the caller's perspective: never throws; all
 *   errors are logged. A push failure must not break webhook ingestion.
 * - All subscriptions are sent concurrently (`Promise.allSettled`); a
 *   slow, failed, or hanging subscription on one device cannot delay or
 *   block any other device.
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

  const dispatchStart = Date.now()
  console.log(
    `[push] dispatch start account=${accountId} payload="${payload.title}" at ${new Date(dispatchStart).toISOString()}`,
  )

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
    // Fallback for stale rows: subscriptions created before the admin-
    // client fix (pre-2253029) or after an account switch may have a
    // mismatched `account_id`. If the direct `account_id` lookup is
    // empty, resolve current members and query by `user_id` instead.
    // This restores delivery without requiring the user to toggle
    // Settings off/on. Purely additive — the hot path (correct
    // account_id) never hits the fallback.
    let subs = data as SubscriptionRow[] | null
    if (!subs || subs.length === 0) {
      console.warn('[push] no subscriptions found for account', accountId, '— trying member fallback')
      const { data: members } = await supabaseAdmin()
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
      const memberIds = (members ?? []).map((m: { user_id: string }) => m.user_id)
      if (memberIds.length > 0) {
        const { data: fb, error: fbErr } = await supabaseAdmin()
          .from('push_subscriptions')
          .select('id, endpoint, p256dh, auth, user_id')
          .in('user_id', memberIds)
        if (!fbErr && fb && fb.length > 0) {
          console.warn('[push] fallback found', fb.length, 'subscription(s) via member user_ids')
          subs = fb as SubscriptionRow[]
        }
      }
    }
    if (!subs || subs.length === 0) {
      console.warn('[push] no subscriptions found for account', accountId, '(even after fallback)')
      return
    }

    console.log('[push] found', subs.length, 'subscription(s) for account', accountId)

    // Watermark every payload with the server send time so the service
    // worker can log server→device latency (distinguishes "server sent
    // late" from "device displayed late").
    const body = JSON.stringify({ ...payload, sentAt: new Date().toISOString() })

    const outcomes = await Promise.allSettled(
      subs.map(async (row) => ({
        row,
        outcome: await sendToSubscription(row, body),
      })),
    )

    const deadIds: string[] = []
    let sentCount = 0
    let failedCount = 0
    for (const settled of outcomes) {
      if (settled.status !== 'fulfilled') {
        failedCount += 1
        continue
      }
      const { row, outcome } = settled.value
      if (outcome.kind === 'ok') {
        sentCount += 1
      } else if (outcome.kind === 'dead') {
        deadIds.push(row.id)
        failedCount += 1
      } else {
        failedCount += 1
      }
    }

    const totalMs = Date.now() - dispatchStart
    console.log(
      `[push] dispatch done account=${accountId} sent=${sentCount} failed=${failedCount} dead=${deadIds.length} in ${totalMs}ms at ${new Date().toISOString()}`,
    )

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
 * Used when a notification is targeted at a specific agent rather than
 * the whole account. Same bounded, concurrent, independently-failing
 * behaviour as `sendPushToAccount`.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  if (!ensureConfigured()) {
    console.warn('[push] VAPID keys not configured — skipping push')
    return
  }

  const dispatchStart = Date.now()
  console.log(
    `[push] dispatch start user=${userId} payload="${payload.title}" at ${new Date(dispatchStart).toISOString()}`,
  )

  try {
    const { data, error } = await supabaseAdmin()
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, user_id')
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

    const body = JSON.stringify({ ...payload, sentAt: new Date().toISOString() })

    const outcomes = await Promise.allSettled(
      (data as SubscriptionRow[]).map(async (row) => ({
        row,
        outcome: await sendToSubscription(row, body),
      })),
    )

    const deadIds: string[] = []
    let sentCount = 0
    let failedCount = 0
    for (const settled of outcomes) {
      if (settled.status !== 'fulfilled') {
        failedCount += 1
        continue
      }
      const { row, outcome } = settled.value
      if (outcome.kind === 'ok') {
        sentCount += 1
      } else if (outcome.kind === 'dead') {
        deadIds.push(row.id)
        failedCount += 1
      } else {
        failedCount += 1
      }
    }

    const totalMs = Date.now() - dispatchStart
    console.log(
      `[push] user dispatch done user=${userId} sent=${sentCount} failed=${failedCount} dead=${deadIds.length} in ${totalMs}ms at ${new Date().toISOString()}`,
    )

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