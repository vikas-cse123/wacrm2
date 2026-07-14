import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/push/admin-client';

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
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
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

    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json(
        { error: 'A valid push subscription is required.' },
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
        user_id: user.id,
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
