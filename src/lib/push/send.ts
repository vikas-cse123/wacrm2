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
 * Reliability hardening (see the investigation):
 *   - Retry/backoff: 429/5xx/network failures get a small bounded
 *     number of retries with exponential backoff + jitter. 404/410,
 *     401/403, timeouts and other permanent/unknown errors are never
 *     retried.
 *   - Cleanup: 404/410 are pruned (the push service says the endpoint
 *     is gone). 401/403 are pruned ONLY when another subscription in
 *     the same fan-out delivered successfully (the odd one out → the
 *     subscription is stale); when every subscription fails with
 *     401/403 the likely cause is a server-wide VAPID/config problem,
 *     so rows are kept and logged.
 *   - Successful sends update `last_used_at` (batched) so the database
 *     reflects real delivery attempts.
 *   - Consecutive transient/timeout failures are tracked in-process for
 *     diagnostics (a "suspected dead" warning), but are NEVER auto-
 *     deleted: a transient error does not prove the subscription is
 *     gone, and deleting during a push-service outage would drop healthy
 *     devices. The push service's own 404/410 is the authoritative
 *     "gone" signal and is pruned.
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

// Bounded retry budget for transient push-service failures.
const PUSH_MAX_RETRIES = 2
const PUSH_RETRY_BASE_MS = 250
// Consecutive transient/timeout failures (in-process) after which we log
// a "suspected dead" diagnostic. Rows are never auto-deleted on transient
// errors (see file header).
const PUSH_STALE_FAIL_THRESHOLD = 10

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

// ---------------------------------------------------------------------------
// Failure classification (pure, exported for tests).
// ---------------------------------------------------------------------------

export type SendErrorKind =
  | 'ok'
  | 'dead' // 404/410 — push service says the endpoint is gone
  | 'invalid' // 401/403 — endpoint-specific auth/VAPID rejection
  | 'transient' // 429/5xx/network — retryable
  | 'timeout' // per-request timeout — kept, not retried (bounds webhook latency)
  | 'error'; // anything else — kept

export interface ClassifiedSendError {
  kind: SendErrorKind
  status?: number
}

/**
 * Classify a web-push send error. web-push throws `WebPushError` (with a
 * `statusCode`) for HTTP failures and a plain `Error` for network/timeout.
 * Exported for unit tests.
 */
export function classifySendError(err: unknown): ClassifiedSendError {
  const status =
    typeof err === 'object' && err !== null && 'statusCode' in err
      ? (err as { statusCode?: unknown }).statusCode
      : undefined
  const numericStatus = typeof status === 'number' ? status : undefined

  if (numericStatus === 404 || numericStatus === 410) {
    return { kind: 'dead', status: numericStatus }
  }
  if (numericStatus === 401 || numericStatus === 403) {
    return { kind: 'invalid', status: numericStatus }
  }
  if (numericStatus === 429 || (numericStatus !== undefined && numericStatus >= 500)) {
    return { kind: 'transient', status: numericStatus }
  }

  const text = err instanceof Error ? err.message : String(err)
  if (/socket timeout|timed? ?out|abort|timeout/i.test(text)) {
    return { kind: 'timeout' }
  }
  if (
    /fetch failed|failed to fetch|network|econnreset|econnrefused|enotfound|eai_again|socket hang up|load failed/i.test(
      text,
    )
  ) {
    return { kind: 'transient' }
  }
  return { kind: 'error' }
}

/** Exponential backoff with jitter for a retry attempt (0-based). */
export function retryDelayMs(attempt: number): number {
  const exp = PUSH_RETRY_BASE_MS * 2 ** attempt
  return Math.floor(exp + Math.random() * 100)
}

type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'dead'; status: number }
  | { kind: 'invalid'; status: number }
  | { kind: 'kept'; reason: 'transient' | 'timeout' | 'error'; detail: string }

// In-process consecutive-failure tracker (diagnostics only — never used to
// auto-delete; see file header).
const consecutiveFailures = new Map<string, number>()

function bumpFailure(id: string): number {
  const n = (consecutiveFailures.get(id) ?? 0) + 1
  consecutiveFailures.set(id, n)
  return n
}

function resetFailures(id: string): void {
  consecutiveFailures.delete(id)
}

/**
 * Send to ONE subscription, bounded + timed, with bounded retry/backoff for
 * transient (429/5xx/network) failures. 404/410, 401/403, timeouts and
 * other errors are never retried. Pure fan-out helper — one sub's outcome
 * never affects the others.
 */
async function sendToSubscription(
  row: SubscriptionRow,
  body: string,
): Promise<SendOutcome> {
  const id = shortDeviceId(row.id)
  const startedAt = Date.now()
  console.log(`[push] sub ${id} send start at ${new Date(startedAt).toISOString()}`)

  let attempt = 0
  for (;;) {
    const attemptStart = Date.now()
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
      const ms = Date.now() - attemptStart
      console.log(`[push] sub ${id} send ok in ${ms}ms`)
      resetFailures(id)
      return { kind: 'ok' }
    } catch (err) {
      const { kind, status } = classifySendError(err)
      const ms = Date.now() - attemptStart

      if (kind === 'dead') {
        console.warn(`[push] sub ${id} dead (${status}) in ${ms}ms — pruning`)
        return { kind: 'dead', status: status ?? 0 }
      }
      if (kind === 'invalid') {
        console.warn(`[push] sub ${id} invalid (${status}) in ${ms}ms`)
        return { kind: 'invalid', status: status ?? 0 }
      }
      if (kind === 'timeout') {
        const n = bumpFailure(id)
        console.error(
          `[push] sub ${id} timeout in ${ms}ms — kept (not retried to bound webhook latency)${n >= PUSH_STALE_FAIL_THRESHOLD ? ' — SUSPECTED DEAD (consecutive failures)' : ''}`,
        )
        return { kind: 'kept', reason: 'timeout', detail: `timeout (${ms}ms)` }
      }
      if (kind === 'transient' && attempt < PUSH_MAX_RETRIES) {
        const delay = retryDelayMs(attempt)
        attempt += 1
        console.warn(
          `[push] sub ${id} transient (${status ?? 'network'}) in ${ms}ms — retry ${attempt}/${PUSH_MAX_RETRIES} in ${delay}ms`,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      const n = bumpFailure(id)
      const detail = status ? `status ${status}` : err instanceof Error ? err.message : String(err)
      const reason = kind === 'transient' ? 'transient' : 'error'
      console.error(
        `[push] sub ${id} send failed in ${ms}ms: ${detail}${n >= PUSH_STALE_FAIL_THRESHOLD ? ' — SUSPECTED DEAD (consecutive failures)' : ''}`,
      )
      return { kind: 'kept', reason, detail }
    }
  }
}

/**
 * Fan out a payload to a list of subscriptions: send all concurrently,
 * prune definitively-dead rows (404/410), prune 401/403 rows only when the
 * rest of the fan-out delivered (odd one out), and bump `last_used_at` for
 * successful sends. Never throws.
 */
async function fanOutSubscriptions(subs: SubscriptionRow[], body: string): Promise<void> {
  const outcomes = await Promise.allSettled(
    subs.map(async (row) => ({ row, outcome: await sendToSubscription(row, body) })),
  )

  const deadIds: string[] = []
  const invalidIds: string[] = []
  const successIds: string[] = []
  let sentCount = 0
  let failedCount = 0

  for (const settled of outcomes) {
    if (settled.status !== 'fulfilled') {
      failedCount += 1
      continue
    }
    const { row, outcome } = settled.value
    if (outcome.kind === 'ok') {
      successIds.push(row.id)
      sentCount += 1
    } else if (outcome.kind === 'dead') {
      deadIds.push(row.id)
      failedCount += 1
    } else if (outcome.kind === 'invalid') {
      invalidIds.push(row.id)
      failedCount += 1
    } else {
      failedCount += 1
    }
  }

  const prune = async (ids: string[], reason: string) => {
    const { error: delErr } = await supabaseAdmin()
      .from('push_subscriptions')
      .delete()
      .in('id', ids)
    if (delErr) {
      console.error(`[push] failed to prune ${reason} subscriptions:`, delErr.message)
    } else {
      console.warn(`[push] pruned ${ids.length} ${reason} subscription(s)`)
    }
  }

  if (deadIds.length > 0) {
    await prune(deadIds, 'dead')
  }

  if (invalidIds.length > 0) {
    if (sentCount > 0) {
      // The odd one(s) out: at least one other device delivered, so a
      // 401/403 here is endpoint-specific (stale subscription) — prune it.
      await prune(invalidIds, 'invalid')
    } else {
      // No subscription delivered — a server-wide VAPID/config problem is
      // the likely cause. Keep the rows and log loudly instead of deleting
      // every device.
      console.error(
        `[push] ${invalidIds.length} subscription(s) failed with 401/403 and none delivered — possible server-wide VAPID/configuration problem; rows kept`,
      )
    }
  }

  if (successIds.length > 0) {
    const { error: touchErr } = await supabaseAdmin()
      .from('push_subscriptions')
      .update({ last_used_at: new Date().toISOString() })
      .in('id', successIds)
    if (touchErr) {
      console.error('[push] failed to touch last_used_at:', touchErr.message)
    }
  }

  console.log(
    `[push] fan-out done sent=${sentCount} failed=${failedCount} dead=${deadIds.length} invalid=${invalidIds.length} last_used=${successIds.length}`,
  )
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
 * - Dead subscriptions (404/410) are pruned; 401/403 subscriptions are
 *   pruned only when the rest of the fan-out delivered.
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

    await fanOutSubscriptions(subs, body)

    console.log(
      `[push] dispatch done account=${accountId} in ${Date.now() - dispatchStart}ms at ${new Date().toISOString()}`,
    )
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

    await fanOutSubscriptions(data as SubscriptionRow[], body)

    console.log(
      `[push] user dispatch done user=${userId} in ${Date.now() - dispatchStart}ms at ${new Date().toISOString()}`,
    )
  } catch (err) {
    console.error('[push] unexpected error during user push:', err)
  }
}