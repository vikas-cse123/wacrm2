import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * POST /api/push/unsubscribe
 *
 * Body: { endpoint }
 *
 * Removes the caller's push subscription for this device. RLS restricts
 * the delete to the caller's own rows, so a missing/foreign endpoint is
 * simply a no-op.
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

    const body = await request.json().catch(() => null);
    const endpoint = body?.endpoint as string | undefined;

    if (!endpoint) {
      return NextResponse.json(
        { error: 'endpoint is required' },
        { status: 400 },
      );
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', user.id);

    if (error) {
      console.error('[push] unsubscribe failed:', error.message);
      return NextResponse.json(
        { error: 'Could not remove subscription.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err);
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
