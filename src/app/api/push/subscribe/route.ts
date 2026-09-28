import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/push/admin-client';

/**
 * GET /api/push/subscribe
 *
 * Returns the current user's registered push-subscription endpoints so the
 * client can verify that a browser PushSubscription actually has a matching
 * server row (RLS-scoped read of the caller's OWN rows — no service-role
 * key, no other users' data). Endpoints are opaque push-service URLs and
 * are not secret, but they are not echoed back in full to logs.
 *
 * Used by the client to distinguish "browser thinks it's subscribed but the
 * server row is missing/stale" from a genuinely working subscription.
 */
export async function GET() {
  try {
    const guard = await requireAuthenticatedUser();
    if (!guard.ok) {
      return NextResponse.json(guard.body, { status: guard.status });
    }
    const { supabase, userId } = guard;

    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('endpoint')
      .eq('user_id', userId);

    if (error) {
      console.error('[push] list subscriptions failed:', error.message);
      return NextResponse.json(
        { error: 'Could not read subscriptions.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      endpoints: (data ?? []).map((r: { endpoint: string }) => r.endpoint),
    });
  } catch (err) {
    console.error('[push] list subscriptions error:', err);
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
  }
}

/**
 * POST /api/push/subscribe
 *
 * Body: a serialized PushSubscription:
 *   { endpoint, keys: { p256dh, auth } }
 *
 * Upserts the caller's push subscription for their account so the
 * server can send them Web Push notifications on new inbound messages.
 * Idempotent — re-subscribing the same endpoint refreshes the row.
 */
export async function POST(request: Request) {
  try {
    const guard = await requireAuthenticatedUser();
    if (!guard.ok) {
      return NextResponse.json(guard.body, { status: guard.status });
    }
    const { supabase, userId } = guard;

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', userId)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => null);
    const endpoint = body?.endpoint as string | undefined;
    const p256dh = body?.keys?.p256dh as string | undefined;
    const auth = body?.keys?.auth as string | undefined;
    const vapidPublicKey = body?.vapidPublicKey as string | undefined;

    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json(
        { error: 'A valid push subscription is required.' },
        { status: 400 },
      );
    }

    // VAPID parity guard: the client inlines NEXT_PUBLIC_VAPID_PUBLIC_KEY
    // at build time; the server signs with its runtime key pair. If the two
    // diverge (env changed without a rebuild), every push this subscription
    // would receive would be rejected by the push service — reject the
    // subscription up front with an actionable message instead of saving a
    // row that can never deliver. The public key is not secret, so sending
    // it back for comparison is safe; the private key never leaves the
    // server.
    const serverVapidPublic =
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null;
    if (
      serverVapidPublic &&
      typeof vapidPublicKey === 'string' &&
      vapidPublicKey.trim() &&
      vapidPublicKey.trim() !== serverVapidPublic
    ) {
      console.error('[push] VAPID public-key mismatch between client and server');
      return NextResponse.json(
        {
          error:
            'The app was built with a different VAPID key than the server is configured with. Rebuild/deploy the app so the client and server share the same VAPID keys.',
        },
        { status: 400 },
      );
    }

    const userAgent = request.headers.get('user-agent');

    // Use the admin client for the upsert so it can update a row that
    // belongs to a different user (when switching accounts on the same
    // device). The user-scoped client lacks an UPDATE RLS policy, so
    // the onConflict update would silently fail and leave the old
    // user_id in place — causing push notifications to go to the
    // wrong person.
    const { error } = await supabaseAdmin().from('push_subscriptions').upsert(
      {
        account_id: accountId,
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: userAgent,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    );

    if (error) {
      console.error('[push] subscribe failed:', error.message);
      return NextResponse.json(
        { error: 'Could not save subscription.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[push] subscribe error:', err);
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
